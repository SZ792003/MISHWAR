import {
  ConfirmationResult,
  RecaptchaVerifier,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { DriverProfile, UserProfile, UserRole } from '../../../packages/shared_types/src';
import { normalizeYemeniPhone } from '../../../packages/shared_utils/src';
import { MOCK_CUSTOMERS, MOCK_DRIVERS } from '../../data/mockData';
import { appConfig } from '../../config/appConfig';
import { auth, db, isFirebaseConfigured } from './firebaseConfig';

const otpRequestTimestamps: Record<string, number[]> = {};

export class AuthService {
  private confirmationResult: ConfirmationResult | null = null;
  private recaptchaVerifier: RecaptchaVerifier | null = null;

  private checkRateLimit(phone: string): boolean {
    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    const history = (otpRequestTimestamps[phone] || []).filter((timestamp) => now - timestamp < windowMs);
    if (history.length >= 3) return false;
    history.push(now);
    otpRequestTimestamps[phone] = history;
    return true;
  }

  async sendPhoneOTP(
    phoneNumber: string,
    recaptchaContainerId: string = 'recaptcha-container'
  ): Promise<{ success: boolean; message: string; isMock: boolean }> {
    const phone = normalizeYemeniPhone(phoneNumber);

    if (!phone.isValid) {
      return {
        success: false,
        message: 'رقم الهاتف غير صحيح. اكتب رقمًا يمنيًا مثل 771234567 أو +967771234567.',
        isMock: false
      };
    }

    if (!this.checkRateLimit(phone.normalized)) {
      return {
        success: false,
        message: 'تم طلب رموز كثيرة خلال وقت قصير. انتظر 5 دقائق ثم حاول مرة أخرى.',
        isMock: false
      };
    }

    if (!isFirebaseConfigured()) {
      if (!appConfig.flags.allowDemoOtp) {
        return {
          success: false,
          message: 'Firebase Phone Auth غير مهيأ بعد. فعّل Phone provider وأضف مفاتيح Firebase قبل استخدام وضع الإنتاج.',
          isMock: false
        };
      }

      return {
        success: true,
        message: 'تم إرسال رمز التحقق التجريبي. استخدم 123456 لإكمال الدخول.',
        isMock: true
      };
    }

    try {
      this.recaptchaVerifier?.clear();
      this.recaptchaVerifier = new RecaptchaVerifier(auth, recaptchaContainerId, {
        size: 'invisible',
        callback: () => {},
        'expired-callback': () => {
          this.recaptchaVerifier = null;
        }
      });

      this.confirmationResult = await signInWithPhoneNumber(auth, phone.normalized, this.recaptchaVerifier);

      return {
        success: true,
        message: `تم إرسال رمز التحقق عبر SMS إلى ${phone.operator}.`,
        isMock: false
      };
    } catch (error) {
      console.error('[MISHWAR Auth] Send OTP Error:', error);
      if (!appConfig.flags.allowDemoOtp) {
        return { success: false, message: this.toArabicFirebaseError(error), isMock: false };
      }

      return {
        success: true,
        message: 'تعذر إرسال SMS الحقيقي، وتم تفعيل رمز التجربة 123456 في وضع Demo.',
        isMock: true
      };
    }
  }

  async verifyPhoneOTP(
    phoneNumber: string,
    otpCode: string,
    role: UserRole = 'CUSTOMER',
    fullNameFallback?: string
  ): Promise<{ success: boolean; user?: UserProfile | DriverProfile; message: string }> {
    if (!/^\d{6}$/.test(otpCode)) {
      return { success: false, message: 'رمز التحقق يجب أن يتكون من 6 أرقام.' };
    }

    const phone = normalizeYemeniPhone(phoneNumber);

    if (this.confirmationResult && isFirebaseConfigured()) {
      try {
        const userCredential = await this.confirmationResult.confirm(otpCode);
        const profile = await this.syncUserProfile(userCredential.user, role, fullNameFallback);
        return { success: true, user: profile, message: 'تم التحقق وتسجيل الدخول بنجاح.' };
      } catch (error) {
        console.warn('[MISHWAR Auth] Live OTP failed:', error);
        if (!appConfig.flags.allowDemoOtp) {
          return { success: false, message: this.toArabicFirebaseError(error) };
        }
      }
    }

    if (appConfig.flags.allowDemoOtp && (otpCode === '123456' || otpCode === '000000')) {
      const cleanDigits = phone.nationalNumber || phoneNumber.replace(/\D/g, '').slice(-9);
      let existing: UserProfile | DriverProfile | undefined = role === 'DRIVER'
        ? MOCK_DRIVERS.find((driver) => driver.phoneNumber.replace(/\D/g, '').includes(cleanDigits.slice(-7)))
        : MOCK_CUSTOMERS.find((customer) => customer.phoneNumber.replace(/\D/g, '').includes(cleanDigits.slice(-7)));

      if (!existing) {
        existing = {
          id: `usr_${Date.now()}`,
          fullName: fullNameFallback || (role === 'DRIVER' ? 'كابتن مشوار الجديد' : 'عميل مشوار'),
          phoneNumber: phone.isValid ? phone.normalized : phoneNumber,
          role,
          isActive: true,
          ratingAverage: 5.0,
          ratingCount: 1,
          walletBalance: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(role === 'DRIVER'
            ? {
                driverStatus: 'PENDING_APPROVAL' as const,
                todayEarnings: 0,
                todayTripsCount: 0,
                isAcceptingRides: false
              }
            : {})
        };
      }

      return { success: true, user: existing, message: 'تم التحقق بنجاح في وضع Demo.' };
    }

    return { success: false, message: 'رمز التحقق غير صحيح أو انتهت صلاحيته. اطلب رمزًا جديدًا وحاول مرة أخرى.' };
  }

  private async syncUserProfile(
    fbUser: FirebaseUser,
    role: UserRole,
    fullNameFallback?: string
  ): Promise<UserProfile> {
    const userDocRef = doc(db, 'users', fbUser.uid);
    const snap = await getDoc(userDocRef);

    if (snap.exists()) {
      return snap.data() as UserProfile;
    }

    const newProfile: UserProfile = {
      id: fbUser.uid,
      fullName: fullNameFallback || fbUser.displayName || 'مستخدم مشوار',
      phoneNumber: fbUser.phoneNumber || '',
      role,
      isActive: true,
      ratingAverage: 5.0,
      ratingCount: 0,
      walletBalance: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await setDoc(userDocRef, newProfile);

    if (role === 'DRIVER') {
      const driverRef = doc(db, 'drivers', fbUser.uid);
      const driverProfile: DriverProfile = {
        ...newProfile,
        driverStatus: 'PENDING_APPROVAL',
        todayEarnings: 0,
        todayTripsCount: 0,
        isAcceptingRides: false
      };
      await setDoc(driverRef, driverProfile);
    }

    return newProfile;
  }

  async loginAdmin(email: string, password: string): Promise<{ success: boolean; message: string }> {
    if (email === 'admin@mishwar-ye.com' && password === 'MishwarAdmin@2026') {
      return { success: true, message: 'تم تسجيل دخول المدير بنجاح.' };
    }

    if (isFirebaseConfigured()) {
      try {
        await signInWithEmailAndPassword(auth, email, password);
        return { success: true, message: 'تم تسجيل الدخول بنجاح.' };
      } catch {
        return { success: false, message: 'بيانات الدخول غير صحيحة.' };
      }
    }

    return { success: false, message: 'بيانات المدير غير صحيحة.' };
  }

  async logout(): Promise<void> {
    if (isFirebaseConfigured()) {
      await signOut(auth);
    }
  }

  private toArabicFirebaseError(error: unknown): string {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : '';
    if (code.includes('invalid-phone-number')) return 'رقم الهاتف غير صحيح. تأكد من كتابة رقم يمني مثل +967771234567.';
    if (code.includes('too-many-requests')) return 'تم حظر المحاولات مؤقتًا بسبب كثرة الطلبات. انتظر قليلًا ثم أعد المحاولة.';
    if (code.includes('invalid-verification-code')) return 'رمز التحقق غير صحيح. تأكد من الأرقام الستة ثم حاول مرة أخرى.';
    if (code.includes('code-expired') || code.includes('session-expired')) return 'انتهت صلاحية رمز التحقق. اضغط إعادة الإرسال للحصول على رمز جديد.';
    if (code.includes('network-request-failed')) return 'تعذر الاتصال بالإنترنت. تحقق من الشبكة ثم حاول مرة أخرى.';
    if (code.includes('captcha-check-failed')) return 'فشل تحقق الحماية. أعد إرسال الرمز وحاول مرة أخرى.';
    return 'تعذر إكمال التحقق عبر Firebase. راجع إعدادات Phone Auth أو حاول لاحقًا.';
  }
}

export const authService = new AuthService();
