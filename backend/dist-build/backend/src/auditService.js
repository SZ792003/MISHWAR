"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditService = exports.AuditService = exports.auditActorFromRequest = void 0;
const auth_1 = require("./auth");
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
const isSensitiveKey = (key) => {
    const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
    return secretKeyHints.some((hint) => normalized.includes(hint));
};
const sanitizeMetadata = (value) => {
    if (Array.isArray(value))
        return value.map(sanitizeMetadata);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !isSensitiveKey(key))
        .map(([key, entry]) => [key, sanitizeMetadata(entry)]));
};
const serverTimestamp = (firebaseAdmin) => {
    const firestoreNamespace = firebaseAdmin.admin.firestore;
    return firestoreNamespace.FieldValue?.serverTimestamp() || new Date().toISOString();
};
const auditActorFromRequest = (req) => ({
    actorUid: req.user?.uid || 'anonymous',
    actorRole: req.user?.role || 'UNKNOWN',
    actorEmailOrPhone: req.user?.email || req.user?.phone || null,
    requestId: req.requestId
});
exports.auditActorFromRequest = auditActorFromRequest;
class AuditService {
    build(input, timestamp = new Date().toISOString()) {
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
    async log(input) {
        const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
        if (!firebaseAdmin)
            throw new Error('AUDIT_LOG_UNAVAILABLE');
        const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
        const entry = this.build(input, serverTimestamp(firebaseAdmin));
        await db.collection('auditLogs').doc(String(entry.id)).set(entry);
    }
    logInTransaction(tx, db, input, timestamp = new Date().toISOString()) {
        const entry = this.build(input, timestamp);
        tx.set(db.doc(`auditLogs/${entry.id}`), entry);
    }
}
exports.AuditService = AuditService;
exports.auditService = new AuditService();
