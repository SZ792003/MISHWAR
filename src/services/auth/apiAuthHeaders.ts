import { UserRole } from '../../../packages/shared_types/src';
import { appConfig } from '../../config/appConfig';
import { authStateService } from './authStateService';

const demoUserIdForRole = (role: UserRole): string => {
  if (role === 'DRIVER') return 'demo_driver';
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return 'demo_admin';
  return 'demo_customer';
};

export const buildApiAuthHeaders = async (role: UserRole): Promise<Record<string, string>> => {
  const token = await authStateService.getIdToken();

  if (appConfig.flags.useRealAuth) {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  return {
    'x-user-id': demoUserIdForRole(role),
    'x-user-role': role,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
};
