import { DriverProfile, KycStatus, UserProfile } from '../../packages/shared_types/src';
import { normalizeYemeniPhone } from '../../packages/shared_utils/src';
import { getFirebaseAdmin } from './auth';

type ValidationResult<T> = { valid: true; data: T; sensitiveVehicleChange?: boolean } | { valid: false; message: string; code: string };

export type PassengerProfilePatch = {
  displayName?: string;
  profilePhotoUrl?: string;
  emergencyContact?: {
    name?: string;
    phoneNumber?: string;
  };
};

export type DriverProfilePatch = {
  displayName?: string;
  profilePhotoUrl?: string;
  vehicle?: {
    color?: string;
    plateNumber?: string;
  };
};

const forbiddenProfileFields = [
  'uid',
  'id',
  'role',
  'accountStatus',
  'onboardingStatus',
  'kycStatus',
  'claims',
  'customClaims',
  'createdAt',
  'updatedBy',
  'phoneNumber',
  'nationalIdNumber',
  'drivingLicenseNumber',
  'approvedAt',
  'approvedBy',
  'reviewedBy'
];

const hasForbiddenField = (value: Record<string, unknown>): string | null => {
  return forbiddenProfileFields.find((field) => Object.prototype.hasOwnProperty.call(value, field)) || null;
};

const sanitizeText = (value: string, maxLength: number): string => {
  return value.replace(/[<>]/g, '').trim().slice(0, maxLength);
};

const validateName = (value: unknown): { valid: true; value: string } | { valid: false; message: string; code: string } => {
  if (typeof value !== 'string') return { valid: false, message: 'الاسم غير صالح.', code: 'INVALID_DISPLAY_NAME' };
  const sanitized = sanitizeText(value, 80);
  if (sanitized.length < 3) return { valid: false, message: 'اكتب اسمًا واضحًا لا يقل عن 3 أحرف.', code: 'INVALID_DISPLAY_NAME' };
  return { valid: true, value: sanitized };
};

const validateOptionalUrl = (value: unknown): { valid: true; value?: string } | { valid: false; message: string; code: string } => {
  if (value === undefined || value === null || value === '') return { valid: true };
  if (typeof value !== 'string' || value.length > 600) {
    return { valid: false, message: 'رابط الصورة غير صالح.', code: 'INVALID_PROFILE_PHOTO' };
  }
  const trimmed = value.trim();
  if (!/^https?:\/\//.test(trimmed) && !/^users\/[^/]+\/profile\//.test(trimmed)) {
    return { valid: false, message: 'رابط الصورة غير صالح.', code: 'INVALID_PROFILE_PHOTO' };
  }
  return { valid: true, value: trimmed };
};

const profilePhotoBelongsToUser = (uid: string, profilePhotoUrl?: string): boolean => {
  if (!profilePhotoUrl) return true;
  return /^https?:\/\//.test(profilePhotoUrl) || profilePhotoUrl.startsWith(`users/${uid}/profile/`);
};

const validateOptionalEmergencyContact = (value: unknown): ValidationResult<PassengerProfilePatch['emergencyContact']> => {
  if (value === undefined || value === null) return { valid: true, data: undefined };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, message: 'بيانات جهة الطوارئ غير صالحة.', code: 'INVALID_EMERGENCY_CONTACT' };
  }
  const input = value as Record<string, unknown>;
  const name = typeof input.name === 'string' ? sanitizeText(input.name, 80) : '';
  const rawPhone = typeof input.phoneNumber === 'string' ? input.phoneNumber : '';
  const phone = rawPhone.trim() ? normalizeYemeniPhone(rawPhone) : null;
  if (name && name.length < 3) return { valid: false, message: 'اسم جهة الطوارئ قصير جدًا.', code: 'INVALID_EMERGENCY_CONTACT' };
  if (phone && !phone.isValid) return { valid: false, message: 'رقم جهة الطوارئ غير صالح.', code: 'INVALID_EMERGENCY_PHONE' };
  return {
    valid: true,
    data: {
      ...(name ? { name } : {}),
      ...(phone?.isValid ? { phoneNumber: phone.normalized } : {})
    }
  };
};

export const validatePassengerProfilePatch = (body: Record<string, unknown>): ValidationResult<PassengerProfilePatch> => {
  const forbidden = hasForbiddenField(body);
  if (forbidden) return { valid: false, message: `لا يمكن تعديل الحقل ${forbidden} من صفحة الملف الشخصي.`, code: 'FORBIDDEN_PROFILE_FIELD' };

  const patch: PassengerProfilePatch = {};
  if (body.displayName !== undefined) {
    const displayName = validateName(body.displayName);
    if (!displayName.valid) return displayName;
    patch.displayName = displayName.value;
  }
  if (body.profilePhotoUrl !== undefined) {
    const profilePhotoUrl = validateOptionalUrl(body.profilePhotoUrl);
    if (!profilePhotoUrl.valid) return profilePhotoUrl;
    patch.profilePhotoUrl = profilePhotoUrl.value;
  }
  if (body.emergencyContact !== undefined) {
    const emergencyContact = validateOptionalEmergencyContact(body.emergencyContact);
    if (!emergencyContact.valid) return emergencyContact;
    patch.emergencyContact = emergencyContact.data;
  }
  return { valid: true, data: patch };
};

export const validateDriverProfilePatch = (body: Record<string, unknown>): ValidationResult<DriverProfilePatch> => {
  const forbidden = hasForbiddenField(body);
  if (forbidden) return { valid: false, message: `لا يمكن تعديل الحقل ${forbidden} من صفحة الملف الشخصي.`, code: 'FORBIDDEN_PROFILE_FIELD' };

  const patch: DriverProfilePatch = {};
  let sensitiveVehicleChange = false;
  if (body.displayName !== undefined) {
    const displayName = validateName(body.displayName);
    if (!displayName.valid) return displayName;
    patch.displayName = displayName.value;
  }
  if (body.profilePhotoUrl !== undefined) {
    const profilePhotoUrl = validateOptionalUrl(body.profilePhotoUrl);
    if (!profilePhotoUrl.valid) return profilePhotoUrl;
    patch.profilePhotoUrl = profilePhotoUrl.value;
  }
  if (body.vehicle !== undefined) {
    if (typeof body.vehicle !== 'object' || Array.isArray(body.vehicle) || body.vehicle === null) {
      return { valid: false, message: 'بيانات المركبة غير صالحة.', code: 'INVALID_VEHICLE_PROFILE' };
    }
    const vehicle = body.vehicle as Record<string, unknown>;
    const allowedVehicleKeys = ['color', 'plateNumber'];
    const forbiddenVehicleKey = Object.keys(vehicle).find((key) => !allowedVehicleKeys.includes(key));
    if (forbiddenVehicleKey) {
      return { valid: false, message: `لا يمكن تعديل حقل المركبة ${forbiddenVehicleKey} من هذا المسار.`, code: 'FORBIDDEN_VEHICLE_FIELD' };
    }
    patch.vehicle = {};
    if (vehicle.color !== undefined) {
      if (typeof vehicle.color !== 'string') return { valid: false, message: 'لون المركبة غير صالح.', code: 'INVALID_VEHICLE_COLOR' };
      const color = sanitizeText(vehicle.color, 40);
      if (color.length < 2) return { valid: false, message: 'لون المركبة قصير جدًا.', code: 'INVALID_VEHICLE_COLOR' };
      patch.vehicle.color = color;
    }
    if (vehicle.plateNumber !== undefined) {
      if (typeof vehicle.plateNumber !== 'string') return { valid: false, message: 'رقم اللوحة غير صالح.', code: 'INVALID_PLATE_NUMBER' };
      const plateNumber = sanitizeText(vehicle.plateNumber, 40);
      if (plateNumber.length < 3) return { valid: false, message: 'رقم اللوحة قصير جدًا.', code: 'INVALID_PLATE_NUMBER' };
      patch.vehicle.plateNumber = plateNumber;
      sensitiveVehicleChange = true;
    }
  }
  return { valid: true, data: patch, sensitiveVehicleChange };
};

const adminContext = async () => {
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  return firebaseAdmin;
};

export const getOwnProfile = async (uid: string) => {
  const firebaseAdmin = await adminContext();
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const [userSnap, passengerSnap, driverSnap, kycSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`passengers/${uid}`).get(),
    db.doc(`drivers/${uid}`).get(),
    db.doc(`driverKyc/${uid}`).get()
  ]);
  return {
    user: userSnap.exists ? userSnap.data() : null,
    passenger: passengerSnap.exists ? passengerSnap.data() : null,
    driver: driverSnap.exists ? driverSnap.data() : null,
    driverKyc: kycSnap.exists ? kycSnap.data() : null
  };
};

export const updatePassengerProfile = async (uid: string, patch: PassengerProfilePatch): Promise<UserProfile> => {
  if (!profilePhotoBelongsToUser(uid, patch.profilePhotoUrl)) {
    throw new Error('INVALID_PROFILE_PHOTO_OWNER');
  }
  const firebaseAdmin = await adminContext();
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    ...patch,
    ...(patch.displayName ? { fullName: patch.displayName } : {}),
    ...(patch.profilePhotoUrl ? { avatarUrl: patch.profilePhotoUrl } : {}),
    updatedAt: now,
    updatedBy: uid
  };
  await Promise.all([
    db.doc(`users/${uid}`).set(update, { merge: true }),
    db.doc(`passengers/${uid}`).set(update, { merge: true })
  ]);
  const profile = await db.doc(`users/${uid}`).get();
  return profile.data() as unknown as UserProfile;
};

export const updateDriverProfile = async (uid: string, patch: DriverProfilePatch): Promise<DriverProfile> => {
  if (!profilePhotoBelongsToUser(uid, patch.profilePhotoUrl)) {
    throw new Error('INVALID_PROFILE_PHOTO_OWNER');
  }
  const firebaseAdmin = await adminContext();
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const now = new Date().toISOString();
  const existingSnap = await db.doc(`drivers/${uid}`).get();
  const existing = (existingSnap.data() || {}) as unknown as DriverProfile;
  const mergedVehicle = patch.vehicle ? { ...(existing.vehicle || {}), ...patch.vehicle } : existing.vehicle;
  const sensitiveVehicleChange = Boolean(
    patch.vehicle?.plateNumber &&
    patch.vehicle.plateNumber !== existing.vehicle?.plateNumber
  );
  const update: Record<string, unknown> = {
    ...(patch.displayName ? { displayName: patch.displayName, fullName: patch.displayName } : {}),
    ...(patch.profilePhotoUrl ? { profilePhotoUrl: patch.profilePhotoUrl, avatarUrl: patch.profilePhotoUrl } : {}),
    ...(patch.vehicle ? { vehicle: mergedVehicle } : {}),
    updatedAt: now,
    updatedBy: uid
  };

  if (sensitiveVehicleChange) {
    update.kycStatus = 'needs_resubmission' satisfies KycStatus;
    update.driverStatus = 'PENDING_APPROVAL';
    update.isAcceptingRides = false;
    update.kycUpdatedAt = now;
    await db.doc(`driverKyc/${uid}`).set({
      uid,
      driverId: uid,
      kycStatus: 'needs_resubmission',
      reason: 'vehicle_identity_changed',
      updatedAt: now,
      updatedBy: uid
    }, { merge: true });
  }

  await Promise.all([
    db.doc(`drivers/${uid}`).set(update, { merge: true }),
    db.doc(`users/${uid}`).set({
      ...(patch.displayName ? { displayName: patch.displayName, fullName: patch.displayName } : {}),
      ...(patch.profilePhotoUrl ? { profilePhotoUrl: patch.profilePhotoUrl, avatarUrl: patch.profilePhotoUrl } : {}),
      updatedAt: now,
      updatedBy: uid
    }, { merge: true })
  ]);
  const profile = await db.doc(`drivers/${uid}`).get();
  return profile.data() as unknown as DriverProfile;
};

export const getDriverKycStatus = async (uid: string): Promise<KycStatus | null> => {
  const firebaseAdmin = await adminContext();
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const snapshot = await db.doc(`driverKyc/${uid}`).get();
  const status = snapshot.data()?.kycStatus;
  return typeof status === 'string' ? status as KycStatus : null;
};
