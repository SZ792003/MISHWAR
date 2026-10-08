import { AccountStatus } from '../../packages/shared_types/src';
import { AuditEventType, auditService } from './auditService';
import { getFirebaseAdmin } from './auth';
import { isPrivilegedAdminRole } from './trustedRoles';
import { AuthenticatedRequest } from './auth';

type SecurityActor = {
  uid: string;
  role: string;
  email?: string;
  phone?: string;
};

export const requireAccountAdmin = (req: AuthenticatedRequest): SecurityActor => {
  if (!req.user || !isPrivilegedAdminRole(req.user.role)) {
    throw new Error('TRUSTED_ADMIN_REQUIRED');
  }
  return {
    uid: req.user.uid,
    role: req.user.role,
    email: req.user.email,
    phone: req.user.phone
  };
};

const getAdminContext = async () => {
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  return firebaseAdmin;
};

const writeUserAccountStatus = async (
  uid: string,
  accountStatus: AccountStatus,
  actor: SecurityActor,
  reason?: string
) => {
  if (!uid) throw new Error('USER_UID_REQUIRED');
  const firebaseAdmin = await getAdminContext();
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const now = new Date().toISOString();

  await db.doc(`users/${uid}`).set({
    uid,
    id: uid,
    accountStatus,
    accountStatusReason: reason || null,
    accountStatusUpdatedAt: now,
    accountStatusUpdatedBy: actor.uid,
    updatedAt: now
  }, { merge: true });

  const eventTypeByStatus: Record<AccountStatus, AuditEventType> = {
    active: 'USER_UNBLOCKED',
    blocked: 'USER_BLOCKED',
    suspended: 'USER_SUSPENDED'
  };

  await auditService.log({
    eventType: eventTypeByStatus[accountStatus],
    actorUid: actor.uid,
    actorRole: actor.role,
    actorEmailOrPhone: actor.email || actor.phone || null,
    targetType: 'AUTH',
    targetId: uid,
    source: 'ADMIN_BACKEND',
    metadata: { reason: reason || null, accountStatus }
  });
};

export const revokeUserSessions = async (uid: string): Promise<{ uid: string; revokedAt: string }> => {
  if (!uid) throw new Error('USER_UID_REQUIRED');
  const firebaseAdmin = await getAdminContext();
  await firebaseAdmin.admin.auth(firebaseAdmin.app).revokeRefreshTokens(uid);
  return { uid, revokedAt: new Date().toISOString() };
};

export const auditSessionRevocation = async (uid: string, actor: SecurityActor, revokedAt: string): Promise<void> => {
  await auditService.log({
    eventType: 'SESSION_REVOKED',
    actorUid: actor.uid,
    actorRole: actor.role,
    actorEmailOrPhone: actor.email || actor.phone || null,
    targetType: 'AUTH',
    targetId: uid,
    source: 'ADMIN_BACKEND',
    metadata: { revokedAt }
  });
};

export const blockUser = async (uid: string, actor: SecurityActor, reason?: string) => {
  await writeUserAccountStatus(uid, 'blocked', actor, reason);
  const revocation = await revokeUserSessions(uid);
  await auditSessionRevocation(uid, actor, revocation.revokedAt);
  return { uid, accountStatus: 'blocked' as AccountStatus, sessionsRevokedAt: revocation.revokedAt };
};

export const unblockUser = async (uid: string, actor: SecurityActor, reason?: string) => {
  await writeUserAccountStatus(uid, 'active', actor, reason);
  return { uid, accountStatus: 'active' as AccountStatus, requiresNewLogin: true };
};

export const suspendUser = async (uid: string, actor: SecurityActor, reason?: string) => {
  await writeUserAccountStatus(uid, 'suspended', actor, reason);
  const revocation = await revokeUserSessions(uid);
  await auditSessionRevocation(uid, actor, revocation.revokedAt);
  return { uid, accountStatus: 'suspended' as AccountStatus, sessionsRevokedAt: revocation.revokedAt };
};
