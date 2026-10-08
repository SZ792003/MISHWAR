import { AuthErrorReason } from './authTypes';
import { buildApiAuthHeaders } from './apiAuthHeaders';
import { authStateService } from './authStateService';
import { UserRole } from '../../../packages/shared_types/src';
import { arabicSessionMessageByCode, logoutReasonBySessionCode, SessionSecurityCode } from './sessionSecurityPolicy';

const parseErrorCode = async (response: Response): Promise<SessionSecurityCode> => {
  try {
    const payload = await response.clone().json();
    return payload?.error?.code || payload?.code || 'SESSION_INVALID';
  } catch {
    return 'SESSION_INVALID';
  }
};

const handleTerminalAuthError = async (code: SessionSecurityCode) => {
  const reason = logoutReasonBySessionCode[code] as AuthErrorReason | undefined;
  if (!reason) return;
  await authStateService.logout(reason, arabicSessionMessageByCode[code]);
};

export const fetchWithAuth = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  role: UserRole = 'CUSTOMER'
): Promise<Response> => {
  const headers = new Headers(init.headers || {});
  const authHeaders = await buildApiAuthHeaders(role);
  Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value));

  const firstResponse = await fetch(input, { ...init, headers });
  if (firstResponse.status !== 401) {
    if (firstResponse.status === 403) {
      await handleTerminalAuthError(await parseErrorCode(firstResponse));
    }
    return firstResponse;
  }

  const firstCode = await parseErrorCode(firstResponse);
  if (firstCode === 'TOKEN_REVOKED' || firstCode === 'ACCOUNT_DISABLED') {
    await handleTerminalAuthError(firstCode);
    return firstResponse;
  }

  const refreshedToken = await authStateService.refreshIdToken();
  if (!refreshedToken) {
    await handleTerminalAuthError(firstCode);
    return firstResponse;
  }

  headers.set('Authorization', `Bearer ${refreshedToken}`);
  const retryResponse = await fetch(input, { ...init, headers });
  if (retryResponse.status === 401 || retryResponse.status === 403) {
    await handleTerminalAuthError(await parseErrorCode(retryResponse));
  }
  return retryResponse;
};
