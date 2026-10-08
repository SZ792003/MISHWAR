import {
  FinancialTransaction,
  Payment,
  PaymentMethodCode,
  PaymentStatusCode,
  Ride,
  UserRole
} from '../../../packages/shared_types/src';
import { AuditActor, auditService } from '../auditService';
import { getFirebaseAdmin } from '../auth';
import { backendConfig, isStrictBackend } from '../config';
import { calculateCommission, subtractMoney, trustedCurrency, trustedFareAmount } from './money';
import { PaymentDomainError } from './paymentErrors';
import { paymentProvider, ProviderWebhookResult } from './paymentProvider';

type FirebaseContext = NonNullable<Awaited<ReturnType<typeof getFirebaseAdmin>>>;
type FirestoreDb = ReturnType<FirebaseContext['admin']['firestore']>;
type FirestoreTransaction = {
  get: (ref: unknown) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (ref: unknown, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  update: (ref: unknown, data: Record<string, unknown>) => void;
};

type AuthenticatedPaymentUser = {
  uid: string;
  role: UserRole;
  authSource: 'firebase' | 'demo';
};

type PaymentResponse = {
  payment: Payment;
  financialTransactions: FinancialTransaction[];
  providerAction?: Record<string, unknown>;
};

const memoryPayments = new Map<string, Payment>();
const memoryFinancialTransactions = new Map<string, FinancialTransaction>();
const memoryIdempotency = new Map<string, PaymentResponse>();
const memoryWallets = new Map<string, number>([
  ['flutter_demo_customer', 15000],
  ['cust_01', 8500],
  ['cust_02', 4200],
  ['cust_03', 12000]
]);
const memoryWebhookEvents = new Set<string>();

const nowIso = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

const firestoreServerTimestamp = (firebaseAdmin: FirebaseContext): unknown => {
  const firestoreNamespace = firebaseAdmin.admin.firestore as unknown as {
    FieldValue?: { serverTimestamp: () => unknown };
  };
  return firestoreNamespace.FieldValue?.serverTimestamp() || nowIso();
};

const idempotencyDocId = (scope: string, userId: string, key: string): string => {
  return Buffer.from(`${scope}:${userId}:${key}`).toString('base64url');
};

const runFirestoreTransaction = async <T>(
  firebaseAdmin: FirebaseContext,
  callback: (tx: FirestoreTransaction, db: FirestoreDb) => Promise<T>
): Promise<T> => {
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const runTransaction = (db as unknown as { runTransaction: <R>(cb: (tx: FirestoreTransaction) => Promise<R>) => Promise<R> }).runTransaction;
  return runTransaction.bind(db)((tx) => callback(tx, db));
};

const normalizePaymentMethod = (value: unknown): PaymentMethodCode => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cash' || normalized === 'cash_payment' || normalized === 'CASH'.toLowerCase()) return 'cash';
  if (normalized === 'wallet') return 'wallet';
  if (normalized === 'digital_provider' || normalized === 'card' || normalized === 'digital') return 'digital_provider';
  throw new PaymentDomainError('INVALID_PAYMENT_METHOD', 'Unsupported payment method', 400);
};

const paymentStatusForRide = (status: PaymentStatusCode): 'PENDING' | 'PROCESSING' | 'AUTHORIZED' | 'PAID' | 'FAILED' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' => {
  const map = {
    pending: 'PENDING',
    processing: 'PROCESSING',
    authorized: 'AUTHORIZED',
    paid: 'PAID',
    failed: 'FAILED',
    cancelled: 'CANCELLED',
    partially_refunded: 'PARTIALLY_REFUNDED',
    refunded: 'REFUNDED'
  } as const;
  return map[status];
};

const assertProductionPaymentActor = (user: AuthenticatedPaymentUser): void => {
  if (isStrictBackend() && user.authSource !== 'firebase') {
    throw new PaymentDomainError('PRODUCTION_PAYMENT_REQUIRES_FIREBASE_AUTH', 'Production payments require Firebase identity', 401);
  }
};

const assertCustomerCanPayRide = (user: AuthenticatedPaymentUser, ride: Ride): void => {
  if (user.role !== 'CUSTOMER') throw new PaymentDomainError('PAYMENT_FORBIDDEN', 'Only the customer can create ride payment', 403);
  if (ride.customerId !== user.uid && ride.passengerId !== user.uid) {
    throw new PaymentDomainError('PAYMENT_FORBIDDEN', 'Customer does not own this ride', 403);
  }
};

const assertDriverCanConfirmCash = (user: AuthenticatedPaymentUser, ride: Ride): void => {
  if (user.role !== 'DRIVER' || ride.driverId !== user.uid) {
    throw new PaymentDomainError('CASH_CONFIRM_FORBIDDEN', 'Only the assigned driver can confirm cash receipt', 403);
  }
};

const assertRideCompleted = (ride: Ride): void => {
  if (ride.status !== 'TRIP_COMPLETED') {
    throw new PaymentDomainError('RIDE_NOT_COMPLETED', 'Ride must be completed before collecting payment', 409);
  }
};

const buildPayment = (params: {
  ride: Ride;
  method: PaymentMethodCode;
  status: PaymentStatusCode;
  idempotencyKey: string;
  requestId?: string;
  provider?: string;
  providerTransactionId?: string;
  providerReference?: string;
  metadata?: Record<string, unknown>;
}): Payment => {
  const amount = trustedFareAmount(params.ride.fare);
  const now = nowIso();
  return {
    id: `pay_${params.ride.id}_${params.method}`,
    rideId: params.ride.id,
    customerId: params.ride.customerId,
    driverId: params.ride.driverId,
    amount,
    currency: trustedCurrency(params.ride.fare),
    method: params.method,
    status: params.status,
    provider: params.provider,
    providerTransactionId: params.providerTransactionId,
    providerReference: params.providerReference,
    idempotencyKey: params.idempotencyKey,
    requestId: params.requestId,
    createdAt: now,
    updatedAt: now,
    completedAt: params.status === 'paid' ? now : undefined,
    metadata: params.metadata
  };
};

const ledgerEntriesForCompletedPayment = (
  payment: Payment,
  ride: Ride,
  idempotencyKey: string,
  requestId?: string
): FinancialTransaction[] => {
  const { platformCommission, driverNetEarning } = calculateCommission(
    payment.amount,
    ride.fare?.grossFare ? payment.amount === ride.fare.grossFare ? ride.fare.platformCommission / ride.fare.grossFare : undefined : undefined
  );
  const now = nowIso();
  return [
    {
      id: id('fin'),
      type: payment.method === 'wallet' ? 'wallet_debit' : 'ride_payment',
      amount: payment.amount,
      currency: payment.currency,
      rideId: ride.id,
      paymentId: payment.id,
      customerId: ride.customerId,
      driverId: ride.driverId,
      status: 'completed',
      idempotencyKey,
      requestId,
      createdAt: now,
      completedAt: now,
      source: payment.method === 'cash' ? 'customer_cash' : `customer:${ride.customerId}`,
      destination: payment.method === 'cash' ? `driver:${ride.driverId}` : 'mishwar_platform',
      metadata: { paymentMethod: payment.method }
    },
    {
      id: id('fin'),
      type: 'platform_commission',
      amount: platformCommission,
      currency: payment.currency,
      rideId: ride.id,
      paymentId: payment.id,
      customerId: ride.customerId,
      driverId: ride.driverId,
      status: 'completed',
      idempotencyKey: `${idempotencyKey}:commission`,
      requestId,
      createdAt: now,
      completedAt: now,
      source: payment.method === 'cash' ? `driver:${ride.driverId}` : 'mishwar_platform',
      destination: 'mishwar_platform'
    },
    {
      id: id('fin'),
      type: 'driver_earning',
      amount: driverNetEarning,
      currency: payment.currency,
      rideId: ride.id,
      paymentId: payment.id,
      customerId: ride.customerId,
      driverId: ride.driverId,
      status: 'completed',
      idempotencyKey: `${idempotencyKey}:driver_earning`,
      requestId,
      createdAt: now,
      completedAt: now,
      source: payment.method === 'cash' ? 'customer_cash' : 'mishwar_platform',
      destination: `driver:${ride.driverId}`
    }
  ];
};

const completePaymentInMemory = (payment: Payment, ride: Ride, userId: string, idempotencyKey: string, requestId?: string): PaymentResponse => {
  if (payment.method === 'wallet') {
    const balance = memoryWallets.get(userId) ?? 0;
    let nextBalance: number;
    try {
      nextBalance = subtractMoney(balance, payment.amount);
    } catch {
      const failed: Payment = { ...payment, status: 'failed', updatedAt: nowIso() };
      const failedTransaction: FinancialTransaction = {
        id: id('fin'),
        type: 'wallet_debit',
        amount: payment.amount,
        currency: payment.currency,
        rideId: ride.id,
        paymentId: payment.id,
        customerId: ride.customerId,
        driverId: ride.driverId,
        status: 'failed',
        idempotencyKey,
        requestId,
        createdAt: nowIso(),
        source: `customer:${ride.customerId}`,
        destination: 'mishwar_platform',
        metadata: { reason: 'INSUFFICIENT_FUNDS', balanceBefore: balance }
      };
      memoryPayments.set(failed.id, failed);
      memoryFinancialTransactions.set(failedTransaction.id, failedTransaction);
      const response = { payment: failed, financialTransactions: [failedTransaction] };
      memoryIdempotency.set(idempotencyKey, response);
      return response;
    }
    memoryWallets.set(userId, nextBalance);
  }
  const completed = { ...payment, status: 'paid' as PaymentStatusCode, completedAt: nowIso(), updatedAt: nowIso() };
  const transactions = ledgerEntriesForCompletedPayment(completed, ride, idempotencyKey, requestId);
  memoryPayments.set(completed.id, completed);
  transactions.forEach((entry) => memoryFinancialTransactions.set(entry.id, entry));
  const response = { payment: completed, financialTransactions: transactions };
  memoryIdempotency.set(idempotencyKey, response);
  return response;
};

export class PaymentService {
  async createRidePayment(params: {
    user: AuthenticatedPaymentUser;
    rideId: string;
    method: unknown;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
    demoRide?: Ride | null;
  }): Promise<PaymentResponse> {
    assertProductionPaymentActor(params.user);
    const method = normalizePaymentMethod(params.method);
    if (method === 'cash') {
      throw new PaymentDomainError('CASH_REQUIRES_DRIVER_CONFIRMATION', 'Cash payment must be confirmed by the assigned driver', 409);
    }
    if (params.usePersistentStore) return this.createPersistentPayment({ ...params, method });
    return this.createMemoryPayment({ ...params, method });
  }

  async confirmCashPayment(params: {
    user: AuthenticatedPaymentUser;
    rideId: string;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
    demoRide?: Ride | null;
  }): Promise<PaymentResponse> {
    assertProductionPaymentActor(params.user);
    if (params.usePersistentStore) return this.confirmPersistentCash(params);
    return this.confirmMemoryCash(params);
  }

  async getPaymentForRide(params: {
    user: AuthenticatedPaymentUser;
    rideId: string;
    usePersistentStore: boolean;
    demoRide?: Ride | null;
  }): Promise<Payment | null> {
    if (params.usePersistentStore) {
      const firebaseAdmin = await this.adminContext();
      const db = firebaseAdmin.admin.firestore(firebaseAdmin.app) as unknown as {
        collection: (path: string) => {
          where: (field: string, op: string, value: unknown) => {
            limit: (count: number) => { get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> };
          };
        };
      };
      const snap = await db.collection('payments').where('rideId', '==', params.rideId).limit(1).get();
      const payment = snap.docs[0]?.data() as unknown as Payment | undefined;
      if (!payment) return null;
      if (![payment.customerId, payment.driverId].includes(params.user.uid) && !['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(params.user.role)) {
        throw new PaymentDomainError('UNAUTHORIZED_PAYMENT_ACCESS', 'Unauthorized payment access', 403);
      }
      return payment;
    }
    const payment = [...memoryPayments.values()].find((item) => item.rideId === params.rideId) || null;
    if (!payment) return null;
    if (![payment.customerId, payment.driverId].includes(params.user.uid) && !['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(params.user.role)) {
      throw new PaymentDomainError('UNAUTHORIZED_PAYMENT_ACCESS', 'Unauthorized payment access', 403);
    }
    return payment;
  }

  async getPaymentById(params: {
    user: AuthenticatedPaymentUser;
    paymentId: string;
    usePersistentStore: boolean;
  }): Promise<Payment | null> {
    if (params.usePersistentStore) {
      const firebaseAdmin = await this.adminContext();
      const snap = await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`payments/${params.paymentId}`).get();
      if (!snap.exists) return null;
      const payment = snap.data() as unknown as Payment;
      if (![payment.customerId, payment.driverId].includes(params.user.uid) && !['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(params.user.role)) {
        throw new PaymentDomainError('UNAUTHORIZED_PAYMENT_ACCESS', 'Unauthorized payment access', 403);
      }
      return payment;
    }
    const payment = memoryPayments.get(params.paymentId) || null;
    if (!payment) return null;
    if (![payment.customerId, payment.driverId].includes(params.user.uid) && !['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(params.user.role)) {
      throw new PaymentDomainError('UNAUTHORIZED_PAYMENT_ACCESS', 'Unauthorized payment access', 403);
    }
    return payment;
  }

  async processWebhook(params: {
    provider: string;
    headers: Record<string, unknown>;
    body: unknown;
    requestId?: string;
    usePersistentStore: boolean;
  }): Promise<{ event: ProviderWebhookResult; payment?: Payment }> {
    const verified = await paymentProvider.verifyWebhookSignature(params.headers, params.body);
    if (!verified) throw new PaymentDomainError('INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature', 401);
    const event = await paymentProvider.processWebhook(params.headers, params.body);
    if (params.usePersistentStore) {
      const firebaseAdmin = await this.adminContext();
      return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
        const eventRef = db.doc(`paymentWebhookEvents/${event.providerEventId}`);
        const eventSnap = await tx.get(eventRef);
        if (eventSnap.exists) throw new PaymentDomainError('DUPLICATE_WEBHOOK', 'Duplicate webhook', 200);
        tx.set(eventRef, { ...event, provider: params.provider, requestId: params.requestId, createdAt: nowIso() });
        auditService.logInTransaction(tx, db, {
          actorUid: 'provider',
          actorRole: 'SYSTEM',
          eventType: 'PROVIDER_WEBHOOK_VERIFIED',
          targetType: 'PAYMENT',
          targetId: event.providerTransactionId || event.providerReference || event.providerEventId,
          requestId: params.requestId,
          source: 'PAYMENT_BACKEND',
          metadata: { provider: params.provider, status: event.status }
        }, firestoreServerTimestamp(firebaseAdmin));
        return { event };
      });
    }
    if (memoryWebhookEvents.has(event.providerEventId)) {
      throw new PaymentDomainError('DUPLICATE_WEBHOOK', 'Duplicate webhook', 200);
    }
    memoryWebhookEvents.add(event.providerEventId);
    return { event };
  }

  private async createPersistentPayment(params: {
    user: AuthenticatedPaymentUser;
    rideId: string;
    method: PaymentMethodCode;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
  }): Promise<PaymentResponse> {
    const firebaseAdmin = await this.adminContext();
    if (params.method === 'digital_provider') {
      return this.createPersistentDigitalPayment(params, firebaseAdmin);
    }
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('payment-create', params.user.uid, params.idempotencyKey)}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) return idemSnap.data()?.response as PaymentResponse;

      const ride = await this.readRideInTx(tx, db, params.rideId);
      assertCustomerCanPayRide(params.user, ride);
      assertRideCompleted(ride);
      const existingPayment = await this.readExistingRidePaymentInTx(tx, db, ride.id);
      if (existingPayment?.status === 'paid' || existingPayment?.status === 'processing' || existingPayment?.status === 'authorized') {
        return { payment: existingPayment, financialTransactions: [] };
      }

      const payment = buildPayment({
        ride,
        method: params.method,
        status: params.method === 'wallet' ? 'paid' : 'processing',
        idempotencyKey: params.idempotencyKey,
        requestId: params.requestId
      });

      let response: PaymentResponse;
      if (params.method === 'wallet') {
        response = await this.applyWalletPaymentInTx(tx, db, firebaseAdmin, ride, payment, params.user.uid, params.idempotencyKey, params.requestId);
      } else {
        throw new PaymentDomainError('INVALID_PAYMENT_METHOD', 'Unsupported payment method', 400);
      }
      tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'payment-create', response, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      this.auditPaymentInTx(
        tx,
        db,
        firebaseAdmin,
        params.actor,
        response.payment,
        response.financialTransactions,
        response.payment.status === 'failed' ? 'PAYMENT_FAILED' : 'PAYMENT_COMPLETED'
      );
      return response;
    });
  }

  private async createPersistentDigitalPayment(
    params: {
      user: AuthenticatedPaymentUser;
      rideId: string;
      method: PaymentMethodCode;
      idempotencyKey: string;
      requestId?: string;
      actor: AuditActor;
    },
    firebaseAdmin: FirebaseContext
  ): Promise<PaymentResponse> {
    const ride = await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`rides/${params.rideId}`).get();
    if (!ride.exists) throw new PaymentDomainError('RIDE_NOT_FOUND', 'Ride not found', 404);
    const rideData = ride.data() as unknown as Ride;
    assertCustomerCanPayRide(params.user, rideData);
    assertRideCompleted(rideData);
    const existingPaymentSnap = await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`payments/pay_${rideData.id}_digital_provider`).get();
    if (existingPaymentSnap.exists) {
      return { payment: existingPaymentSnap.data() as unknown as Payment, financialTransactions: [] };
    }

    const payment = buildPayment({
      ride: rideData,
      method: 'digital_provider',
      status: 'processing',
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      provider: backendConfig.paymentProvider || undefined
    });
    const providerResult = await paymentProvider.createPayment({
      paymentId: payment.id,
      rideId: rideData.id,
      amount: payment.amount,
      currency: payment.currency,
      customerId: params.user.uid,
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId
    });
    const storedPayment: Payment = {
      ...payment,
      status: providerResult.status,
      provider: providerResult.provider,
      providerTransactionId: providerResult.providerTransactionId,
      providerReference: providerResult.providerReference,
      metadata: providerResult.metadata
    };
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('payment-create', params.user.uid, params.idempotencyKey)}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) return idemSnap.data()?.response as PaymentResponse;
      const response = { payment: storedPayment, financialTransactions: [], providerAction: providerResult as unknown as Record<string, unknown> };
      tx.set(db.doc(`payments/${storedPayment.id}`), { ...storedPayment, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'payment-create', response, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      auditService.logInTransaction(tx, db, {
        ...params.actor,
        eventType: 'PAYMENT_PROCESSING',
        targetType: 'PAYMENT',
        targetId: storedPayment.id,
        rideId: storedPayment.rideId,
        source: 'PAYMENT_BACKEND',
        metadata: { amount: storedPayment.amount, currency: storedPayment.currency, provider: storedPayment.provider }
      }, firestoreServerTimestamp(firebaseAdmin));
      return response;
    });
  }

  private async confirmPersistentCash(params: {
    user: AuthenticatedPaymentUser;
    rideId: string;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
  }): Promise<PaymentResponse> {
    const firebaseAdmin = await this.adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('cash-confirm', params.user.uid, params.idempotencyKey)}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) return idemSnap.data()?.response as PaymentResponse;
      const ride = await this.readRideInTx(tx, db, params.rideId);
      assertDriverCanConfirmCash(params.user, ride);
      assertRideCompleted(ride);
      const existingPayment = await this.readExistingRidePaymentInTx(tx, db, ride.id);
      if (existingPayment?.status === 'paid') return { payment: existingPayment, financialTransactions: [] };
      const payment = buildPayment({
        ride,
        method: 'cash',
        status: 'paid',
        idempotencyKey: params.idempotencyKey,
        requestId: params.requestId
      });
      const transactions = ledgerEntriesForCompletedPayment(payment, ride, params.idempotencyKey, params.requestId);
      const response = { payment, financialTransactions: transactions };
      this.writeCompletedPaymentInTx(tx, db, firebaseAdmin, ride, payment, transactions);
      tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'cash-confirm', response, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      this.auditPaymentInTx(tx, db, firebaseAdmin, params.actor, payment, transactions, 'CASH_CONFIRMED');
      return response;
    });
  }

  private createMemoryPayment(params: {
    user: AuthenticatedPaymentUser;
    rideId: string;
    method: PaymentMethodCode;
    idempotencyKey: string;
    requestId?: string;
    demoRide?: Ride | null;
  }): PaymentResponse {
    if (memoryIdempotency.has(params.idempotencyKey)) return memoryIdempotency.get(params.idempotencyKey)!;
    const ride = params.demoRide;
    if (!ride) throw new PaymentDomainError('RIDE_NOT_FOUND', 'Ride not found', 404);
    assertCustomerCanPayRide(params.user, ride);
    assertRideCompleted(ride);
    const existingPayment = [...memoryPayments.values()].find((item) => item.rideId === ride.id);
    if (existingPayment?.status === 'paid' || existingPayment?.status === 'processing' || existingPayment?.status === 'authorized') {
      return { payment: existingPayment, financialTransactions: [] };
    }
    if (params.method === 'digital_provider') {
      throw new PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured', 503);
    }
    const payment = buildPayment({
      ride,
      method: params.method,
      status: params.method === 'wallet' ? 'paid' : 'processing',
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId
    });
    if (params.method !== 'wallet') throw new PaymentDomainError('INVALID_PAYMENT_METHOD', 'Unsupported payment method', 400);
    return completePaymentInMemory(payment, ride, params.user.uid, params.idempotencyKey, params.requestId);
  }

  private confirmMemoryCash(params: {
    user: AuthenticatedPaymentUser;
    rideId: string;
    idempotencyKey: string;
    requestId?: string;
    demoRide?: Ride | null;
  }): PaymentResponse {
    if (memoryIdempotency.has(params.idempotencyKey)) return memoryIdempotency.get(params.idempotencyKey)!;
    const ride = params.demoRide;
    if (!ride) throw new PaymentDomainError('RIDE_NOT_FOUND', 'Ride not found', 404);
    assertDriverCanConfirmCash(params.user, ride);
    assertRideCompleted(ride);
    const existingPayment = [...memoryPayments.values()].find((item) => item.rideId === ride.id);
    if (existingPayment?.status === 'paid') return { payment: existingPayment, financialTransactions: [] };
    const payment = buildPayment({
      ride,
      method: 'cash',
      status: 'paid',
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId
    });
    return completePaymentInMemory(payment, ride, params.user.uid, params.idempotencyKey, params.requestId);
  }

  private async adminContext(): Promise<FirebaseContext> {
    const firebaseAdmin = await getFirebaseAdmin();
    if (!firebaseAdmin) throw new PaymentDomainError('DATABASE_UNAVAILABLE', 'Persistent database is unavailable', 503);
    return firebaseAdmin;
  }

  private async readRideInTx(tx: FirestoreTransaction, db: FirestoreDb, rideId: string): Promise<Ride> {
    const rideRef = db.doc(`rides/${rideId}`);
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) throw new PaymentDomainError('RIDE_NOT_FOUND', 'Ride not found', 404);
    return rideSnap.data() as unknown as Ride;
  }

  private async readExistingRidePaymentInTx(tx: FirestoreTransaction, db: FirestoreDb, rideId: string): Promise<Payment | null> {
    for (const method of ['cash', 'wallet', 'digital_provider'] as const) {
      const snap = await tx.get(db.doc(`payments/pay_${rideId}_${method}`));
      if (snap.exists) return snap.data() as unknown as Payment;
    }
    return null;
  }

  private async applyWalletPaymentInTx(
    tx: FirestoreTransaction,
    db: FirestoreDb,
    firebaseAdmin: FirebaseContext,
    ride: Ride,
    payment: Payment,
    userId: string,
    idempotencyKey: string,
    requestId?: string
  ): Promise<PaymentResponse> {
    const walletRef = db.doc(`wallets/${userId}`);
    const walletSnap = await tx.get(walletRef);
    const currentBalance = Number(walletSnap.data()?.balance ?? 0);
    let nextBalance: number;
    try {
      nextBalance = subtractMoney(currentBalance, payment.amount);
    } catch {
      const failedPayment: Payment = { ...payment, status: 'failed', updatedAt: nowIso() };
      const failedTransaction: FinancialTransaction = {
        id: id('fin'),
        type: 'wallet_debit',
        amount: payment.amount,
        currency: payment.currency,
        rideId: ride.id,
        paymentId: failedPayment.id,
        customerId: ride.customerId,
        driverId: ride.driverId,
        status: 'failed',
        idempotencyKey,
        requestId,
        createdAt: nowIso(),
        source: `customer:${ride.customerId}`,
        destination: 'mishwar_platform',
        metadata: { reason: 'INSUFFICIENT_FUNDS', balanceBefore: currentBalance }
      };
      tx.set(db.doc(`payments/${failedPayment.id}`), { ...failedPayment, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      tx.set(db.doc(`financialTransactions/${failedTransaction.id}`), { ...failedTransaction, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      return { payment: failedPayment, financialTransactions: [failedTransaction] };
    }
    const transactions = ledgerEntriesForCompletedPayment(payment, ride, idempotencyKey, requestId);
    const response = { payment, financialTransactions: transactions };
    tx.set(walletRef, {
      userId,
      balance: nextBalance,
      updatedAt: nowIso(),
      serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
    }, { merge: true });
    this.writeCompletedPaymentInTx(tx, db, firebaseAdmin, ride, payment, transactions);
    return response;
  }

  private writeCompletedPaymentInTx(
    tx: FirestoreTransaction,
    db: FirestoreDb,
    firebaseAdmin: FirebaseContext,
    ride: Ride,
    payment: Payment,
    transactions: FinancialTransaction[]
  ): void {
    tx.set(db.doc(`payments/${payment.id}`), { ...payment, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
    for (const transaction of transactions) {
      tx.set(db.doc(`financialTransactions/${transaction.id}`), { ...transaction, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      if (transaction.type === 'wallet_debit') {
        tx.set(db.doc(`walletTransactions/${transaction.id}`), {
          transactionId: transaction.id,
          userId: transaction.customerId,
          type: 'RIDE_PAYMENT',
          amount: transaction.amount,
          balanceBefore: null,
          balanceAfter: null,
          status: 'SUCCESS',
          createdAt: transaction.createdAt,
          referenceId: transaction.rideId,
          idempotencyKey: transaction.idempotencyKey,
          serverCreatedAt: firestoreServerTimestamp(firebaseAdmin)
        });
      }
    }
    tx.update(db.doc(`rides/${ride.id}`), {
      paymentStatus: paymentStatusForRide(payment.status),
      updatedAt: nowIso(),
      serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
    });
  }

  private auditPaymentInTx(
    tx: FirestoreTransaction,
    db: FirestoreDb,
    firebaseAdmin: FirebaseContext,
    actor: AuditActor,
    payment: Payment,
    transactions: FinancialTransaction[],
    firstEvent: 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED' | 'CASH_CONFIRMED' = 'PAYMENT_COMPLETED'
  ): void {
    auditService.logInTransaction(tx, db, {
      ...actor,
      eventType: firstEvent,
      targetType: 'PAYMENT',
      targetId: payment.id,
      rideId: payment.rideId,
      source: 'PAYMENT_BACKEND',
      metadata: {
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        status: payment.status,
        requestId: payment.requestId
      }
    }, firestoreServerTimestamp(firebaseAdmin));
    for (const transaction of transactions) {
      auditService.logInTransaction(tx, db, {
        ...actor,
        eventType: transaction.type === 'driver_earning'
          ? 'DRIVER_EARNING_CREATED'
          : transaction.type === 'platform_commission'
            ? 'PLATFORM_COMMISSION_CREATED'
            : transaction.type === 'wallet_debit'
              ? 'WALLET_DEBIT'
              : 'PAYMENT_RECORDED',
        targetType: transaction.type === 'wallet_debit' ? 'WALLET' : 'PAYMENT',
        targetId: transaction.id,
        rideId: payment.rideId,
        source: 'PAYMENT_BACKEND',
        metadata: {
          paymentId: payment.id,
          transactionId: transaction.id,
          amount: transaction.amount,
          currency: transaction.currency,
          type: transaction.type,
          requestId: transaction.requestId
        }
      }, firestoreServerTimestamp(firebaseAdmin));
    }
  }
}

export const paymentService = new PaymentService();
