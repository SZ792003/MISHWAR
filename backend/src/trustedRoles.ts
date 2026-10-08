import { KycStatus, UserRole } from '../../packages/shared_types/src';
import { auditService } from './auditService';
import { AuthenticatedRequest, getFirebaseAdmin, normalizeTrustedRole } from './auth';

type TrustedAdminContext = {
  uid: string;
  role: UserRole;
  email?: string;
  phone?: string;
};

type DriverKycRecord = {
  uid?: string;
  driverId?: string;
  kycStatus?: KycStatus;
  onboardingStatus?: string;
  submittedAt?: string;
  updatedAt?: string;
};

const adminRoles: UserRole[] = ['ADMIN', 'SUPER_ADMIN', 'KYC_REVIEWER'];

export const isPrivilegedAdminRole = (role: UserRole): boolean => {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
};

export const canReviewKyc = (role: UserRole): boolean => {
  return adminRoles.includes(role);
};

export const requireTrustedAdminContext = (req: AuthenticatedRequest): TrustedAdminContext => {
  if (!req.user || !canReviewKyc(req.user.role)) {
    throw new Error('TRUSTED_ADMIN_REQUIRED');
  }
  return {
    uid: req.user.uid,
    role: req.user.role,
    email: req.user.email,
    phone: req.user.phone
  };
};

export const setTrustedRoleClaim = async (uid: string, role: UserRole): Promise<void> => {
  const normalizedRole = normalizeTrustedRole(role);
  if (!normalizedRole) throw new Error('INVALID_ROLE');

  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');

  const auth = firebaseAdmin.admin.auth(firebaseAdmin.app);
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, {
    ...(user.customClaims || {}),
    role: normalizedRole,
    mishwarRole: normalizedRole
  });
};

export const clearDriverRoleClaim = async (uid: string): Promise<void> => {
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');

  const auth = firebaseAdmin.admin.auth(firebaseAdmin.app);
  const user = await auth.getUser(uid);
  const currentRole = normalizeTrustedRole(user.customClaims?.role || user.customClaims?.mishwarRole);
  if (currentRole !== 'DRIVER') return;

  await auth.setCustomUserClaims(uid, {
    ...(user.customClaims || {}),
    role: 'CUSTOMER',
    mishwarRole: 'CUSTOMER'
  });
};

const readDriverKyc = async (uid: string): Promise<DriverKycRecord> => {
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const snapshot = await db.doc(`driverKyc/${uid}`).get();
  if (!snapshot.exists) throw new Error('DRIVER_KYC_NOT_FOUND');
  return snapshot.data() as DriverKycRecord;
};

export const approveDriver = async (uid: string, actor: TrustedAdminContext) => {
  if (!uid) throw new Error('DRIVER_UID_REQUIRED');
  if (!canReviewKyc(actor.role)) throw new Error('TRUSTED_ADMIN_REQUIRED');

  const kyc = await readDriverKyc(uid);
  if (!['pending_review', 'needs_resubmission', 'in_progress'].includes(kyc.kycStatus || '')) {
    throw new Error('DRIVER_KYC_NOT_READY');
  }

  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const now = new Date().toISOString();

  await db.doc(`driverKyc/${uid}`).set({
    ...kyc,
    uid,
    driverId: uid,
    kycStatus: 'approved',
    approvedAt: now,
    approvedBy: actor.uid,
    updatedAt: now,
    rejectionReason: null
  }, { merge: true });

  await db.doc(`drivers/${uid}`).set({
    uid,
    id: uid,
    role: 'DRIVER',
    kycStatus: 'approved',
    driverStatus: 'OFFLINE',
    isAcceptingRides: false,
    updatedAt: now
  }, { merge: true });

  await setTrustedRoleClaim(uid, 'DRIVER');
  await auditService.log({
    eventType: 'DRIVER_KYC_APPROVED',
    actorUid: actor.uid,
    actorRole: actor.role,
    actorEmailOrPhone: actor.email || actor.phone || null,
    targetType: 'DRIVER',
    targetId: uid,
    source: 'ADMIN_BACKEND',
    metadata: {
    previousKycStatus: kyc.kycStatus || null,
    grantedRole: 'DRIVER'
    }
  });

  return { uid, role: 'DRIVER' as UserRole, kycStatus: 'approved' as KycStatus };
};

export const rejectDriver = async (uid: string, reason: string, actor: TrustedAdminContext) => {
  if (!uid) throw new Error('DRIVER_UID_REQUIRED');
  if (!reason || !reason.trim()) throw new Error('REJECTION_REASON_REQUIRED');
  if (!canReviewKyc(actor.role)) throw new Error('TRUSTED_ADMIN_REQUIRED');

  const kyc = await readDriverKyc(uid);
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const now = new Date().toISOString();

  await db.doc(`driverKyc/${uid}`).set({
    ...kyc,
    uid,
    driverId: uid,
    kycStatus: 'rejected',
    rejectedAt: now,
    rejectedBy: actor.uid,
    rejectionReason: reason.trim(),
    updatedAt: now
  }, { merge: true });

  await db.doc(`drivers/${uid}`).set({
    uid,
    id: uid,
    role: 'CUSTOMER',
    kycStatus: 'rejected',
    driverStatus: 'PENDING_APPROVAL',
    isAcceptingRides: false,
    rejectionReason: reason.trim(),
    updatedAt: now
  }, { merge: true });

  await clearDriverRoleClaim(uid);
  await auditService.log({
    eventType: 'DRIVER_KYC_REJECTED',
    actorUid: actor.uid,
    actorRole: actor.role,
    actorEmailOrPhone: actor.email || actor.phone || null,
    targetType: 'DRIVER',
    targetId: uid,
    source: 'ADMIN_BACKEND',
    metadata: {
    previousKycStatus: kyc.kycStatus || null,
    reason: reason.trim()
    }
  });

  return { uid, role: 'CUSTOMER' as UserRole, kycStatus: 'rejected' as KycStatus };
};
