import { AuthErrorReason } from './authTypes';

export type SessionSecurityCode =
  | 'AUTH_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'SESSION_INVALID'
  | 'ACCOUNT_BLOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_DISABLED'
  | 'INVALID_AUTH_TOKEN'
  | 'FORBIDDEN'
  | string;

export const logoutReasonBySessionCode: Partial<Record<SessionSecurityCode, AuthErrorReason>> = {
  TOKEN_REVOKED: 'tokenRevoked',
  SESSION_INVALID: 'sessionExpired',
  AUTH_REQUIRED: 'sessionExpired',
  INVALID_AUTH_TOKEN: 'sessionExpired',
  ACCOUNT_BLOCKED: 'accountBlocked',
  ACCOUNT_SUSPENDED: 'accountSuspended',
  ACCOUNT_DISABLED: 'accountDisabled'
};

export const arabicSessionMessageByCode: Partial<Record<SessionSecurityCode, string>> = {
  TOKEN_REVOKED: 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.',
  SESSION_INVALID: 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.',
  AUTH_REQUIRED: 'تحتاج إلى تسجيل الدخول مرة أخرى.',
  INVALID_AUTH_TOKEN: 'جلسة الدخول غير صالحة. سجّل الدخول مرة أخرى.',
  ACCOUNT_BLOCKED: 'تم إيقاف هذا الحساب. تواصل مع الدعم.',
  ACCOUNT_SUSPENDED: 'تم تعليق هذا الحساب مؤقتًا. تواصل مع الدعم.',
  ACCOUNT_DISABLED: 'تم تعطيل هذا الحساب في Firebase. تواصل مع الدعم.'
};

export const shouldForceLogoutForSessionCode = (code: SessionSecurityCode): boolean => {
  return Boolean(logoutReasonBySessionCode[code]);
};
