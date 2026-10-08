import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { DriverProfile, UserProfile } from '../../packages/shared_types/src';
import { normalizeYemeniPhone } from '../../packages/shared_utils/src';
import { appConfig } from '../config/appConfig';
import { auth, isFirebaseConfigured, storage } from './firebase/firebaseConfig';
import { fetchWithAuth } from './auth/apiClient';

export interface PassengerProfileUpdateInput {
  displayName: string;
  profilePhoto?: File | null;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
}

export interface DriverProfileUpdateInput {
  displayName: string;
  profilePhoto?: File | null;
  vehicleColor?: string;
  plateNumber?: string;
}

type ServiceResult<T> = { success: true; data: T; message: string } | { success: false; message: string };

export const PROFILE_IMAGE_POLICY = {
  allowedImageTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxImageBytes: 5 * 1024 * 1024
};

const sanitizeText = (value: string, maxLength: number): string => value.replace(/[<>]/g, '').trim().slice(0, maxLength);

const validateDisplayName = (displayName: string): string | null => {
  const normalized = sanitizeText(displayName, 80);
  if (normalized.length < 3) return 'الاسم غير صالح. اكتب اسمًا واضحًا لا يقل عن 3 أحرف.';
  return null;
};

export const validateProfileImageFile = (file?: Pick<File, 'type' | 'size'> | null): string | null => {
  if (!file) return null;
  if (!PROFILE_IMAGE_POLICY.allowedImageTypes.includes(file.type)) return 'نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WEBP.';
  if (file.size > PROFILE_IMAGE_POLICY.maxImageBytes) return 'حجم الصورة كبير. الحد الأقصى 5MB.';
  return null;
};

const uploadProfilePhoto = async (file?: File | null): Promise<string | undefined> => {
  if (!file) return undefined;
  const uid = auth.currentUser?.uid;
  if (!isFirebaseConfigured() || !uid) return undefined;
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `users/${uid}/profile/${Date.now()}-${safeName}`;
  const target = ref(storage, storagePath);
  await uploadBytes(target, file, { contentType: file.type });
  return getDownloadURL(target);
};

const parseApiMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.clone().json();
    return payload?.message || payload?.error?.message || fallback;
  } catch {
    return fallback;
  }
};

class ProfileService {
  async updatePassengerProfile(
    input: PassengerProfileUpdateInput,
    fallbackProfile: UserProfile
  ): Promise<ServiceResult<UserProfile>> {
    const nameError = validateDisplayName(input.displayName);
    if (nameError) return { success: false, message: nameError };
    const imageError = validateProfileImageFile(input.profilePhoto);
    if (imageError) return { success: false, message: imageError };

    const emergencyPhone = input.emergencyContactPhone?.trim();
    const emergencyPhoneResult = emergencyPhone ? normalizeYemeniPhone(emergencyPhone) : null;
    if (emergencyPhoneResult && !emergencyPhoneResult.isValid) {
      return { success: false, message: 'رقم جهة الطوارئ غير صالح.' };
    }

    const profilePhotoUrl = await uploadProfilePhoto(input.profilePhoto);
    const payload = {
      displayName: sanitizeText(input.displayName, 80),
      ...(profilePhotoUrl ? { profilePhotoUrl } : {}),
      emergencyContact: {
        ...(input.emergencyContactName?.trim() ? { name: sanitizeText(input.emergencyContactName, 80) } : {}),
        ...(emergencyPhoneResult?.isValid ? { phoneNumber: emergencyPhoneResult.normalized } : {})
      }
    };

    if (!appConfig.flags.useRealAuth) {
      const updated = {
        ...fallbackProfile,
        fullName: payload.displayName,
        displayName: payload.displayName,
        avatarUrl: profilePhotoUrl || fallbackProfile.avatarUrl,
        profilePhotoUrl: profilePhotoUrl || fallbackProfile.profilePhotoUrl,
        emergencyContact: payload.emergencyContact,
        updatedAt: new Date().toISOString()
      };
      return { success: true, data: updated, message: 'تم تحديث الملف الشخصي في وضع Demo.' };
    }

    const response = await fetchWithAuth(`${appConfig.apiBaseUrl}/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 'CUSTOMER');
    if (!response.ok) return { success: false, message: await parseApiMessage(response, 'تعذر تحديث الملف الشخصي.') };
    const body = await response.json();
    return { success: true, data: body.data as UserProfile, message: 'تم تحديث الملف الشخصي بنجاح.' };
  }

  async updateDriverProfile(
    input: DriverProfileUpdateInput,
    fallbackDriver: DriverProfile
  ): Promise<ServiceResult<DriverProfile>> {
    const nameError = validateDisplayName(input.displayName);
    if (nameError) return { success: false, message: nameError };
    const imageError = validateProfileImageFile(input.profilePhoto);
    if (imageError) return { success: false, message: imageError };

    const vehicleColor = input.vehicleColor ? sanitizeText(input.vehicleColor, 40) : undefined;
    const plateNumber = input.plateNumber ? sanitizeText(input.plateNumber, 40) : undefined;
    if (vehicleColor !== undefined && vehicleColor.length < 2) return { success: false, message: 'لون المركبة غير صالح.' };
    if (plateNumber !== undefined && plateNumber.length < 3) return { success: false, message: 'رقم اللوحة غير صالح.' };

    const profilePhotoUrl = await uploadProfilePhoto(input.profilePhoto);
    const payload = {
      displayName: sanitizeText(input.displayName, 80),
      ...(profilePhotoUrl ? { profilePhotoUrl } : {}),
      vehicle: {
        ...(vehicleColor ? { color: vehicleColor } : {}),
        ...(plateNumber ? { plateNumber } : {})
      }
    };
    const plateChanged = Boolean(plateNumber && plateNumber !== fallbackDriver.vehicle?.plateNumber);

    if (!appConfig.flags.useRealAuth) {
      const updated: DriverProfile = {
        ...fallbackDriver,
        fullName: payload.displayName,
        displayName: payload.displayName,
        avatarUrl: profilePhotoUrl || fallbackDriver.avatarUrl,
        profilePhotoUrl: profilePhotoUrl || fallbackDriver.profilePhotoUrl,
        vehicle: fallbackDriver.vehicle ? { ...fallbackDriver.vehicle, ...payload.vehicle } : fallbackDriver.vehicle,
        ...(plateChanged ? { kycStatus: 'needs_resubmission', driverStatus: 'PENDING_APPROVAL', isAcceptingRides: false } : {}),
        updatedAt: new Date().toISOString()
      };
      return {
        success: true,
        data: updated,
        message: plateChanged
          ? 'تم تحديث اللوحة. يحتاج ملف الكابتن إلى إعادة مراجعة.'
          : 'تم تحديث ملف الكابتن في وضع Demo.'
      };
    }

    const response = await fetchWithAuth(`${appConfig.apiBaseUrl}/driver/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 'DRIVER');
    if (!response.ok) return { success: false, message: await parseApiMessage(response, 'تعذر تحديث ملف الكابتن.') };
    const body = await response.json();
    return {
      success: true,
      data: body.data as DriverProfile,
      message: plateChanged
        ? 'تم تحديث اللوحة. يحتاج ملف الكابتن إلى إعادة مراجعة.'
        : 'تم تحديث ملف الكابتن بنجاح.'
    };
  }
}

export const profileService = new ProfileService();
