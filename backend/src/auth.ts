import { NextFunction, Request, Response } from 'express';
import { AccountStatus, UserRole } from '../../packages/shared_types/src';
import { backendConfig, isStrictBackend } from './config';

export interface AuthenticatedRequest extends Request {
  requestId?: string;
  user?: {
    uid: string;
    role: UserRole;
    phone?: string;
    email?: string;
    accountStatus?: AccountStatus;
    authSource: 'firebase' | 'demo';
  };
}

type FirebaseAdminModule = {
  apps: unknown[];
  app: () => unknown;
  initializeApp: (options: unknown) => unknown;
  credential: {
    cert: (options: { projectId: string; clientEmail: string; privateKey: string }) => unknown;
    applicationDefault?: () => unknown;
  };
  auth: (app?: unknown) => {
    verifyIdToken: (token: string, checkRevoked?: boolean) => Promise<Record<string, unknown>>;
    getUser: (uid: string) => Promise<{ customClaims?: Record<string, unknown>; disabled?: boolean; tokensValidAfterTime?: string }>;
    setCustomUserClaims: (uid: string, claims: Record<string, unknown>) => Promise<void>;
    revokeRefreshTokens: (uid: string) => Promise<void>;
  };
  firestore: (app?: unknown) => FirebaseFirestoreLike;
  messaging?: (app?: unknown) => unknown;
};

type FirebaseDocumentSnapshotLike = {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
};

type FirebaseDocumentReferenceLike = {
  get: () => Promise<FirebaseDocumentSnapshotLike>;
  set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<unknown>;
  update: (data: Record<string, unknown>) => Promise<unknown>;
};

type FirebaseCollectionReferenceLike = {
  doc: (path?: string) => FirebaseDocumentReferenceLike;
};

type FirebaseFirestoreLike = {
  doc: (path: string) => FirebaseDocumentReferenceLike;
  collection: (path: string) => FirebaseCollectionReferenceLike;
};

let firebaseAdminModule: FirebaseAdminModule | null | undefined;

const loadFirebaseAdmin = async (): Promise<FirebaseAdminModule | null> => {
  if (firebaseAdminModule !== undefined) return firebaseAdminModule;
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ default?: FirebaseAdminModule } & FirebaseAdminModule>;
    const imported = await dynamicImport('firebase-admin');
    firebaseAdminModule = imported.default || imported;
  } catch {
    firebaseAdminModule = null;
  }
  return firebaseAdminModule;
};

export const getFirebaseAdmin = async (): Promise<{ admin: FirebaseAdminModule; app: unknown } | null> => {
  const admin = await loadFirebaseAdmin();
  if (!admin) return null;
  if (admin.apps.length > 0) return { admin, app: admin.app() };
  if (!backendConfig.firebaseProjectId) {
    return null;
  }

  const hasServiceAccountEnv = Boolean(backendConfig.firebaseClientEmail && backendConfig.firebasePrivateKey);
  const credential = hasServiceAccountEnv
    ? admin.credential.cert({
      projectId: backendConfig.firebaseProjectId,
      clientEmail: backendConfig.firebaseClientEmail,
      privateKey: backendConfig.firebasePrivateKey
    })
    : isStrictBackend() || backendConfig.useRealAuth || backendConfig.useRealDatabase
      ? admin.credential.applicationDefault?.()
      : null;

  if (!credential) {
    return null;
  }

  const appOptions: Record<string, unknown> = {
    credential,
    projectId: backendConfig.firebaseProjectId
  };
  if (backendConfig.firebaseStorageBucket) {
    appOptions.storageBucket = backendConfig.firebaseStorageBucket;
  }

  const app = admin.initializeApp(appOptions);
  return { admin, app };
};

export const sendAuthError = (res: Response, statusCode: number, message: string, code: string) => {
  return res.status(statusCode).json({
    success: false,
    data: null,
    message,
    error: { code }
  });
};

const extractBearerToken = (req: Request): string => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.substring('Bearer '.length) : '';
};

const knownRoles: UserRole[] = [
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

const roleAliases: Record<string, UserRole> = {
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

export const normalizeTrustedRole = (value: unknown): UserRole | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/-/g, '_').toUpperCase();
  if (knownRoles.includes(normalized as UserRole)) return normalized as UserRole;
  return roleAliases[normalized] || null;
};

export const roleFromFirebaseClaims = (decoded: Record<string, unknown>): UserRole => {
  const claimRole = decoded.role || decoded.mishwarRole;
  return normalizeTrustedRole(claimRole) || 'CUSTOMER';
};

const normalizeAccountStatus = (value: unknown): AccountStatus => {
  return value === 'blocked' || value === 'suspended' ? value : 'active';
};

const accountStatusForUid = async (
  firebaseAdmin: { admin: FirebaseAdminModule; app: unknown },
  uid: string
): Promise<AccountStatus> => {
  const snapshot = await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`users/${uid}`).get();
  if (!snapshot.exists) return 'active';
  return normalizeAccountStatus(snapshot.data()?.accountStatus);
};

const authErrorCodeFromFirebase = (error: unknown): string => {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : '';
  if (code.includes('id-token-revoked')) return 'TOKEN_REVOKED';
  if (code.includes('id-token-expired')) return 'TOKEN_EXPIRED';
  if (code.includes('user-disabled')) return 'ACCOUNT_DISABLED';
  return 'INVALID_AUTH_TOKEN';
};

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);

  const firebaseAdmin = await getFirebaseAdmin();
  if (firebaseAdmin && token) {
    try {
      const decoded = await firebaseAdmin.admin.auth(firebaseAdmin.app).verifyIdToken(token, true);
      const uid = String(decoded.uid);
      const firebaseUser = await firebaseAdmin.admin.auth(firebaseAdmin.app).getUser(uid);
      if (firebaseUser.disabled) {
        return sendAuthError(res, 403, 'This Firebase user is disabled', 'ACCOUNT_DISABLED');
      }
      const accountStatus = await accountStatusForUid(firebaseAdmin, uid);
      if (accountStatus === 'blocked') {
        return sendAuthError(res, 403, 'This account is blocked', 'ACCOUNT_BLOCKED');
      }
      if (accountStatus === 'suspended') {
        return sendAuthError(res, 403, 'This account is suspended', 'ACCOUNT_SUSPENDED');
      }
      req.user = {
        uid,
        role: roleFromFirebaseClaims(decoded),
        phone: decoded.phone_number as string | undefined,
        email: decoded.email as string | undefined,
        accountStatus,
        authSource: 'firebase'
      };
      return next();
    } catch (error) {
      const code = authErrorCodeFromFirebase(error);
      const status = code === 'TOKEN_REVOKED' || code === 'TOKEN_EXPIRED' || code === 'INVALID_AUTH_TOKEN' ? 401 : 403;
      return sendAuthError(res, status, 'Invalid authentication session', code);
    }
  }

  if (!isStrictBackend() && backendConfig.apiToken && token === backendConfig.apiToken) {
    req.user = {
      uid: (req.headers['x-user-id'] as string | undefined) || 'demo_user',
      role: normalizeTrustedRole(req.headers['x-user-role']) || 'CUSTOMER',
      authSource: 'demo'
    };
    return next();
  }

  if (!isStrictBackend() && !backendConfig.apiToken) {
    req.user = {
      uid: (req.headers['x-user-id'] as string | undefined) || 'demo_user',
      role: normalizeTrustedRole(req.headers['x-user-role']) || 'CUSTOMER',
      authSource: 'demo'
    };
    return next();
  }

  return sendAuthError(res, 401, 'Authentication is required', 'AUTH_REQUIRED');
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return sendAuthError(res, 401, 'Authentication is required', 'AUTH_REQUIRED');
    }
    if (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN' || roles.includes(req.user.role)) {
      return next();
    }
    return sendAuthError(res, 403, 'Forbidden for this role', 'FORBIDDEN');
  };
}
