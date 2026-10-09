import {
  DriverFinanceSummary,
  DriverPayout,
  FinancialAdjustment,
  FinancialRiskFlag,
  FinancialTransaction,
  Payment,
  PayoutMethod,
  PayoutStatus,
  ReconciliationIssue,
  Refund,
  RefundReason,
  SettlementPeriod,
  SettlementReport,
  UserRole
} from '../../../packages/shared_types/src';
import { AuditActor, auditService } from '../auditService';
import { getFirebaseAdmin } from '../auth';
import { backendConfig, isStrictBackend } from '../config';
import { addMoney, assertMoneyAmount, subtractMoney, trustedCurrency } from './money';
import { PaymentDomainError } from './paymentErrors';
import { paymentProvider } from './paymentProvider';

type FirebaseContext = NonNullable<Awaited<ReturnType<typeof getFirebaseAdmin>>>;
type FirestoreDb = ReturnType<FirebaseContext['admin']['firestore']>;
type FirestoreTransaction = {
  get: (ref: unknown) => Promise<{ exists: boolean; id?: string; data: () => Record<string, unknown> | undefined }>;
  set: (ref: unknown, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  update: (ref: unknown, data: Record<string, unknown>) => void;
};

type AuthenticatedFinanceUser = {
  uid: string;
  role: UserRole;
  authSource: 'firebase' | 'demo';
  accountStatus?: 'active' | 'suspended' | 'blocked';
};

type QueryDoc = { id: string; data: () => Record<string, unknown> };
type QueryLike = { get: () => Promise<{ docs: QueryDoc[] }> };

const memoryTransactions = new Map<string, FinancialTransaction>();
const memoryPayments = new Map<string, Payment>();
const memoryPayouts = new Map<string, DriverPayout>();
const memoryRefunds = new Map<string, Refund>();
const memoryIssues = new Map<string, ReconciliationIssue>();
const memorySettlements = new Map<string, SettlementReport>();
const memoryRiskFlags = new Map<string, FinancialRiskFlag>();
const memoryAdjustments = new Map<string, FinancialAdjustment>();
const memoryWallets = new Map<string, number>();
const memoryIdempotency = new Map<string, unknown>();

const nowIso = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
const adminRoles: UserRole[] = ['ADMIN', 'SUPER_ADMIN', 'FINANCE', 'OPS_MANAGER'];

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

const assertProductionActor = (user: AuthenticatedFinanceUser): void => {
  if (isStrictBackend() && user.authSource !== 'firebase') {
    throw new PaymentDomainError('PRODUCTION_FINANCE_REQUIRES_FIREBASE_AUTH', 'Production finance operations require Firebase identity', 401);
  }
};

const assertAdmin = (user: AuthenticatedFinanceUser): void => {
  if (!adminRoles.includes(user.role)) throw new PaymentDomainError('ADMIN_FINANCE_FORBIDDEN', 'Admin finance access is required', 403);
};

const assertDriver = (user: AuthenticatedFinanceUser): void => {
  if (user.role !== 'DRIVER') throw new PaymentDomainError('DRIVER_FINANCE_FORBIDDEN', 'Driver role is required', 403);
  if (user.accountStatus === 'suspended') throw new PaymentDomainError('DRIVER_SUSPENDED', 'Suspended drivers cannot request payouts', 403);
  if (user.accountStatus === 'blocked') throw new PaymentDomainError('DRIVER_BLOCKED', 'Blocked drivers cannot request payouts', 403);
};

const normalizePayoutMethod = (value: unknown): PayoutMethod => {
  const method = String(value || 'cash_office').trim().toLowerCase();
  if (['cash_office', 'bank', 'wallet', 'digital_provider'].includes(method)) return method as PayoutMethod;
  throw new PaymentDomainError('INVALID_PAYOUT_METHOD', 'Unsupported payout method', 400);
};

const normalizeRefundReason = (value: unknown): RefundReason => {
  const reason = String(value || 'other').trim().toLowerCase();
  if (['ride_cancelled', 'duplicate_charge', 'service_issue', 'payment_error', 'admin_adjustment', 'other'].includes(reason)) {
    return reason as RefundReason;
  }
  return 'other';
};

const paymentRefundedAmount = (payment: Payment): number => Number(payment.refundedAmount || payment.metadata?.refundedAmount || 0);
const remainingRefundable = (payment: Payment): number => payment.amount - paymentRefundedAmount(payment);

const txAmountByType = (transactions: FinancialTransaction[], type: string): number => {
  return transactions.filter((item) => item.type === type && item.status === 'completed').reduce((sum, item) => sum + item.amount, 0);
};

const cashCommissionDebt = (transactions: FinancialTransaction[], driverId: string): number => {
  return transactions
    .filter((item) =>
      item.type === 'platform_commission' &&
      item.status === 'completed' &&
      item.driverId === driverId &&
      item.source === `driver:${driverId}`
    )
    .reduce((sum, item) => sum + item.amount, 0);
};

const commissionCollected = (transactions: FinancialTransaction[], driverId: string): number => {
  const nonCashCollected = transactions
    .filter((item) =>
      item.type === 'platform_commission' &&
      item.status === 'completed' &&
      item.driverId === driverId &&
      item.source !== `driver:${driverId}`
    )
    .reduce((sum, item) => sum + item.amount, 0);
  return nonCashCollected +
    txAmountByType(transactions, 'commission_settlement') +
    txAmountByType(transactions, 'commission_offset');
};

const financeSummaryFrom = (
  driverId: string,
  transactions: FinancialTransaction[],
  payouts: DriverPayout[]
): DriverFinanceSummary => {
  const currency = transactions.find((item) => item.currency)?.currency || 'YER';
  const ridePaymentKeys = new Set(
    transactions
      .filter((item) => ['ride_payment', 'wallet_debit'].includes(item.type) && item.status === 'completed' && item.rideId)
      .map((item) => item.rideId as string)
  );
  const totalRideGross = transactions
    .filter((item) => ['ride_payment', 'wallet_debit'].includes(item.type) && item.status === 'completed')
    .reduce((sum, item) => sum + item.amount, 0);
  const totalEarnings = txAmountByType(transactions, 'driver_earning');
  const totalPlatformCommission = txAmountByType(transactions, 'platform_commission');
  const totalCommissionCollected = commissionCollected(transactions, driverId);
  const outstandingCommissionDebt = Math.max(0, cashCommissionDebt(transactions, driverId) - txAmountByType(transactions, 'commission_settlement') - txAmountByType(transactions, 'commission_offset'));
  const totalPaidOut = payouts.filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.amount, 0);
  const reservedBalance = payouts
    .filter((item) => ['requested', 'approved', 'processing'].includes(item.status))
    .reduce((sum, item) => sum + item.amount, 0);
  const adjustments = transactions
    .filter((item) => item.type === 'adjustment' && item.status === 'completed')
    .reduce((sum, item) => sum + (item.destination === `driver:${driverId}` ? item.amount : -item.amount), 0);
  const pendingBalance = transactions
    .filter((item) => item.type === 'driver_earning' && item.status === 'pending')
    .reduce((sum, item) => sum + item.amount, 0);
  const availableBalance = Math.max(0, totalEarnings + adjustments - totalPaidOut - reservedBalance);
  return {
    driverId,
    currency,
    totalRideCount: ridePaymentKeys.size,
    totalRideGross,
    availableBalance,
    pendingBalance,
    reservedBalance,
    totalEarnings,
    totalPlatformCommission,
    totalCommissionCollected,
    outstandingCommissionDebt,
    totalPaidOut,
    recentTransactions: transactions.slice(0, 20),
    payouts: payouts.slice(0, 20),
    settlements: transactions.filter((item) => ['commission_settlement', 'commission_offset'].includes(item.type)).slice(0, 20)
  };
};

export class FinancialOperationsService {
  seedMemoryForTests(params: {
    payments?: Payment[];
    transactions?: FinancialTransaction[];
    payouts?: DriverPayout[];
    walletBalances?: Array<{ userId: string; balance: number }>;
  }): void {
    memoryTransactions.clear();
    memoryPayments.clear();
    memoryPayouts.clear();
    memoryRefunds.clear();
    memoryIssues.clear();
    memorySettlements.clear();
    memoryRiskFlags.clear();
    memoryAdjustments.clear();
    memoryWallets.clear();
    memoryIdempotency.clear();
    params.payments?.forEach((payment) => memoryPayments.set(payment.id, payment));
    params.transactions?.forEach((entry) => memoryTransactions.set(entry.id, entry));
    params.payouts?.forEach((payout) => memoryPayouts.set(payout.id, payout));
    params.walletBalances?.forEach((wallet) => memoryWallets.set(wallet.userId, wallet.balance));
  }

  memoryRiskFlagsForTests(): FinancialRiskFlag[] {
    return [...memoryRiskFlags.values()];
  }

  async getDriverFinance(params: {
    user: AuthenticatedFinanceUser;
    driverId?: string;
    usePersistentStore: boolean;
  }): Promise<DriverFinanceSummary> {
    const driverId = params.driverId || params.user.uid;
    if (params.user.role === 'DRIVER' && driverId !== params.user.uid) {
      throw new PaymentDomainError('DRIVER_FINANCE_FORBIDDEN', 'Drivers can only read their own finance summary', 403);
    }
    if (params.user.role !== 'DRIVER') assertAdmin(params.user);
    if (!params.usePersistentStore) {
      return financeSummaryFrom(
        driverId,
        [...memoryTransactions.values()].filter((item) => item.driverId === driverId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        [...memoryPayouts.values()].filter((item) => item.driverId === driverId).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      );
    }
    const firebaseAdmin = await this.adminContext();
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app) as unknown as {
      collection: (path: string) => {
        where: (field: string, op: string, value: unknown) => QueryLike & { orderBy?: (field: string, direction?: string) => QueryLike };
      };
    };
    const [txSnap, payoutSnap] = await Promise.all([
      db.collection('financialTransactions').where('driverId', '==', driverId).get(),
      db.collection('driverPayouts').where('driverId', '==', driverId).get()
    ]);
    return financeSummaryFrom(
      driverId,
      txSnap.docs.map((doc) => doc.data() as unknown as FinancialTransaction).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      payoutSnap.docs.map((doc) => doc.data() as unknown as DriverPayout).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    );
  }

  async requestPayout(params: {
    user: AuthenticatedFinanceUser;
    amount: number;
    method: unknown;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<DriverPayout> {
    assertProductionActor(params.user);
    assertDriver(params.user);
    const amount = assertMoneyAmount(params.amount);
    const method = normalizePayoutMethod(params.method);
    if (amount < backendConfig.minPayoutAmount) throw new PaymentDomainError('PAYOUT_BELOW_MINIMUM', 'Payout amount is below the configured minimum', 400);
    if (amount > backendConfig.maxPayoutAmount) throw new PaymentDomainError('PAYOUT_ABOVE_MAXIMUM', 'Payout amount exceeds the configured maximum', 400);
    if (!params.usePersistentStore) return this.requestMemoryPayout({ ...params, amount, method });

    const firebaseAdmin = await this.adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('payout-request', params.user.uid, params.idempotencyKey)}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) return idemSnap.data()?.response as DriverPayout;

      const finance = await this.getDriverFinance({ user: params.user, usePersistentStore: true });
      if (amount > finance.availableBalance) {
        await this.writeRiskFlagInTx(tx, db, firebaseAdmin, {
          type: 'rapid_payout_requests',
          severity: 'medium',
          driverId: params.user.uid,
          manualReviewRequired: true,
          metadata: { requestedAmount: amount, availableBalance: finance.availableBalance }
        });
        throw new PaymentDomainError('INSUFFICIENT_PAYOUT_BALANCE', 'Payout amount exceeds available balance', 409);
      }

      const payout = this.buildPayout(params.user.uid, amount, finance.currency, method, params.idempotencyKey, params.requestId);
      tx.set(db.doc(`driverPayouts/${payout.id}`), { ...payout, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'payout-request', response: payout, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'PAYOUT_REQUESTED', targetType: 'PAYOUT', targetId: payout.id, source: 'PAYMENT_BACKEND', metadata: { amount, currency: payout.currency, method } }, firestoreServerTimestamp(firebaseAdmin));
      return payout;
    });
  }

  async approvePayout(params: {
    user: AuthenticatedFinanceUser;
    payoutId: string;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<DriverPayout> {
    assertAdmin(params.user);
    if (!params.usePersistentStore) return this.updateMemoryPayout(params.payoutId, 'approved', params.user.uid);
    const firebaseAdmin = await this.adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const payoutRef = db.doc(`driverPayouts/${params.payoutId}`);
      const payoutSnap = await tx.get(payoutRef);
      if (!payoutSnap.exists) throw new PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
      const payout = payoutSnap.data() as unknown as DriverPayout;
      if (payout.status !== 'requested') return payout;
      const updated: DriverPayout = { ...payout, status: 'approved', approvedAt: nowIso(), approvedBy: params.user.uid };
      tx.set(payoutRef, { ...updated, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
      auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'PAYOUT_APPROVED', targetType: 'PAYOUT', targetId: updated.id, source: 'PAYMENT_BACKEND', metadata: { amount: updated.amount, currency: updated.currency } }, firestoreServerTimestamp(firebaseAdmin));
      return updated;
    });
  }

  async completePayout(params: {
    user: AuthenticatedFinanceUser;
    payoutId: string;
    providerReference?: string;
    failedReason?: string;
    markFailed?: boolean;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<DriverPayout> {
    assertAdmin(params.user);
    if (!params.usePersistentStore) return this.completeMemoryPayout(params);
    const firebaseAdmin = await this.adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const payoutRef = db.doc(`driverPayouts/${params.payoutId}`);
      const payoutSnap = await tx.get(payoutRef);
      if (!payoutSnap.exists) throw new PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
      const payout = payoutSnap.data() as unknown as DriverPayout;
      if (payout.status === 'paid' || payout.status === 'failed' || payout.status === 'cancelled') return payout;
      const status: PayoutStatus = params.markFailed ? 'failed' : 'paid';
      const updated: DriverPayout = {
        ...payout,
        status,
        providerReference: params.providerReference || payout.providerReference,
        payoutTransactionId: status === 'paid' ? payout.payoutTransactionId || id('fin') : payout.payoutTransactionId,
        paidAt: status === 'paid' ? nowIso() : payout.paidAt,
        failedAt: status === 'failed' ? nowIso() : payout.failedAt,
        failureReason: params.failedReason || payout.failureReason
      };
      if (status === 'paid') {
        const entry = this.buildTransaction({
          id: updated.payoutTransactionId!,
          type: 'adjustment',
          amount: updated.amount,
          currency: updated.currency,
          driverId: updated.driverId,
          status: 'completed',
          idempotencyKey: `${updated.id}:paid`,
          requestId: params.requestId,
          source: `driver:${updated.driverId}`,
          destination: `payout:${updated.method}`,
          metadata: { payoutId: updated.id, payoutType: 'driver_payout' }
        });
        tx.set(db.doc(`financialTransactions/${entry.id}`), { ...entry, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      }
      tx.set(payoutRef, { ...updated, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
      auditService.logInTransaction(tx, db, { ...params.actor, eventType: status === 'paid' ? 'PAYOUT_COMPLETED' : 'PAYOUT_FAILED', targetType: 'PAYOUT', targetId: updated.id, source: 'PAYMENT_BACKEND', metadata: { amount: updated.amount, currency: updated.currency, providerReference: updated.providerReference } }, firestoreServerTimestamp(firebaseAdmin));
      return updated;
    });
  }

  async requestRefund(params: {
    user: AuthenticatedFinanceUser;
    paymentId: string;
    amount?: number;
    reason: unknown;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<Refund> {
    assertProductionActor(params.user);
    if (!params.usePersistentStore) return this.requestMemoryRefund(params);
    const firebaseAdmin = await this.adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('refund-request', params.user.uid, params.idempotencyKey)}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) return idemSnap.data()?.response as Refund;
      const paymentSnap = await tx.get(db.doc(`payments/${params.paymentId}`));
      if (!paymentSnap.exists) throw new PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
      const payment = paymentSnap.data() as unknown as Payment;
      if (params.user.role === 'CUSTOMER' && payment.customerId !== params.user.uid) {
        throw new PaymentDomainError('REFUND_FORBIDDEN', 'Customer can only refund own payments', 403);
      }
      if (params.user.role !== 'CUSTOMER') assertAdmin(params.user);
      if (payment.status !== 'paid' && payment.status !== 'partially_refunded') throw new PaymentDomainError('PAYMENT_NOT_REFUNDABLE', 'Payment is not refundable', 409);
      const amount = assertMoneyAmount(params.amount ?? remainingRefundable(payment));
      if (amount > backendConfig.maxRefundAmount) throw new PaymentDomainError('REFUND_ABOVE_MAXIMUM', 'Refund amount exceeds configured maximum', 400);
      if (amount > remainingRefundable(payment)) {
        await this.writeRiskFlagInTx(tx, db, firebaseAdmin, { type: 'duplicate_refund_attempt', severity: 'high', userId: params.user.uid, paymentId: payment.id, manualReviewRequired: true, metadata: { requestedAmount: amount, remainingRefundableAmount: remainingRefundable(payment) } });
        throw new PaymentDomainError('REFUND_AMOUNT_EXCEEDS_REMAINING', 'Refund amount exceeds remaining refundable amount', 409);
      }
      const refund = this.buildRefund(payment, amount, normalizeRefundReason(params.reason), params.user.uid, params.idempotencyKey, params.requestId);
      tx.set(db.doc(`refunds/${refund.id}`), { ...refund, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'refund-request', response: refund, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'REFUND_REQUESTED', targetType: 'REFUND', targetId: refund.id, rideId: refund.rideId, source: 'PAYMENT_BACKEND', metadata: { paymentId: refund.paymentId, amount: refund.amount, currency: refund.currency, reason: refund.reason } }, firestoreServerTimestamp(firebaseAdmin));
      return refund;
    });
  }

  async approveRefund(params: {
    user: AuthenticatedFinanceUser;
    refundId: string;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<Refund> {
    assertAdmin(params.user);
    if (!params.usePersistentStore) return this.approveMemoryRefund(params);
    const firebaseAdmin = await this.adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const refundRef = db.doc(`refunds/${params.refundId}`);
      const refundSnap = await tx.get(refundRef);
      if (!refundSnap.exists) throw new PaymentDomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
      const refund = refundSnap.data() as unknown as Refund;
      if (refund.status === 'completed') return refund;
      const paymentSnap = await tx.get(db.doc(`payments/${refund.paymentId}`));
      if (!paymentSnap.exists) throw new PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
      const payment = paymentSnap.data() as unknown as Payment;
      if (refund.amount > remainingRefundable(payment)) throw new PaymentDomainError('REFUND_AMOUNT_EXCEEDS_REMAINING', 'Refund amount exceeds remaining refundable amount', 409);
      if (payment.method === 'digital_provider') {
        await paymentProvider.refundPayment({
          paymentId: payment.id,
          refundId: refund.id,
          providerTransactionId: payment.providerTransactionId,
          amount: refund.amount,
          currency: refund.currency,
          idempotencyKey: params.idempotencyKey,
          requestId: params.requestId
        });
      }
      const completed = this.completeRefundObjects(payment, refund, params.user.uid, params.requestId);
      tx.set(refundRef, { ...completed.refund, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
      tx.set(db.doc(`payments/${payment.id}`), { ...completed.payment, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
      tx.set(db.doc(`financialTransactions/${completed.transaction.id}`), { ...completed.transaction, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      if (payment.method === 'wallet') {
        const walletRef = db.doc(`wallets/${payment.customerId}`);
        const walletSnap = await tx.get(walletRef);
        const balanceBefore = Number(walletSnap.data()?.balance ?? 0);
        const balanceAfter = addMoney(balanceBefore, refund.amount);
        tx.set(walletRef, { userId: payment.customerId, balance: balanceAfter, updatedAt: nowIso(), serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
        tx.set(db.doc(`walletTransactions/${completed.transaction.id}`), {
          transactionId: completed.transaction.id,
          userId: payment.customerId,
          type: 'REFUND',
          amount: refund.amount,
          balanceBefore,
          balanceAfter,
          status: 'SUCCESS',
          createdAt: completed.transaction.createdAt,
          referenceId: refund.id,
          idempotencyKey: refund.idempotencyKey,
          serverCreatedAt: firestoreServerTimestamp(firebaseAdmin)
        });
      }
      auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'REFUND_COMPLETED', targetType: 'REFUND', targetId: refund.id, rideId: refund.rideId, source: 'PAYMENT_BACKEND', metadata: { paymentId: refund.paymentId, amount: refund.amount, currency: refund.currency } }, firestoreServerTimestamp(firebaseAdmin));
      return completed.refund;
    });
  }

  async runFinancialReconciliation(params: {
    user: AuthenticatedFinanceUser;
    dateFrom?: string;
    dateTo?: string;
    paymentId?: string;
    driverId?: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<{ status: 'matched' | 'manual_review'; issues: ReconciliationIssue[]; checked: { payments: number; transactions: number } }> {
    assertAdmin(params.user);
    const data = params.usePersistentStore ? await this.readPersistentFinanceData() : this.readMemoryFinanceData();
    const payments = data.payments.filter((payment) =>
      (!params.paymentId || payment.id === params.paymentId) &&
      (!params.driverId || payment.driverId === params.driverId) &&
      (!params.dateFrom || payment.createdAt >= params.dateFrom) &&
      (!params.dateTo || payment.createdAt <= params.dateTo)
    );
    const transactions = data.transactions.filter((entry) =>
      (!params.driverId || entry.driverId === params.driverId) &&
      (!params.dateFrom || entry.createdAt >= params.dateFrom) &&
      (!params.dateTo || entry.createdAt <= params.dateTo)
    );
    const issues = this.detectIssues(payments, transactions, data.walletBalances);
    if (params.usePersistentStore) await this.persistReconciliationIssues(params, issues);
    else issues.forEach((issue) => memoryIssues.set(issue.id, issue));
    return { status: issues.length === 0 ? 'matched' : 'manual_review', issues, checked: { payments: payments.length, transactions: transactions.length } };
  }

  async generateSettlement(params: {
    user: AuthenticatedFinanceUser;
    period: SettlementPeriod;
    dateFrom: string;
    dateTo: string;
    driverId?: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<SettlementReport> {
    assertAdmin(params.user);
    const data = params.usePersistentStore ? await this.readPersistentFinanceData() : this.readMemoryFinanceData();
    const payments = data.payments.filter((payment) =>
      payment.createdAt >= params.dateFrom &&
      payment.createdAt <= params.dateTo &&
      (!params.driverId || payment.driverId === params.driverId)
    );
    const transactions = data.transactions.filter((entry) =>
      entry.createdAt >= params.dateFrom &&
      entry.createdAt <= params.dateTo &&
      (!params.driverId || entry.driverId === params.driverId)
    );
    const payouts = data.payouts.filter((payout) =>
      payout.requestedAt >= params.dateFrom &&
      payout.requestedAt <= params.dateTo &&
      (!params.driverId || payout.driverId === params.driverId)
    );
    const report: SettlementReport = {
      id: id('settlement'),
      period: params.period,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      driverId: params.driverId,
      currency: payments[0]?.currency || transactions[0]?.currency || 'YER',
      grossRideAmount: payments.filter((p) => p.status === 'paid' || p.status === 'partially_refunded' || p.status === 'refunded').reduce((sum, p) => sum + p.amount, 0),
      cashCollected: payments.filter((p) => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0),
      walletCollected: payments.filter((p) => p.method === 'wallet').reduce((sum, p) => sum + p.amount, 0),
      digitalCollected: payments.filter((p) => p.method === 'digital_provider').reduce((sum, p) => sum + p.amount, 0),
      driverGrossEarnings: txAmountByType(transactions, 'driver_earning'),
      platformCommission: txAmountByType(transactions, 'platform_commission'),
      refunds: txAmountByType(transactions, 'refund'),
      payouts: payouts.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0),
      adjustments: txAmountByType(transactions, 'adjustment'),
      netSettlement: 0,
      status: 'generated',
      generatedAt: nowIso(),
      generatedBy: params.user.uid,
      requestId: params.requestId
    };
    report.netSettlement = report.grossRideAmount - report.platformCommission - report.refunds - report.payouts + report.adjustments;
    if (params.usePersistentStore) {
      const firebaseAdmin = await this.adminContext();
      const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
      await db.doc(`settlements/${report.id}`).set({ ...report, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      await auditService.log({ ...params.actor, eventType: 'SETTLEMENT_GENERATED', targetType: 'SETTLEMENT', targetId: report.id, source: 'PAYMENT_BACKEND', metadata: { netSettlement: report.netSettlement, currency: report.currency } });
    } else {
      memorySettlements.set(report.id, report);
    }
    return report;
  }

  async createAdjustment(params: {
    user: AuthenticatedFinanceUser;
    targetUserId: string;
    type: 'adjustment_credit' | 'adjustment_debit';
    amount: number;
    reason: string;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<FinancialAdjustment> {
    assertAdmin(params.user);
    const amount = assertMoneyAmount(params.amount);
    if (!params.reason || params.reason.trim().length < 4) throw new PaymentDomainError('ADJUSTMENT_REASON_REQUIRED', 'Adjustment reason is required', 400);
    const transaction = this.buildTransaction({
      type: 'adjustment',
      amount,
      currency: 'YER',
      driverId: params.targetUserId,
      status: 'completed',
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      source: params.type === 'adjustment_credit' ? 'mishwar_platform' : `driver:${params.targetUserId}`,
      destination: params.type === 'adjustment_credit' ? `driver:${params.targetUserId}` : 'mishwar_platform',
      metadata: { adjustmentType: params.type, reason: params.reason }
    });
    const adjustment: FinancialAdjustment = {
      id: id('adjustment'),
      type: params.type,
      userId: params.targetUserId,
      amount,
      currency: transaction.currency,
      reason: params.reason,
      adminId: params.user.uid,
      requestId: params.requestId,
      transactionId: transaction.id,
      createdAt: transaction.createdAt
    };
    if (params.usePersistentStore) {
      const firebaseAdmin = await this.adminContext();
      const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
      await db.doc(`financialTransactions/${transaction.id}`).set({ ...transaction, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      await db.doc(`financialAdjustments/${adjustment.id}`).set({ ...adjustment, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      await auditService.log({ ...params.actor, eventType: 'FINANCIAL_ADJUSTMENT_CREATED', targetType: 'WALLET', targetId: params.targetUserId, source: 'PAYMENT_BACKEND', metadata: { adjustmentId: adjustment.id, transactionId: transaction.id, amount, currency: transaction.currency } });
    } else {
      memoryTransactions.set(transaction.id, transaction);
      memoryAdjustments.set(adjustment.id, adjustment);
    }
    return adjustment;
  }

  async settleDriverCommission(params: {
    user: AuthenticatedFinanceUser;
    driverId: string;
    amount: number;
    method: unknown;
    reference?: string;
    note?: string;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<{ settlement: FinancialTransaction; finance: DriverFinanceSummary }> {
    assertAdmin(params.user);
    const amount = assertMoneyAmount(params.amount);
    const method = String(params.method || 'cash_office').trim().toLowerCase();
    if (!['cash_office', 'bank', 'wallet', 'manual'].includes(method)) {
      throw new PaymentDomainError('INVALID_SETTLEMENT_METHOD', 'Unsupported settlement method', 400);
    }
    if (!params.driverId) throw new PaymentDomainError('DRIVER_ID_REQUIRED', 'driverId is required', 400);
    if (!params.idempotencyKey) throw new PaymentDomainError('MISSING_IDEMPOTENCY_KEY', 'x-idempotency-key is required', 400);
    if (!params.usePersistentStore) return this.settleMemoryCommission({ ...params, amount, method });

    const firebaseAdmin = await this.adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('commission-settlement', params.user.uid, params.idempotencyKey)}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) return idemSnap.data()?.response as { settlement: FinancialTransaction; finance: DriverFinanceSummary };

      const data = await this.readPersistentFinanceData();
      const driverTransactions = data.transactions.filter((item) => item.driverId === params.driverId);
      const finance = financeSummaryFrom(params.driverId, driverTransactions, data.payouts.filter((item) => item.driverId === params.driverId));
      if (amount <= 0) throw new PaymentDomainError('INVALID_SETTLEMENT_AMOUNT', 'Settlement amount must be greater than zero', 400);
      const accountRef = db.doc(`driverCommissionAccounts/${params.driverId}`);
      const accountSnap = await tx.get(accountRef);
      const accountData = accountSnap.exists ? accountSnap.data() : undefined;
      const availableDebt = accountSnap.exists
        ? Number(accountData?.outstandingCommissionDebt ?? finance.outstandingCommissionDebt)
        : finance.outstandingCommissionDebt;
      if (amount > availableDebt) {
        throw new PaymentDomainError('SETTLEMENT_EXCEEDS_DEBT', 'Settlement amount exceeds outstanding commission debt', 409);
      }

      const settlement = this.buildTransaction({
        type: 'commission_settlement',
        amount,
        currency: finance.currency,
        driverId: params.driverId,
        status: 'completed',
        idempotencyKey: params.idempotencyKey,
        requestId: params.requestId,
        source: `driver:${params.driverId}`,
        destination: 'mishwar_platform',
        metadata: {
          method,
          reference: params.reference || null,
          note: params.note || null,
          simulationOnly: false
        }
      });
      tx.set(db.doc(`financialTransactions/${settlement.id}`), { ...settlement, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      const updatedFinance = financeSummaryFrom(params.driverId, [settlement, ...driverTransactions], data.payouts.filter((item) => item.driverId === params.driverId));
      const response = { settlement, finance: updatedFinance };
      tx.set(accountRef, {
        driverId: params.driverId,
        currency: finance.currency,
        outstandingCommissionDebt: Math.max(0, availableDebt - amount),
        lastSettlementId: settlement.id,
        lastSettlementAmount: amount,
        lastSettlementAt: settlement.completedAt || settlement.createdAt,
        updatedAt: nowIso(),
        serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
      }, { merge: true });
      tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'commission-settlement', response, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
      auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'COMMISSION_SETTLEMENT_RECORDED', targetType: 'PAYMENT', targetId: settlement.id, source: 'PAYMENT_BACKEND', metadata: { driverId: params.driverId, amount, currency: settlement.currency, method, reference: params.reference || null } }, firestoreServerTimestamp(firebaseAdmin));
      return response;
    });
  }

  async recordDemoDigitalPayment(params: {
    user: AuthenticatedFinanceUser;
    driverId: string;
    customerId: string;
    rideId: string;
    amount: number;
    allowDebtOffset?: boolean;
    idempotencyKey: string;
    requestId?: string;
    actor: AuditActor;
    usePersistentStore: boolean;
  }): Promise<{ payment: Payment; transactions: FinancialTransaction[]; finance: DriverFinanceSummary }> {
    assertAdmin(params.user);
    const amount = assertMoneyAmount(params.amount);
    if (!params.driverId || !params.customerId || !params.rideId) throw new PaymentDomainError('INVALID_DEMO_PAYMENT', 'driverId, customerId and rideId are required', 400);
    if (!params.idempotencyKey) throw new PaymentDomainError('MISSING_IDEMPOTENCY_KEY', 'x-idempotency-key is required', 400);
    if (params.usePersistentStore) {
      const firebaseAdmin = await this.adminContext();
      const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
      const existing = await db.doc(`idempotencyKeys/${idempotencyDocId('demo-digital-payment', params.user.uid, params.idempotencyKey)}`).get();
      if (existing.exists) return existing.data()?.response as { payment: Payment; transactions: FinancialTransaction[]; finance: DriverFinanceSummary };
    } else if (memoryIdempotency.has(params.idempotencyKey)) {
      return memoryIdempotency.get(params.idempotencyKey) as { payment: Payment; transactions: FinancialTransaction[]; finance: DriverFinanceSummary };
    }

    const platformCommission = Math.round(amount * 0.1);
    const driverEarning = amount - platformCommission;
    const now = nowIso();
    const payment: Payment = {
      id: `pay_${params.rideId}_demo_digital`,
      rideId: params.rideId,
      customerId: params.customerId,
      driverId: params.driverId,
      amount,
      currency: 'YER',
      method: 'digital_provider',
      status: 'paid',
      provider: 'mishwar_demo',
      providerReference: `demo-${params.idempotencyKey}`,
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      metadata: { simulationOnly: true }
    };
    const transactions: FinancialTransaction[] = [
      this.buildTransaction({ type: 'ride_payment', amount, currency: payment.currency, rideId: params.rideId, paymentId: payment.id, customerId: params.customerId, driverId: params.driverId, status: 'completed', idempotencyKey: params.idempotencyKey, requestId: params.requestId, source: `demo_customer:${params.customerId}`, destination: 'mishwar_demo_clearing', metadata: { simulationOnly: true } }),
      this.buildTransaction({ type: 'platform_commission', amount: platformCommission, currency: payment.currency, rideId: params.rideId, paymentId: payment.id, customerId: params.customerId, driverId: params.driverId, status: 'completed', idempotencyKey: `${params.idempotencyKey}:commission`, requestId: params.requestId, source: 'mishwar_demo_clearing', destination: 'mishwar_platform', metadata: { simulationOnly: true } }),
      this.buildTransaction({ type: 'driver_earning', amount: driverEarning, currency: payment.currency, rideId: params.rideId, paymentId: payment.id, customerId: params.customerId, driverId: params.driverId, status: 'completed', idempotencyKey: `${params.idempotencyKey}:driver_earning`, requestId: params.requestId, source: 'mishwar_demo_clearing', destination: `driver:${params.driverId}`, metadata: { simulationOnly: true } })
    ];

    const existingData = params.usePersistentStore ? await this.readPersistentFinanceData() : this.readMemoryFinanceData();
    const existingDriverTransactions = existingData.transactions.filter((item) => item.driverId === params.driverId);
    const existingFinance = financeSummaryFrom(params.driverId, existingDriverTransactions, existingData.payouts.filter((item) => item.driverId === params.driverId));
    if (params.allowDebtOffset && existingFinance.outstandingCommissionDebt > 0) {
      const offsetAmount = Math.min(driverEarning, existingFinance.outstandingCommissionDebt);
      if (offsetAmount > 0) {
        transactions.push(this.buildTransaction({ type: 'commission_offset', amount: offsetAmount, currency: payment.currency, rideId: params.rideId, paymentId: payment.id, customerId: params.customerId, driverId: params.driverId, status: 'completed', idempotencyKey: `${params.idempotencyKey}:commission_offset`, requestId: params.requestId, source: `driver:${params.driverId}`, destination: 'mishwar_platform', metadata: { simulationOnly: true, offsetFromDemoDigitalPayment: true } }));
      }
    }

    const finance = financeSummaryFrom(params.driverId, [...transactions, ...existingDriverTransactions], existingData.payouts.filter((item) => item.driverId === params.driverId));
    const response = { payment, transactions, finance };
    if (params.usePersistentStore) {
      const firebaseAdmin = await this.adminContext();
      await runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
        const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('demo-digital-payment', params.user.uid, params.idempotencyKey)}`);
        const idemSnap = await tx.get(idemRef);
        if (idemSnap.exists) return;
        tx.set(db.doc(`payments/${payment.id}`), { ...payment, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
        transactions.forEach((entry) => tx.set(db.doc(`financialTransactions/${entry.id}`), { ...entry, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) }));
        tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'demo-digital-payment', response, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
        auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'DEMO_DIGITAL_PAYMENT_RECORDED', targetType: 'PAYMENT', targetId: payment.id, rideId: payment.rideId, source: 'PAYMENT_BACKEND', metadata: { amount, currency: payment.currency, simulationOnly: true, offsetApplied: transactions.some((item) => item.type === 'commission_offset') } }, firestoreServerTimestamp(firebaseAdmin));
      });
    } else {
      memoryPayments.set(payment.id, payment);
      transactions.forEach((entry) => memoryTransactions.set(entry.id, entry));
      memoryIdempotency.set(params.idempotencyKey, response);
    }
    return response;
  }

  private requestMemoryPayout(params: { user: AuthenticatedFinanceUser; amount: number; method: PayoutMethod; idempotencyKey: string; requestId?: string }): DriverPayout {
    if (memoryIdempotency.has(params.idempotencyKey)) return memoryIdempotency.get(params.idempotencyKey) as DriverPayout;
    const finance = financeSummaryFrom(params.user.uid, [...memoryTransactions.values()].filter((item) => item.driverId === params.user.uid), [...memoryPayouts.values()].filter((item) => item.driverId === params.user.uid));
    if (params.amount > finance.availableBalance) throw new PaymentDomainError('INSUFFICIENT_PAYOUT_BALANCE', 'Payout amount exceeds available balance', 409);
    const payout = this.buildPayout(params.user.uid, params.amount, finance.currency, params.method, params.idempotencyKey, params.requestId);
    memoryPayouts.set(payout.id, payout);
    memoryIdempotency.set(params.idempotencyKey, payout);
    return payout;
  }

  private settleMemoryCommission(params: {
    user: AuthenticatedFinanceUser;
    driverId: string;
    amount: number;
    method: string;
    reference?: string;
    note?: string;
    idempotencyKey: string;
    requestId?: string;
  }): { settlement: FinancialTransaction; finance: DriverFinanceSummary } {
    const scopedKey = `commission-settlement:${params.user.uid}:${params.idempotencyKey}`;
    if (memoryIdempotency.has(scopedKey)) {
      return memoryIdempotency.get(scopedKey) as { settlement: FinancialTransaction; finance: DriverFinanceSummary };
    }
    const driverTransactions = [...memoryTransactions.values()].filter((item) => item.driverId === params.driverId);
    const driverPayouts = [...memoryPayouts.values()].filter((item) => item.driverId === params.driverId);
    const finance = financeSummaryFrom(params.driverId, driverTransactions, driverPayouts);
    if (params.amount <= 0) throw new PaymentDomainError('INVALID_SETTLEMENT_AMOUNT', 'Settlement amount must be greater than zero', 400);
    if (params.amount > finance.outstandingCommissionDebt) {
      throw new PaymentDomainError('SETTLEMENT_EXCEEDS_DEBT', 'Settlement amount exceeds outstanding commission debt', 409);
    }
    const settlement = this.buildTransaction({
      type: 'commission_settlement',
      amount: params.amount,
      currency: finance.currency,
      driverId: params.driverId,
      status: 'completed',
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      source: `driver:${params.driverId}`,
      destination: 'mishwar_platform',
      metadata: {
        method: params.method,
        reference: params.reference || null,
        note: params.note || null,
        simulationOnly: false
      }
    });
    memoryTransactions.set(settlement.id, settlement);
    const updatedFinance = financeSummaryFrom(params.driverId, [settlement, ...driverTransactions], driverPayouts);
    const response = { settlement, finance: updatedFinance };
    memoryIdempotency.set(scopedKey, response);
    return response;
  }

  private updateMemoryPayout(payoutId: string, status: PayoutStatus, adminId: string): DriverPayout {
    const payout = memoryPayouts.get(payoutId);
    if (!payout) throw new PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
    const updated = { ...payout, status, approvedAt: nowIso(), approvedBy: adminId };
    memoryPayouts.set(updated.id, updated);
    return updated;
  }

  private completeMemoryPayout(params: { payoutId: string; markFailed?: boolean; failedReason?: string; providerReference?: string }): DriverPayout {
    const payout = memoryPayouts.get(params.payoutId);
    if (!payout) throw new PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
    const updated: DriverPayout = { ...payout, status: params.markFailed ? 'failed' : 'paid', paidAt: params.markFailed ? undefined : nowIso(), failedAt: params.markFailed ? nowIso() : undefined, failureReason: params.failedReason, providerReference: params.providerReference };
    memoryPayouts.set(updated.id, updated);
    if (!params.markFailed) {
      const entry = this.buildTransaction({ type: 'adjustment', amount: updated.amount, currency: updated.currency, driverId: updated.driverId, status: 'completed', idempotencyKey: `${updated.id}:paid`, source: `driver:${updated.driverId}`, destination: `payout:${updated.method}`, metadata: { payoutId: updated.id, payoutType: 'driver_payout' } });
      memoryTransactions.set(entry.id, entry);
    }
    return updated;
  }

  private requestMemoryRefund(params: { user: AuthenticatedFinanceUser; paymentId: string; amount?: number; reason: unknown; idempotencyKey: string; requestId?: string }): Refund {
    if (memoryIdempotency.has(params.idempotencyKey)) return memoryIdempotency.get(params.idempotencyKey) as Refund;
    const payment = memoryPayments.get(params.paymentId);
    if (!payment) throw new PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
    if (payment.customerId !== params.user.uid && !adminRoles.includes(params.user.role)) throw new PaymentDomainError('REFUND_FORBIDDEN', 'Refund forbidden', 403);
    const amount = assertMoneyAmount(params.amount ?? remainingRefundable(payment));
    if (amount > remainingRefundable(payment)) {
      const flagId = id('risk');
      memoryRiskFlags.set(flagId, {
        id: flagId,
        type: 'duplicate_refund_attempt',
        severity: 'high',
        userId: params.user.uid,
        paymentId: payment.id,
        createdAt: nowIso(),
        manualReviewRequired: true,
        metadata: { requestedAmount: amount, remainingRefundableAmount: remainingRefundable(payment) }
      });
      throw new PaymentDomainError('REFUND_AMOUNT_EXCEEDS_REMAINING', 'Refund amount exceeds remaining refundable amount', 409);
    }
    const refund = this.buildRefund(payment, amount, normalizeRefundReason(params.reason), params.user.uid, params.idempotencyKey, params.requestId);
    memoryRefunds.set(refund.id, refund);
    memoryIdempotency.set(params.idempotencyKey, refund);
    return refund;
  }

  private approveMemoryRefund(params: { refundId: string; user: AuthenticatedFinanceUser; requestId?: string }): Refund {
    const refund = memoryRefunds.get(params.refundId);
    if (!refund) throw new PaymentDomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
    const payment = memoryPayments.get(refund.paymentId);
    if (!payment) throw new PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
    const completed = this.completeRefundObjects(payment, refund, params.user.uid, params.requestId);
    memoryPayments.set(payment.id, completed.payment);
    memoryRefunds.set(refund.id, completed.refund);
    memoryTransactions.set(completed.transaction.id, completed.transaction);
    if (payment.method === 'wallet') memoryWallets.set(payment.customerId, addMoney(memoryWallets.get(payment.customerId) || 0, refund.amount));
    return completed.refund;
  }

  private buildPayout(driverId: string, amount: number, currency: string, method: PayoutMethod, idempotencyKey: string, requestId?: string): DriverPayout {
    return { id: id('payout'), driverId, amount, currency, method, status: 'requested', idempotencyKey, requestId, requestedAt: nowIso() };
  }

  private buildRefund(payment: Payment, amount: number, reason: RefundReason, requestedBy: string, idempotencyKey: string, requestId?: string): Refund {
    return { id: id('refund'), paymentId: payment.id, rideId: payment.rideId, customerId: payment.customerId, driverId: payment.driverId, amount, currency: payment.currency, reason, status: 'requested', idempotencyKey, requestId, requestedBy, createdAt: nowIso() };
  }

  private completeRefundObjects(payment: Payment, refund: Refund, approvedBy: string, requestId?: string): { payment: Payment; refund: Refund; transaction: FinancialTransaction } {
    const refundedAmount = addMoney(paymentRefundedAmount(payment), refund.amount);
    const updatedPayment: Payment = { ...payment, refundedAmount, status: refundedAmount >= payment.amount ? 'refunded' : 'partially_refunded', updatedAt: nowIso(), metadata: { ...payment.metadata, refundedAmount } };
    const updatedRefund: Refund = { ...refund, status: 'completed', approvedBy, approvedAt: nowIso(), completedAt: nowIso(), refundTransactionId: refund.refundTransactionId || id('fin') };
    const transaction = this.buildTransaction({
      id: updatedRefund.refundTransactionId,
      type: 'refund',
      amount: refund.amount,
      currency: refund.currency,
      rideId: refund.rideId,
      paymentId: refund.paymentId,
      customerId: refund.customerId,
      driverId: refund.driverId,
      status: 'completed',
      idempotencyKey: refund.idempotencyKey,
      requestId,
      source: 'mishwar_platform',
      destination: `customer:${refund.customerId}`,
      metadata: { refundId: refund.id, reason: refund.reason }
    });
    return { payment: updatedPayment, refund: updatedRefund, transaction };
  }

  private buildTransaction(input: Omit<FinancialTransaction, 'id' | 'createdAt'> & { id?: string }): FinancialTransaction {
    return { ...input, id: input.id || id('fin'), createdAt: nowIso(), completedAt: input.status === 'completed' ? nowIso() : undefined };
  }

  private detectIssues(payments: Payment[], transactions: FinancialTransaction[], walletBalances: Map<string, number>): ReconciliationIssue[] {
    const issues: ReconciliationIssue[] = [];
    const txByPayment = new Map<string, FinancialTransaction[]>();
    for (const entry of transactions) {
      if (entry.paymentId) txByPayment.set(entry.paymentId, [...(txByPayment.get(entry.paymentId) || []), entry]);
    }
    for (const payment of payments) {
      if (payment.status === 'paid' && !(txByPayment.get(payment.id) || []).some((entry) => ['ride_payment', 'wallet_debit'].includes(entry.type) && entry.status === 'completed')) {
        issues.push(this.issue('missing_internal', 'critical', { paymentId: payment.id, expectedAmount: payment.amount, currency: payment.currency }));
      }
      const commission = txAmountByType(txByPayment.get(payment.id) || [], 'platform_commission');
      const earning = txAmountByType(txByPayment.get(payment.id) || [], 'driver_earning');
      if (payment.status === 'paid' && commission + earning !== payment.amount) {
        issues.push(this.issue('mismatch', 'high', { paymentId: payment.id, expectedAmount: payment.amount, actualAmount: commission + earning, currency: payment.currency }));
      }
    }
    const idempotencyCounts = new Map<string, FinancialTransaction[]>();
    transactions.forEach((entry) => idempotencyCounts.set(entry.idempotencyKey, [...(idempotencyCounts.get(entry.idempotencyKey) || []), entry]));
    for (const entries of idempotencyCounts.values()) {
      if (entries.length > 1) issues.push(this.issue('duplicate', 'high', { transactionId: entries[0].id, actualAmount: entries.reduce((sum, item) => sum + item.amount, 0), currency: entries[0].currency }));
    }
    for (const [userId, balance] of walletBalances.entries()) {
      const ledgerBalance = transactions
        .filter((entry) => entry.customerId === userId && ['wallet_credit', 'refund', 'adjustment'].includes(entry.type) && entry.status === 'completed')
        .reduce((sum, entry) => sum + entry.amount, 0) -
        transactions
          .filter((entry) => entry.customerId === userId && entry.type === 'wallet_debit' && entry.status === 'completed')
          .reduce((sum, entry) => sum + entry.amount, 0);
      if (ledgerBalance !== balance) {
        issues.push(this.issue('wallet_balance_mismatch', 'high', { expectedAmount: ledgerBalance, actualAmount: balance, currency: 'YER', metadata: { userId } }));
      }
    }
    return issues;
  }

  private issue(type: ReconciliationIssue['type'], severity: ReconciliationIssue['severity'], data: Partial<ReconciliationIssue>): ReconciliationIssue {
    return { id: id('recon_issue'), type, severity, status: 'open', createdAt: nowIso(), ...data };
  }

  private async persistReconciliationIssues(params: { actor: AuditActor; requestId?: string }, issues: ReconciliationIssue[]): Promise<void> {
    const firebaseAdmin = await this.adminContext();
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
    await auditService.log({ ...params.actor, eventType: 'RECONCILIATION_STARTED', targetType: 'RECONCILIATION', targetId: params.requestId || id('recon'), source: 'PAYMENT_BACKEND', metadata: { issueCount: issues.length } });
    await Promise.all(issues.map((issue) => db.doc(`reconciliationIssues/${issue.id}`).set({ ...issue, requestId: params.requestId, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) })));
    if (issues.length > 0) {
      await auditService.log({ ...params.actor, eventType: 'RECONCILIATION_MISMATCH_DETECTED', targetType: 'RECONCILIATION', targetId: params.requestId || id('recon'), source: 'PAYMENT_BACKEND', metadata: { issueCount: issues.length } });
    }
    await auditService.log({ ...params.actor, eventType: 'RECONCILIATION_COMPLETED', targetType: 'RECONCILIATION', targetId: params.requestId || id('recon'), source: 'PAYMENT_BACKEND', metadata: { issueCount: issues.length } });
  }

  private async writeRiskFlagInTx(tx: FirestoreTransaction, db: FirestoreDb, firebaseAdmin: FirebaseContext, input: Omit<FinancialRiskFlag, 'id' | 'createdAt'>): Promise<void> {
    const flag: FinancialRiskFlag = { ...input, id: id('risk'), createdAt: nowIso() };
    tx.set(db.doc(`financialRiskFlags/${flag.id}`), { ...flag, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
  }

  private readMemoryFinanceData(): { payments: Payment[]; transactions: FinancialTransaction[]; payouts: DriverPayout[]; walletBalances: Map<string, number> } {
    return { payments: [...memoryPayments.values()], transactions: [...memoryTransactions.values()], payouts: [...memoryPayouts.values()], walletBalances: new Map(memoryWallets) };
  }

  private async readPersistentFinanceData(): Promise<{ payments: Payment[]; transactions: FinancialTransaction[]; payouts: DriverPayout[]; walletBalances: Map<string, number> }> {
    const firebaseAdmin = await this.adminContext();
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app) as unknown as { collection: (path: string) => QueryLike };
    const [paymentsSnap, txSnap, payoutSnap, walletsSnap] = await Promise.all([
      db.collection('payments').get(),
      db.collection('financialTransactions').get(),
      db.collection('driverPayouts').get(),
      db.collection('wallets').get()
    ]);
    const walletBalances = new Map<string, number>();
    walletsSnap.docs.forEach((doc) => walletBalances.set(String(doc.data().userId || doc.id), Number(doc.data().balance || 0)));
    return {
      payments: paymentsSnap.docs.map((doc) => doc.data() as unknown as Payment),
      transactions: txSnap.docs.map((doc) => doc.data() as unknown as FinancialTransaction),
      payouts: payoutSnap.docs.map((doc) => doc.data() as unknown as DriverPayout),
      walletBalances
    };
  }

  private async adminContext(): Promise<FirebaseContext> {
    const firebaseAdmin = await getFirebaseAdmin();
    if (!firebaseAdmin) throw new PaymentDomainError('DATABASE_UNAVAILABLE', 'Persistent database is unavailable', 503);
    return firebaseAdmin;
  }
}

export const financialOperationsService = new FinancialOperationsService();
