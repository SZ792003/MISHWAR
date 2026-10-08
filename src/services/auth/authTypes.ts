import { UserRole } from '../../../packages/shared_types/src';

export type AuthMode = 'demo' | 'production';
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';
export type AuthErrorReason =
  | 'signedOut'
  | 'sessionExpired'
  | 'tokenRevoked'
  | 'accountBlocked'
  | 'accountSuspended'
  | 'accountDisabled'
  | 'authRequired';

export interface AuthenticatedUser {
  uid: string;
  role?: UserRole;
  phoneNumber?: string;
  email?: string;
  idToken?: string;
}

export interface AuthState {
  mode: AuthMode;
  status: AuthStatus;
  user: AuthenticatedUser | null;
  reason?: AuthErrorReason;
  message?: string;
}

export const unauthenticatedAuthState = (
  mode: AuthMode,
  reason?: AuthErrorReason,
  message?: string
): AuthState => ({
  mode,
  status: 'unauthenticated',
  user: null,
  reason,
  message
});
