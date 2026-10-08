import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import {
  DriverDocument,
  DriverProfile,
  KycStatus,
  UserProfile,
  VehicleType
} from '../../packages/shared_types/src';
import { generateId, normalizeYemeniPhone } from '../../packages/shared_utils/src';
import { appConfig } from '../config/appConfig';
import { auth, db, isFirebaseConfigured, storage } from './firebase/firebaseConfig';

export interface PassengerOnboardingInput {
  displayName: string;
  profilePhoto?: File | null;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
}

export interface DriverOnboardingInput {
  fullName: string;
  profilePhoto?: File | null;
  nationalIdNumber: string;
  nationalIdImage?: File | null;
  drivingLicenseNumber: string;
  drivingLicenseImage?: File | null;
  vehicleType: VehicleType;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  plateNumber: string;
  vehiclePhoto?: File | null;
}

type ValidationResult = { valid: true } | { valid: false; message: string };

const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const maxImageBytes = 5 * 1024 * 1024;

export const kycStatusLabels: Record<KycStatus, string> = {
  not_started: 'لم يبدأ السائق رفع بياناته بعد.',
  in_progress: 'السائق بدأ تعبئة البيانات ولم يرسلها للمراجعة.',
  pending_review: 'البيانات مرسلة وتنتظر مراجعة الإدارة.',
  approved: 'تم اعتماد السائق ويمكنه العمل في الإنتاج.',
  rejected: 'تم رفض البيانات، والحساب لا يعمل كسائق.',
  needs_resubmission: 'يوجد ملاحظات ويستطيع السائق تعديل الملفات وإعادة الإرسال.'
};

const currentUid = (): string | null => {
  if (appConfig.flags.useRealAuth) return auth.currentUser?.uid ?? null;
  return null;
};

const validateName = (name: string): ValidationResult => {
  const trimmed = name.trim();
  if (!trimmed) return { valid: false, message: 'الاسم مطلوب.' };
  if (trimmed.length < 3 || trimmed.length > 80) return { valid: false, message: 'اكتب اسمًا واضحًا بين 3 و80 حرفًا.' };
  return { valid: true };
};

const validateRequired = (value: string, label: string): ValidationResult => {
  if (!value.trim()) return { valid: false, message: `${label} مطلوب.` };
  if (value.trim().length < 3) return { valid: false, message: `${label} قصير جدًا.` };
  return { valid: true };
};

const validateOptionalPhone = (phone?: string): ValidationResult => {
  if (!phone?.trim()) return { valid: true };
  return normalizeYemeniPhone(phone).isValid
    ? { valid: true }
    : { valid: false, message: 'رقم جهة الطوارئ يجب أن يكون رقمًا يمنيًا صحيحًا.' };
};

const validateImage = (file: File | null | undefined, label: string, required: boolean): ValidationResult => {
  if (!file) return required ? { valid: false, message: `${label} مطلوب.` } : { valid: true };
  if (!allowedImageTypes.includes(file.type)) return { valid: false, message: `${label}: نوع الملف غير مسموح. استخدم JPG أو PNG أو WEBP.` };
  if (file.size > maxImageBytes) return { valid: false, message: `${label}: حجم الملف كبير جدًا. الحد الأقصى 5MB.` };
  return { valid: true };
};

const firstInvalid = (checks: ValidationResult[]): ValidationResult => checks.find((check) => !check.valid) || { valid: true };

const uploadOptionalImage = async (path: string, file?: File | null): Promise<{ url?: string; storagePath?: string; fileName?: string; contentType?: string; sizeBytes?: number }> => {
  if (!file) return {};
  if (!isFirebaseConfigured()) {
    return {
      url: path,
      storagePath: path,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size
    };
  }

  const storagePath = `${path}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const target = ref(storage, storagePath);
  await uploadBytes(target, file, { contentType: file.type });
  return {
    url: await getDownloadURL(target),
    storagePath,
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size
  };
};

class OnboardingService {
  validatePassenger(input: PassengerOnboardingInput): ValidationResult {
    return firstInvalid([
      validateName(input.displayName),
      validateImage(input.profilePhoto, 'الصورة الشخصية', false),
      validateOptionalPhone(input.emergencyContactPhone)
    ]);
  }

  validateDriver(input: DriverOnboardingInput): ValidationResult {
    return firstInvalid([
      validateName(input.fullName),
      validateImage(input.profilePhoto, 'الصورة الشخصية', false),
      validateRequired(input.nationalIdNumber, 'رقم الهوية'),
      validateImage(input.nationalIdImage, 'صورة الهوية', true),
      validateRequired(input.drivingLicenseNumber, 'رقم رخصة القيادة'),
      validateImage(input.drivingLicenseImage, 'صورة رخصة القيادة', true),
      validateRequired(input.vehicleMake, 'الشركة المصنعة'),
      validateRequired(input.vehicleModel, 'موديل المركبة'),
      validateRequired(input.vehicleColor, 'لون المركبة'),
      validateRequired(input.plateNumber, 'رقم اللوحة'),
      validateImage(input.vehiclePhoto, 'صورة المركبة', true)
    ]);
  }

  isDriverEligibleForProduction(driver: DriverProfile): boolean {
    return driver.kycStatus === 'approved' && driver.driverStatus !== 'SUSPENDED' && driver.isActive;
  }

  async completePassenger(input: PassengerOnboardingInput, fallbackUser: UserProfile): Promise<{ success: boolean; message: string; profile?: UserProfile }> {
    const validation = this.validatePassenger(input);
    if (!validation.valid) return { success: false, message: validation.message };

    const uid = currentUid() || fallbackUser.id;
    const photo = await uploadOptionalImage(`users/${uid}/profile`, input.profilePhoto);
    const now = new Date().toISOString();
    const profile: UserProfile = {
      ...fallbackUser,
      id: uid,
      uid,
      fullName: input.displayName.trim(),
      displayName: input.displayName.trim(),
      phoneNumber: auth.currentUser?.phoneNumber || fallbackUser.phoneNumber,
      avatarUrl: photo.url || fallbackUser.avatarUrl,
      profilePhotoUrl: photo.url || fallbackUser.profilePhotoUrl,
      role: 'CUSTOMER',
      accountStatus: 'active',
      onboardingStatus: 'completed',
      isActive: true,
      updatedAt: now,
      createdAt: fallbackUser.createdAt || now
    };

    if (isFirebaseConfigured() && auth.currentUser) {
      await setDoc(doc(db, 'users', uid), { ...profile, updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, 'passengers', uid), { ...profile, updatedAt: serverTimestamp() }, { merge: true });
    }

    return { success: true, message: 'تم إكمال ملف الراكب بنجاح.', profile };
  }

  async submitDriver(input: DriverOnboardingInput, fallbackDriver: DriverProfile): Promise<{ success: boolean; message: string; driver?: DriverProfile; documents?: DriverDocument[] }> {
    const validation = this.validateDriver(input);
    if (!validation.valid) return { success: false, message: validation.message };

    const uid = currentUid() || fallbackDriver.id;
    const now = new Date().toISOString();
    const [profilePhoto, nationalIdImage, licenseImage, vehiclePhoto] = await Promise.all([
      uploadOptionalImage(`users/${uid}/profile`, input.profilePhoto),
      uploadOptionalImage(`drivers/${uid}/kyc/id`, input.nationalIdImage),
      uploadOptionalImage(`drivers/${uid}/kyc/license`, input.drivingLicenseImage),
      uploadOptionalImage(`drivers/${uid}/vehicle`, input.vehiclePhoto)
    ]);

    const driver: DriverProfile = {
      ...fallbackDriver,
      id: uid,
      uid,
      fullName: input.fullName.trim(),
      displayName: input.fullName.trim(),
      phoneNumber: auth.currentUser?.phoneNumber || fallbackDriver.phoneNumber,
      avatarUrl: profilePhoto.url || fallbackDriver.avatarUrl,
      profilePhotoUrl: profilePhoto.url || fallbackDriver.profilePhotoUrl,
      role: 'DRIVER',
      accountStatus: 'active',
      onboardingStatus: 'completed',
      isActive: true,
      driverStatus: 'PENDING_APPROVAL',
      isAcceptingRides: false,
      kycStatus: 'pending_review',
      nationalIdNumber: input.nationalIdNumber.trim(),
      drivingLicenseNumber: input.drivingLicenseNumber.trim(),
      kycSubmittedAt: now,
      kycUpdatedAt: now,
      updatedAt: now,
      createdAt: fallbackDriver.createdAt || now,
      vehicle: {
        id: fallbackDriver.vehicle?.id || generateId('veh'),
        driverId: uid,
        type: input.vehicleType,
        vehicleType: input.vehicleType,
        make: input.vehicleMake.trim(),
        model: input.vehicleModel.trim(),
        year: fallbackDriver.vehicle?.year || new Date().getFullYear(),
        color: input.vehicleColor.trim(),
        plateNumber: input.plateNumber.trim(),
        isVerified: false,
        capacity: input.vehicleType === 'MOTORCYCLE' ? 1 : 4,
        hasAC: input.vehicleType !== 'MOTORCYCLE',
        status: 'ACTIVE'
      }
    };

    const documents: DriverDocument[] = [
      this.toDriverDocument(uid, 'NATIONAL_ID', nationalIdImage),
      this.toDriverDocument(uid, 'DRIVING_LICENSE', licenseImage),
      this.toDriverDocument(uid, 'VEHICLE_PHOTOS', vehiclePhoto)
    ];

    if (isFirebaseConfigured() && auth.currentUser) {
      await setDoc(doc(db, 'users', uid), { ...driver, updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, 'drivers', uid), { ...driver, updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, 'driverKyc', uid), {
        driverId: uid,
        kycStatus: 'pending_review',
        nationalIdNumber: driver.nationalIdNumber,
        drivingLicenseNumber: driver.drivingLicenseNumber,
        rejectionReason: null,
        submittedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      await Promise.all(documents.map((item) => setDoc(doc(db, 'driver_documents', item.id), item, { merge: true })));
    }

    return { success: true, message: 'تم إرسال ملف السائق للمراجعة. الحالة الآن: pending_review.', driver, documents };
  }

  private toDriverDocument(driverId: string, type: DriverDocument['type'], upload: Awaited<ReturnType<typeof uploadOptionalImage>>): DriverDocument {
    return {
      id: `${driverId}_${type.toLowerCase()}`,
      driverId,
      type,
      documentUrl: upload.url || upload.storagePath || '',
      storagePath: upload.storagePath,
      fileName: upload.fileName,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      status: 'PENDING',
      uploadedAt: new Date().toISOString()
    };
  }
}

export const onboardingService = new OnboardingService();
