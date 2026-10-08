"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.roleFromFirebaseClaims = exports.normalizeTrustedRole = exports.sendAuthError = exports.getFirebaseAdmin = void 0;
exports.requireAuth = requireAuth;
exports.requireRole = requireRole;
const config_1 = require("./config");
let firebaseAdminModule;
const loadFirebaseAdmin = async () => {
    if (firebaseAdminModule !== undefined)
        return firebaseAdminModule;
    try {
        const dynamicImport = new Function('specifier', 'return import(specifier)');
        const imported = await dynamicImport('firebase-admin');
        firebaseAdminModule = imported.default || imported;
    }
    catch {
        firebaseAdminModule = null;
    }
    return firebaseAdminModule;
};
const getFirebaseAdmin = async () => {
    const admin = await loadFirebaseAdmin();
    if (!admin)
        return null;
    if (admin.apps.length > 0)
        return { admin, app: admin.app() };
    if (!config_1.backendConfig.firebaseProjectId) {
        return null;
    }
    const hasServiceAccountEnv = Boolean(config_1.backendConfig.firebaseClientEmail && config_1.backendConfig.firebasePrivateKey);
    const credential = hasServiceAccountEnv
        ? admin.credential.cert({
            projectId: config_1.backendConfig.firebaseProjectId,
            clientEmail: config_1.backendConfig.firebaseClientEmail,
            privateKey: config_1.backendConfig.firebasePrivateKey
        })
        : (0, config_1.isStrictBackend)() || config_1.backendConfig.useRealAuth || config_1.backendConfig.useRealDatabase
            ? admin.credential.applicationDefault?.()
            : null;
    if (!credential) {
        return null;
    }
    const appOptions = {
        credential,
        projectId: config_1.backendConfig.firebaseProjectId
    };
    if (config_1.backendConfig.firebaseStorageBucket) {
        appOptions.storageBucket = config_1.backendConfig.firebaseStorageBucket;
    }
    const app = admin.initializeApp(appOptions);
    return { admin, app };
};
exports.getFirebaseAdmin = getFirebaseAdmin;
const sendAuthError = (res, statusCode, message, code) => {
    return res.status(statusCode).json({
        success: false,
        data: null,
        message,
        error: { code }
    });
};
exports.sendAuthError = sendAuthError;
const extractBearerToken = (req) => {
    const authHeader = req.headers.authorization || '';
    return authHeader.startsWith('Bearer ') ? authHeader.substring('Bearer '.length) : '';
};
const knownRoles = [
    'CUSTOMER',
    'DRIVER',
    'ADMIN',
    'DISPATCHER',
    'SUPPORT',
    'SUPPORT_REVIEWER',
    'OPS_MANAGER',
    'FINANCE',
    'KYC_REVIEWER',
    'SUPER_ADMIN'
];
const roleAliases = {
    PASSENGER: 'CUSTOMER',
    CUSTOMER: 'CUSTOMER',
    DRIVER: 'DRIVER',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER',
    SUPPORT: 'SUPPORT',
    SUPPORT_REVIEWER: 'SUPPORT_REVIEWER',
    SUPPORTREVIEWER: 'SUPPORT_REVIEWER',
    OPS_MANAGER: 'OPS_MANAGER',
    OPSMANAGER: 'OPS_MANAGER',
    FINANCE: 'FINANCE',
    KYC_REVIEWER: 'KYC_REVIEWER',
    KYCREVIEWER: 'KYC_REVIEWER',
    SUPER_ADMIN: 'SUPER_ADMIN',
    SUPERADMIN: 'SUPER_ADMIN'
};
const normalizeTrustedRole = (value) => {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().replace(/-/g, '_').toUpperCase();
    if (knownRoles.includes(normalized))
        return normalized;
    return roleAliases[normalized] || null;
};
exports.normalizeTrustedRole = normalizeTrustedRole;
const roleFromFirebaseClaims = (decoded) => {
    const claimRole = decoded.role || decoded.mishwarRole;
    return (0, exports.normalizeTrustedRole)(claimRole) || 'CUSTOMER';
};
exports.roleFromFirebaseClaims = roleFromFirebaseClaims;
const normalizeAccountStatus = (value) => {
    return value === 'blocked' || value === 'suspended' ? value : 'active';
};
const accountStatusForUid = async (firebaseAdmin, uid) => {
    const snapshot = await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`users/${uid}`).get();
    if (!snapshot.exists)
        return 'active';
    return normalizeAccountStatus(snapshot.data()?.accountStatus);
};
const authErrorCodeFromFirebase = (error) => {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code.includes('id-token-revoked'))
        return 'TOKEN_REVOKED';
    if (code.includes('id-token-expired'))
        return 'TOKEN_EXPIRED';
    if (code.includes('user-disabled'))
        return 'ACCOUNT_DISABLED';
    return 'INVALID_AUTH_TOKEN';
};
async function requireAuth(req, res, next) {
    const token = extractBearerToken(req);
    const firebaseAdmin = await (0, exports.getFirebaseAdmin)();
    if (firebaseAdmin && token) {
        try {
            const decoded = await firebaseAdmin.admin.auth(firebaseAdmin.app).verifyIdToken(token, true);
            const uid = String(decoded.uid);
            const firebaseUser = await firebaseAdmin.admin.auth(firebaseAdmin.app).getUser(uid);
            if (firebaseUser.disabled) {
                return (0, exports.sendAuthError)(res, 403, 'This Firebase user is disabled', 'ACCOUNT_DISABLED');
            }
            const accountStatus = await accountStatusForUid(firebaseAdmin, uid);
            if (accountStatus === 'blocked') {
                return (0, exports.sendAuthError)(res, 403, 'This account is blocked', 'ACCOUNT_BLOCKED');
            }
            if (accountStatus === 'suspended') {
                return (0, exports.sendAuthError)(res, 403, 'This account is suspended', 'ACCOUNT_SUSPENDED');
            }
            req.user = {
                uid,
                role: (0, exports.roleFromFirebaseClaims)(decoded),
                phone: decoded.phone_number,
                email: decoded.email,
                accountStatus,
                authSource: 'firebase'
            };
            return next();
        }
        catch (error) {
            const code = authErrorCodeFromFirebase(error);
            const status = code === 'TOKEN_REVOKED' || code === 'TOKEN_EXPIRED' || code === 'INVALID_AUTH_TOKEN' ? 401 : 403;
            return (0, exports.sendAuthError)(res, status, 'Invalid authentication session', code);
        }
    }
    if (!(0, config_1.isStrictBackend)() && config_1.backendConfig.apiToken && token === config_1.backendConfig.apiToken) {
        req.user = {
            uid: req.headers['x-user-id'] || 'demo_user',
            role: (0, exports.normalizeTrustedRole)(req.headers['x-user-role']) || 'CUSTOMER',
            authSource: 'demo'
        };
        return next();
    }
    if (!(0, config_1.isStrictBackend)() && !config_1.backendConfig.apiToken) {
        req.user = {
            uid: req.headers['x-user-id'] || 'demo_user',
            role: (0, exports.normalizeTrustedRole)(req.headers['x-user-role']) || 'CUSTOMER',
            authSource: 'demo'
        };
        return next();
    }
    return (0, exports.sendAuthError)(res, 401, 'Authentication is required', 'AUTH_REQUIRED');
}
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return (0, exports.sendAuthError)(res, 401, 'Authentication is required', 'AUTH_REQUIRED');
        }
        if (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN' || roles.includes(req.user.role)) {
            return next();
        }
        return (0, exports.sendAuthError)(res, 403, 'Forbidden for this role', 'FORBIDDEN');
    };
}
