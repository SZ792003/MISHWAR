"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rejectDriver = exports.approveDriver = exports.clearDriverRoleClaim = exports.setTrustedRoleClaim = exports.requireTrustedAdminContext = exports.canReviewKyc = exports.isPrivilegedAdminRole = void 0;
const auditService_1 = require("./auditService");
const auth_1 = require("./auth");
const adminRoles = ['ADMIN', 'SUPER_ADMIN', 'KYC_REVIEWER'];
const isPrivilegedAdminRole = (role) => {
    return role === 'ADMIN' || role === 'SUPER_ADMIN';
};
exports.isPrivilegedAdminRole = isPrivilegedAdminRole;
const canReviewKyc = (role) => {
    return adminRoles.includes(role);
};
exports.canReviewKyc = canReviewKyc;
const requireTrustedAdminContext = (req) => {
    if (!req.user || !(0, exports.canReviewKyc)(req.user.role)) {
        throw new Error('TRUSTED_ADMIN_REQUIRED');
    }
    return {
        uid: req.user.uid,
        role: req.user.role,
        email: req.user.email,
        phone: req.user.phone
    };
};
exports.requireTrustedAdminContext = requireTrustedAdminContext;
const setTrustedRoleClaim = async (uid, role) => {
    const normalizedRole = (0, auth_1.normalizeTrustedRole)(role);
    if (!normalizedRole)
        throw new Error('INVALID_ROLE');
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
    const auth = firebaseAdmin.admin.auth(firebaseAdmin.app);
    const user = await auth.getUser(uid);
    await auth.setCustomUserClaims(uid, {
        ...(user.customClaims || {}),
        role: normalizedRole,
        mishwarRole: normalizedRole
    });
};
exports.setTrustedRoleClaim = setTrustedRoleClaim;
const clearDriverRoleClaim = async (uid) => {
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
    const auth = firebaseAdmin.admin.auth(firebaseAdmin.app);
    const user = await auth.getUser(uid);
    const currentRole = (0, auth_1.normalizeTrustedRole)(user.customClaims?.role || user.customClaims?.mishwarRole);
    if (currentRole !== 'DRIVER')
        return;
    await auth.setCustomUserClaims(uid, {
        ...(user.customClaims || {}),
        role: 'CUSTOMER',
        mishwarRole: 'CUSTOMER'
    });
};
exports.clearDriverRoleClaim = clearDriverRoleClaim;
const readDriverKyc = async (uid) => {
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
    const snapshot = await db.doc(`driverKyc/${uid}`).get();
    if (!snapshot.exists)
        throw new Error('DRIVER_KYC_NOT_FOUND');
    return snapshot.data();
};
const approveDriver = async (uid, actor) => {
    if (!uid)
        throw new Error('DRIVER_UID_REQUIRED');
    if (!(0, exports.canReviewKyc)(actor.role))
        throw new Error('TRUSTED_ADMIN_REQUIRED');
    const kyc = await readDriverKyc(uid);
    if (!['pending_review', 'needs_resubmission', 'in_progress'].includes(kyc.kycStatus || '')) {
        throw new Error('DRIVER_KYC_NOT_READY');
    }
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
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
    await (0, exports.setTrustedRoleClaim)(uid, 'DRIVER');
    await auditService_1.auditService.log({
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
    return { uid, role: 'DRIVER', kycStatus: 'approved' };
};
exports.approveDriver = approveDriver;
const rejectDriver = async (uid, reason, actor) => {
    if (!uid)
        throw new Error('DRIVER_UID_REQUIRED');
    if (!reason || !reason.trim())
        throw new Error('REJECTION_REASON_REQUIRED');
    if (!(0, exports.canReviewKyc)(actor.role))
        throw new Error('TRUSTED_ADMIN_REQUIRED');
    const kyc = await readDriverKyc(uid);
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
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
    await (0, exports.clearDriverRoleClaim)(uid);
    await auditService_1.auditService.log({
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
    return { uid, role: 'CUSTOMER', kycStatus: 'rejected' };
};
exports.rejectDriver = rejectDriver;
