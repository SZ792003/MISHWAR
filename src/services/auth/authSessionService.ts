import { DriverProfile, UserProfile, UserRole } from '../../../packages/shared_types/src';
import { authService as demoAuthService, UserSession } from '../authService';
import { authService as firebaseAuthService } from '../firebase/authService';
import { appConfig } from '../../config/appConfig';
import { authStateService } from './authStateService';
import { AuthErrorReason } from './authTypes';

export interface VerifyPhoneOtpResult {
  success: boolean;
  user?: UserProfile | DriverProfile;
  message: string;
  session?: UserSession;
}

export interface SendPhoneOtpResult {
  success: boolean;
  message: string;
  isMock?: boolean;
  operator?: string;
  expiresSecs?: number;
}

class AuthSessionService {
  async verifyPhoneOTP(
    phone: string,
    otp: string,
    role: UserRole,
    fullName?: string
  ): Promise<VerifyPhoneOtpResult> {
    if (appConfig.flags.useRealAuth) {
      const result = await firebaseAuthService.verifyPhoneOTP(phone, otp, role, fullName);
      return {
        success: result.success,
        user: result.user,
        message: result.message
      };
    }

    return demoAuthService.verifyOTP(phone, otp, role);
  }

  async sendPhoneOTP(phone: string, recaptchaContainerId?: string): Promise<SendPhoneOtpResult> {
    if (appConfig.flags.useRealAuth) {
      return firebaseAuthService.sendPhoneOTP(phone, recaptchaContainerId);
    }

    return demoAuthService.sendOTP(phone);
  }

  async refreshSessionToken(): Promise<string | null> {
    return authStateService.refreshIdToken();
  }

  async logout(reason: AuthErrorReason = 'signedOut', message?: string): Promise<void> {
    await authStateService.logout(reason, message);
  }
}

export const authSessionService = new AuthSessionService();
