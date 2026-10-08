"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suspendUser = exports.unblockUser = exports.blockUser = exports.auditSessionRevocation = exports.revokeUserSessions = exports.requireAccountAdmin = void 0;
const auditService_1 = require("./auditService");
const auth_1 = require("./auth");
const trustedRoles_1 = require("./trustedRoles");
const requireAccountAdmin = (req) => {
    if (!req.user || !(0, trustedRoles_1.isPrivilegedAdminRole)(req.user.role)) {
        throw new Error('TRUSTED_ADMIN_REQUIRED');
    }
    return {
        uid: req.user.uid,
        role: req.user.role,
        email: req.user.email,
        phone: req.user.phone
    };
};
exports.requireAccountAdmin = requireAccountAdmin;
const getAdminContext = async () => {
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
    return firebaseAdmin;
};
const writeUserAccountStatus = async (uid, accountStatus, actor, reason) => {
    if (!uid)
        throw new Error('USER_UID_REQUIRED');
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
    const eventTypeByStatus = {
        active: 'USER_UNBLOCKED',
        blocked: 'USER_BLOCKED',
        suspended: 'USER_SUSPENDED'
    };
    await auditService_1.auditService.log({
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
const revokeUserSessions = async (uid) => {
    if (!uid)
        throw new Error('USER_UID_REQUIRED');
    const firebaseAdmin = await getAdminContext();
    await firebaseAdmin.admin.auth(firebaseAdmin.app).revokeRefreshTokens(uid);
    return { uid, revokedAt: new Date().toISOString() };
};
exports.revokeUserSessions = revokeUserSessions;
const auditSessionRevocation = async (uid, actor, revokedAt) => {
    await auditService_1.auditService.log({
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
exports.auditSessionRevocation = auditSessionRevocation;
const blockUser = async (uid, actor, reason) => {
    await writeUserAccountStatus(uid, 'blocked', actor, reason);
    const revocation = await (0, exports.revokeUserSessions)(uid);
    await (0, exports.auditSessionRevocation)(uid, actor, revocation.revokedAt);
    return { uid, accountStatus: 'blocked', sessionsRevokedAt: revocation.revokedAt };
};
exports.blockUser = blockUser;
const unblockUser = async (uid, actor, reason) => {
    await writeUserAccountStatus(uid, 'active', actor, reason);
    return { uid, accountStatus: 'active', requiresNewLogin: true };
};
exports.unblockUser = unblockUser;
const suspendUser = async (uid, actor, reason) => {
    await writeUserAccountStatus(uid, 'suspended', actor, reason);
    const revocation = await (0, exports.revokeUserSessions)(uid);
    await (0, exports.auditSessionRevocation)(uid, actor, revocation.revokedAt);
    return { uid, accountStatus: 'suspended', sessionsRevokedAt: revocation.revokedAt };
};
exports.suspendUser = suspendUser;
