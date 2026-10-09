import { UserRole } from '../../packages/shared_types/src';
import { AuthenticatedRequest, getFirebaseAdmin } from './auth';

export type AuditEventType =
  | 'RIDE_CREATED'
  | 'RIDE_ACCEPTED'
  | 'RIDE_DECLINED'
  | 'RIDE_CANCELLED'
  | 'RIDE_ARRIVED'
  | 'RIDE_STARTED'
  | 'RIDE_COMPLETED'
  | 'DRIVER_KYC_APPROVED'
  | 'DRIVER_KYC_REJECTED'
  | 'USER_BLOCKED'
  | 'USER_SUSPENDED'
  | 'USER_UNBLOCKED'
  | 'SESSION_REVOKED'
  | 'WALLET_DEBIT'
  | 'WALLET_CREDIT'
  | 'PAYMENT_RECORDED'
  | 'PAYMENT_CREATED'
  | 'PAYMENT_PROCESSING'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_FAILED'
  | 'CASH_CONFIRMED'
  | 'DRIVER_EARNING_CREATED'
  | 'PLATFORM_COMMISSION_CREATED'
  | 'PROVIDER_WEBHOOK_RECEIVED'
  | 'PROVIDER_WEBHOOK_VERIFIED'
  | 'PROVIDER_WEBHOOK_REJECTED'
  | 'PAYOUT_REQUESTED'
  | 'PAYOUT_APPROVED'
  | 'PAYOUT_PROCESSING'
  | 'PAYOUT_COMPLETED'
  | 'PAYOUT_FAILED'
  | 'PAYOUT_CANCELLED'
  | 'REFUND_REQUESTED'
  | 'REFUND_APPROVED'
  | 'REFUND_PROCESSING'
  | 'REFUND_COMPLETED'
  | 'REFUND_FAILED'
  | 'REFUND_REJECTED'
  | 'SETTLEMENT_GENERATED'
  | 'COMMISSION_SETTLEMENT_RECORDED'
  | 'DEMO_DIGITAL_PAYMENT_RECORDED'
  | 'RECONCILIATION_STARTED'
  | 'RECONCILIATION_COMPLETED'
  | 'RECONCILIATION_MISMATCH_DETECTED'
  | 'RECONCILIATION_ISSUE_RESOLVED'
  | 'FINANCIAL_ADJUSTMENT_CREATED'
  | 'FINANCIAL_RISK_FLAG_CREATED'
  | 'SAFETY_INCIDENT_CREATED'
  | 'SAFETY_SOS_TRIGGERED'
  | 'SAFETY_INCIDENT_ACKNOWLEDGED'
  | 'SAFETY_INCIDENT_ESCALATED'
  | 'SAFETY_INCIDENT_RESOLVED'
  | 'SAFETY_ATTACHMENT_ADDED'
  | 'SAFETY_SIGNAL_CREATED'
  | 'RISK_SIGNAL_CREATED'
  | 'RISK_CASE_CREATED'
  | 'RISK_CASE_ASSIGNED'
  | 'RISK_CASE_NOTE_ADDED'
  | 'RISK_CASE_RESOLVED'
  | 'RISK_ACTION_SUSPENDED'
  | 'RISK_ACTION_BLOCKED'
  | 'RISK_ACTION_UNBLOCKED';

export type AuditTargetType = 'RIDE' | 'DRIVER' | 'CUSTOMER' | 'AUTH' | 'WALLET' | 'PAYMENT' | 'PAYOUT' | 'REFUND' | 'SETTLEMENT' | 'RECONCILIATION' | 'FINANCIAL_RISK_FLAG' | 'SAFETY_INCIDENT' | 'SAFETY_SIGNAL' | 'RISK_SIGNAL' | 'RISK_CASE';

export type AuditActor = {
  actorUid: string;
  actorRole: UserRole | string;
  actorEmailOrPhone?: string | null;
  requestId?: string;
};

export type AuditLogInput = AuditActor & {
  eventType: AuditEventType;
  targetType: AuditTargetType;
  targetId: string;
  rideId?: string;
  requestId?: string;
  source?: 'BACKEND' | 'ADMIN_BACKEND' | 'PAYMENT_BACKEND';
  metadata?: Record<string, unknown>;
};

type FirestoreDb = {
  collection: (path: string) => { doc: (id?: string) => { set: (data: Record<string, unknown>) => Promise<unknown> } };
};

type FirestoreTransaction = {
  set: (ref: unknown, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
};

const secretKeyHints = [
  'authorization',
  'token',
  'otp',
  'password',
  'privatekey',
  'private_key',
  'serviceaccount',
  'credential',
  'card',
  'cvv',
  'secret',
  'nationalid',
  'documenturl',
  'imageurl'
];

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return secretKeyHints.some((hint) => normalized.includes(hint));
};

const sanitizeMetadata = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, entry]) => [key, sanitizeMetadata(entry)])
  );
};

const serverTimestamp = (firebaseAdmin: NonNullable<Awaited<ReturnType<typeof getFirebaseAdmin>>>): unknown => {
  const firestoreNamespace = firebaseAdmin.admin.firestore as unknown as {
    FieldValue?: { serverTimestamp: () => unknown };
  };
  return firestoreNamespace.FieldValue?.serverTimestamp() || new Date().toISOString();
};

export const auditActorFromRequest = (req: AuthenticatedRequest): AuditActor => ({
  actorUid: req.user?.uid || 'anonymous',
  actorRole: req.user?.role || 'UNKNOWN',
  actorEmailOrPhone: req.user?.email || req.user?.phone || null,
  requestId: req.requestId
});

export class AuditService {
  build(input: AuditLogInput, timestamp: unknown = new Date().toISOString()): Record<string, unknown> {
    const id = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    return {
      id,
      eventType: input.eventType,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      actorEmailOrPhone: input.actorEmailOrPhone || null,
      targetType: input.targetType,
      targetId: input.targetId,
      rideId: input.rideId || null,
      requestId: input.requestId || null,
      source: input.source || 'BACKEND',
      timestamp,
      createdAt: new Date().toISOString(),
      metadata: sanitizeMetadata(input.metadata || {})
    };
  }

  async log(input: AuditLogInput): Promise<void> {
    const firebaseAdmin = await getFirebaseAdmin();
    if (!firebaseAdmin) throw new Error('AUDIT_LOG_UNAVAILABLE');
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app) as unknown as FirestoreDb;
    const entry = this.build(input, serverTimestamp(firebaseAdmin));
    await db.collection('auditLogs').doc(String(entry.id)).set(entry);
  }

  logInTransaction(
    tx: FirestoreTransaction,
    db: { doc: (path: string) => unknown },
    input: AuditLogInput,
    timestamp: unknown = new Date().toISOString()
  ): void {
    const entry = this.build(input, timestamp);
    tx.set(db.doc(`auditLogs/${entry.id}`), entry);
  }
}

export const auditService = new AuditService();
