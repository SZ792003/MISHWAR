import express, { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { calculateDistanceKm, calculateFare } from '../../packages/shared_utils/src';
import {
  ApiResponse,
  PricingRule,
  Ride,
  RideStatus,
  VehicleType,
  SOSAlert,
  PilotConfig,
  PaymentMethod,
  UserRole,
  SafetyReport,
  UserBlockRecord,
  DriverDocument,
  KycReviewRecord,
  DriverSettlement,
  DiagnosticEvent,
  BackupSnapshot
} from '../../packages/shared_types/src';
import { backendConfig, hasExplicitFirebaseAdminCredentials, isStrictBackend } from './config';
import { AuthenticatedRequest, getFirebaseAdmin, requireAuth, requireRole } from './auth';
import { approveDriver, isPrivilegedAdminRole, rejectDriver, requireTrustedAdminContext, setTrustedRoleClaim } from './trustedRoles';
import { auditSessionRevocation, blockUser, requireAccountAdmin, revokeUserSessions, suspendUser, unblockUser } from './accountSecurity';
import {
  getDriverKycStatus,
  getOwnProfile,
  updateDriverProfile,
  updatePassengerProfile,
  validateDriverProfilePatch,
  validatePassengerProfilePatch
} from './profileService';
import {
  ApiValidationError,
  assertGeoPoint,
  assertPassengerCount,
  assertPaymentMethod,
  assertPositiveAmount,
  assertVehicleType
} from './validation';
import {
  firestoreDispatchRepository,
  firestoreRideRepository,
  firestoreWalletRepository,
  shouldUseFirestorePersistence
} from './persistence';
import { auditActorFromRequest, auditService } from './auditService';
import { logEvent } from './logger';
import { metrics, metricsMiddleware } from './metrics';
import { disableDeviceToken, notifyUser, notifyUsers, registerDeviceToken } from './notificationService';
import { asPaymentError } from './payments/paymentErrors';
import { paymentService } from './payments/paymentService';
import { financialOperationsService } from './payments/financialOperationsService';
import { requestContextMiddleware } from './requestContext';
import { assertGeoPointModel, geoService, validateGeoProviderConfig } from './geoService';

const app = express();
const PORT = backendConfig.port;
const NODE_ENV = backendConfig.nodeEnv;
const API_TOKEN = backendConfig.apiToken;
const allowedOrigins = backendConfig.allowedOrigins;
let isShuttingDown = false;

if (backendConfig.trustProxy) {
  const value = backendConfig.trustProxy.trim();
  app.set('trust proxy', value === 'true' ? true : /^\d+$/.test(value) ? Number(value) : value.split(',').map((entry) => entry.trim()));
}

app.use(requestContextMiddleware);
app.use(metricsMiddleware);
app.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isShuttingDown) return next();
  res.setHeader('Connection', 'close');
  return sendError(res, 503, 'Server is shutting down', 'SERVER_SHUTTING_DOWN');
});

// In-Memory Pilot Registry & Idempotency Store
const processedIdempotencyKeys = new Map<string, { timestamp: number; response: any }>();
const activeRideLocks = new Map<string, string>(); // rideId -> lockedDriverId
const walletBalances = new Map<string, number>([
  ['cust_01', 8500],
  ['cust_02', 4200],
  ['cust_03', 12000],
  ['cust_04', 3500],
  ['cust_05', 9100]
]);
const ridesStore = new Map<string, Ride>();
const safetyReportsStore = new Map<string, SafetyReport>();
const userBlocksStore = new Map<string, UserBlockRecord>();
const driverDocumentsStore = new Map<string, DriverDocument>();
const kycReviewStore = new Map<string, KycReviewRecord>();
const settlementsStore = new Map<string, DriverSettlement>();
const diagnosticEventsStore = new Map<string, DiagnosticEvent>();
const backupSnapshotsStore = new Map<string, BackupSnapshot>();
type SupportTicketCategory =
  | 'ride_issue'
  | 'driver_issue'
  | 'customer_issue'
  | 'payment'
  | 'refund'
  | 'account'
  | 'account_review'
  | 'kyc'
  | 'safety'
  | 'technical'
  | 'other';
type SupportTicketStatus = 'open' | 'pending_review' | 'in_progress' | 'resolved' | 'closed';
type PrivacyRequestType = 'account_deletion' | 'data_access' | 'data_correction';
type PrivacyRequestStatus = 'pending_review' | 'approved' | 'completed' | 'rejected';

type SupportTicketRecord = {
  id: string;
  userId: string;
  role: UserRole;
  rideId?: string;
  category: SupportTicketCategory;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: SupportTicketStatus;
  subject: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
};

type PrivacyRequestRecord = {
  id: string;
  userId: string;
  role: UserRole;
  type: PrivacyRequestType;
  status: PrivacyRequestStatus;
  message?: string;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
};

type RideRatingRecord = {
  id: string;
  rideId: string;
  fromUserId: string;
  toUserId: string;
  targetRole: 'DRIVER' | 'CUSTOMER';
  stars: number;
  reasons: string[];
  comment?: string;
  createdAt: string;
  updatedAt: string;
};

const supportTicketsStore = new Map<string, SupportTicketRecord>();
const privacyRequestsStore = new Map<string, PrivacyRequestRecord>();
const rideRatingsStore = new Map<string, RideRatingRecord>();
const analyticsEventsStore: Array<{
  id: string;
  userId: string;
  role: UserRole;
  name: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}> = [];
const immutableLedgerStore: Array<{
  transactionId: string;
  userId: string;
  type: string;
  amount: number;
  status: string;
  referenceId: string;
  createdAt: string;
  immutableHash: string;
}> = [];

type SafetyIncidentType =
  | 'sos'
  | 'unsafe_driver'
  | 'unsafe_passenger'
  | 'accident'
  | 'harassment'
  | 'vehicle_issue'
  | 'medical_concern'
  | 'route_concern'
  | 'lost_item'
  | 'other';

type SafetyIncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
type SafetyIncidentStatus = 'open' | 'acknowledged' | 'in_review' | 'escalated' | 'resolved' | 'closed' | 'cancelled';
type SafetySignalType = 'long_stop' | 'significant_route_deviation' | 'repeated_location_loss' | 'manual_concern' | 'sos_pressed';

type SafetyIncident = {
  id: string;
  rideId: string;
  reporterId: string;
  reporterRole: UserRole;
  customerId?: string;
  driverId?: string;
  type: SafetyIncidentType;
  severity: SafetyIncidentSeverity;
  status: SafetyIncidentStatus;
  description?: string;
  locationSnapshot: Record<string, unknown>;
  rideSnapshot: Record<string, unknown>;
  attachments: Array<{ id: string; storagePath: string; contentType: string; uploadedBy: string; createdAt: string }>;
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  escalatedAt?: string;
  escalatedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  requestId?: string;
};

type SafetySignal = {
  id: string;
  rideId: string;
  type: SafetySignalType;
  source: 'backend' | 'customer_app' | 'driver_app' | 'dispatcher';
  severity: 'info' | 'warning';
  createdAt: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
};

type RiskSignalType =
  | 'duplicate_account_behavior'
  | 'repeated_ride_cancellations'
  | 'repeated_no_show'
  | 'rapid_account_switching'
  | 'suspicious_location_pattern'
  | 'repeated_failed_payment'
  | 'duplicate_refund_attempt'
  | 'rapid_payout_requests'
  | 'wallet_balance_mismatch'
  | 'provider_mismatch'
  | 'repeated_safety_reports'
  | 'kyc_inconsistency'
  | 'manual_review';

type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';
type RiskSignalStatus = 'open' | 'linked' | 'dismissed' | 'resolved';
type RiskCaseStatus = 'open' | 'under_review' | 'action_required' | 'resolved' | 'dismissed';
type RiskCasePriority = 'low' | 'medium' | 'high' | 'critical';
type RiskSubjectRole = 'CUSTOMER' | 'DRIVER' | 'UNKNOWN';
type RiskCaseActionType = 'warning' | 'review' | 'temporary_suspension' | 'financial_restriction' | 'full_block' | 'unblock';

type RiskSignal = {
  id: string;
  type: RiskSignalType;
  severity: RiskSeverity;
  userId?: string;
  driverId?: string;
  rideId?: string;
  paymentId?: string;
  incidentId?: string;
  financialRiskFlagId?: string;
  kycReviewId?: string;
  source: 'ride_abuse' | 'financial' | 'geo' | 'safety' | 'kyc' | 'admin' | 'system';
  status: RiskSignalStatus;
  createdAt: string;
  metadata: Record<string, unknown>;
  manualReviewRequired: boolean;
  requestId?: string;
};

type RiskCaseNote = {
  id: string;
  reviewerId: string;
  reviewerRole: UserRole;
  note: string;
  createdAt: string;
  requestId?: string;
};

type RiskCaseEvidence = {
  type: 'ride' | 'payment' | 'refund' | 'payout' | 'incident' | 'kyc_review' | 'financial_risk_flag' | 'geo_signal';
  id: string;
};

type RiskCaseAction = {
  id: string;
  type: RiskCaseActionType;
  targetUserId: string;
  createdBy: string;
  createdAt: string;
  reason: string;
  result?: Record<string, unknown>;
  requestId?: string;
};

type RiskCase = {
  id: string;
  subjectUserId: string;
  subjectRole: RiskSubjectRole;
  status: RiskCaseStatus;
  priority: RiskCasePriority;
  signalIds: string[];
  incidentIds: string[];
  evidence: RiskCaseEvidence[];
  assignedTo?: string;
  notes: RiskCaseNote[];
  actions: RiskCaseAction[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  requestId?: string;
};

const safetyIncidentsStore = new Map<string, SafetyIncident>();
const safetySignalsStore = new Map<string, SafetySignal>();
const riskSignalsStore = new Map<string, RiskSignal>();
const riskCasesStore = new Map<string, RiskCase>();
const riskAuditEventsStore: Array<{ eventType: string; targetType: string; targetId: string; createdAt: string; requestId?: string }> = [];

const defaultPricingRules: Record<string, PricingRule> = {
  MOTORCYCLE: {
    id: 'rule_motorcycle_backend',
    vehicleType: 'MOTORCYCLE',
    baseFare: 500,
    pricePerKm: 150,
    pricePerMinute: 25,
    minimumFare: 700,
    platformCommissionRate: 0.1,
    peakMultiplier: 1,
    currency: 'YER',
    updatedAt: new Date().toISOString()
  },
  ECONOMY: {
    id: 'rule_economy_backend',
    vehicleType: 'ECONOMY',
    baseFare: 1200,
    pricePerKm: 350,
    pricePerMinute: 45,
    minimumFare: 1800,
    platformCommissionRate: 0.1,
    peakMultiplier: 1,
    currency: 'YER',
    updatedAt: new Date().toISOString()
  },
  CAR: {
    id: 'rule_car_backend',
    vehicleType: 'CAR',
    baseFare: 1200,
    pricePerKm: 350,
    pricePerMinute: 45,
    minimumFare: 1800,
    platformCommissionRate: 0.1,
    peakMultiplier: 1,
    currency: 'YER',
    updatedAt: new Date().toISOString()
  },
  COMFORT: {
    id: 'rule_comfort_backend',
    vehicleType: 'COMFORT',
    baseFare: 1600,
    pricePerKm: 420,
    pricePerMinute: 55,
    minimumFare: 2400,
    platformCommissionRate: 0.1,
    peakMultiplier: 1,
    currency: 'YER',
    updatedAt: new Date().toISOString()
  },
  FAMILY: {
    id: 'rule_family_backend',
    vehicleType: 'FAMILY',
    baseFare: 2200,
    pricePerKm: 550,
    pricePerMinute: 70,
    minimumFare: 3200,
    platformCommissionRate: 0.1,
    peakMultiplier: 1,
    currency: 'YER',
    updatedAt: new Date().toISOString()
  }
};

// Pilot Configuration Defaults
let pilotConfig: PilotConfig = {
  isPilotMode: true,
  maxDrivers: 10,
  maxCustomers: 100,
  isCashOnly: true,
  allowedCities: ["Sana'a", 'Aden']
};

// CORS Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (!origin || NODE_ENV === 'development' || allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || allowedOrigins[0] || 'http://localhost:3000');
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-idempotency-key, x-user-id, x-user-role');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// API Response Helpers
function sendSuccess<T>(res: Response, data: T, message: string = 'Success') {
  const response: ApiResponse<T> = {
    success: true,
    data,
    message,
    error: null
  };
  return res.status(200).json(response);
}

function sendError(res: Response, statusCode: number, message: string, code: string, details?: unknown) {
  if (statusCode >= 500) {
    logEvent('error', 'http_error_response', {
      requestId: res.locals.requestId,
      route: res.req?.route?.path || res.req?.path,
      statusCode,
      code
    });
  }
  const response: ApiResponse = {
    success: false,
    data: null,
    message,
    error: { code, details }
  };
  return res.status(statusCode).json(response);
}

function sendValidationError(res: Response, error: unknown) {
  if (error instanceof ApiValidationError) {
    return sendError(res, 400, error.message, error.code, error.details);
  }
  return sendError(res, 500, 'Unexpected server error', 'INTERNAL_ERROR');
}

function sendPersistenceError(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : 'DATABASE_ERROR';
  metrics.increment('persistence_errors_total');
  if (code === 'RIDE_ALREADY_ASSIGNED' || code === 'DRIVER_ALREADY_BUSY') metrics.increment('ride_assignment_conflicts_total');
  if (code === 'DATABASE_UNAVAILABLE') metrics.increment('database_unavailable_total');
  if (code === 'LOCATION_STALE') metrics.increment('stale_location_events_total');
  const statusByCode: Record<string, number> = {
    DATABASE_UNAVAILABLE: 503,
    RIDE_NOT_FOUND: 404,
    RIDE_ALREADY_ASSIGNED: 409,
    RIDE_NOT_AVAILABLE: 409,
    DRIVER_ALREADY_BUSY: 409,
    DRIVER_NOT_ELIGIBLE: 403,
    RIDE_FORBIDDEN: 403,
    RIDE_NOT_ACTIVE: 409,
    LOCATION_STALE: 409,
    INVALID_RIDE_TRANSITION: 409,
    PAYMENT_METHOD_DISABLED: 400,
    OFFER_REQUIRED: 409,
    OFFER_NOT_AVAILABLE: 409,
    OFFER_EXPIRED: 409
  };
  const messageByCode: Record<string, string> = {
    DATABASE_UNAVAILABLE: 'Persistent database is not available',
    RIDE_NOT_FOUND: 'Ride not found',
    RIDE_ALREADY_ASSIGNED: 'Ride already assigned to another driver',
    RIDE_NOT_AVAILABLE: 'Ride is not available for this operation',
    DRIVER_ALREADY_BUSY: 'Driver already has an active ride',
    DRIVER_NOT_ELIGIBLE: 'Driver is not eligible for production rides',
    RIDE_FORBIDDEN: 'Forbidden for this ride',
    RIDE_NOT_ACTIVE: 'Ride is not active',
    LOCATION_STALE: 'Driver location update is stale',
    INVALID_RIDE_TRANSITION: 'Invalid ride transition',
    PAYMENT_METHOD_DISABLED: 'Only CASH and WALLET are enabled in pilot mode',
    OFFER_REQUIRED: 'This driver does not have an active ride offer',
    OFFER_NOT_AVAILABLE: 'This ride offer is no longer available',
    OFFER_EXPIRED: 'This ride offer expired; request the next available offer',
    DATABASE_ERROR: 'Database operation failed'
  };
  return sendError(res, statusByCode[code] || 500, messageByCode[code] || messageByCode.DATABASE_ERROR, code || 'DATABASE_ERROR');
}

function sendPaymentError(res: Response, error: unknown) {
  const paymentError = asPaymentError(error);
  if (paymentError.statusCode >= 500) metrics.increment('payment_operations_failed_total');
  return sendError(res, paymentError.statusCode, paymentError.message, paymentError.code, paymentError.details);
}

const usePersistentStore = (req: AuthenticatedRequest): boolean => shouldUseFirestorePersistence(req.user?.authSource);

function requireApiAuth(requiredRole?: UserRole) {
  const roles = requiredRole ? [requiredRole] : [];
  return [
    requireAuth,
    ...(roles.length > 0 ? [requireRole(...roles)] : []),
    ...(requiredRole === 'DRIVER' ? [requireApprovedDriverAccount] : [])
  ];
}

async function requireApprovedDriverAccount(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'DRIVER' || req.user.authSource !== 'firebase') return next();
  try {
    const kycStatus = await getDriverKycStatus(req.user.uid);
    if (kycStatus !== 'approved') {
      return sendError(res, 403, 'Driver KYC approval is required for this operation', 'DRIVER_KYC_NOT_APPROVED');
    }
    return next();
  } catch {
    return sendError(res, 503, 'Driver verification status is unavailable', 'DRIVER_KYC_CHECK_FAILED');
  }
}

function canAccessRide(user: AuthenticatedRequest['user'], ride: Ride): boolean {
  if (!user) return false;
  if (isPrivilegedAdminRole(user.role)) return true;
  return ride.customerId === user.uid || ride.passengerId === user.uid || ride.driverId === user.uid;
}

function canDriverOperateRide(user: AuthenticatedRequest['user'], ride: Ride): boolean {
  if (!user) return false;
  if (isPrivilegedAdminRole(user.role)) return true;
  return user.role === 'DRIVER' && ride.driverId === user.uid;
}

function requireRideAccess(req: AuthenticatedRequest, res: Response, ride: Ride): boolean {
  if (canAccessRide(req.user, ride)) return true;
  sendError(res, 403, 'Forbidden for this ride', 'RIDE_FORBIDDEN');
  return false;
}

function requireAssignedDriver(req: AuthenticatedRequest, res: Response, ride: Ride): boolean {
  if (canDriverOperateRide(req.user, ride)) return true;
  sendError(res, 403, 'Only the assigned driver can update this ride', 'RIDE_FORBIDDEN');
  return false;
}

const safetyAdminRoles: UserRole[] = ['ADMIN', 'SUPER_ADMIN', 'OPS_MANAGER', 'DISPATCHER', 'SUPPORT'];
const riskReviewerRoles: UserRole[] = ['ADMIN', 'SUPER_ADMIN', 'OPS_MANAGER', 'SUPPORT', 'FINANCE', 'KYC_REVIEWER'];
const supportReviewerRoles: UserRole[] = ['ADMIN', 'SUPER_ADMIN', 'OPS_MANAGER', 'SUPPORT', 'SUPPORT_REVIEWER'];
const riskThresholds = {
  cancellationWindowHours: Number(process.env.RISK_CANCELLATION_WINDOW_HOURS || 24),
  maxCancellations: Number(process.env.RISK_MAX_CANCELLATIONS || 3),
  maxFailedPayments: Number(process.env.RISK_MAX_FAILED_PAYMENTS || 3),
  maxPayoutRequests: Number(process.env.RISK_MAX_PAYOUT_REQUESTS || 3)
};

function requireSafetyDispatcher(req: AuthenticatedRequest, res: Response): boolean {
  if (req.user && safetyAdminRoles.includes(req.user.role)) return true;
  sendError(res, 403, 'Safety dispatcher permission is required', 'SAFETY_PERMISSION_REQUIRED');
  return false;
}

function requireRiskReviewer(req: AuthenticatedRequest, res: Response): boolean {
  if (req.user && riskReviewerRoles.includes(req.user.role)) return true;
  sendError(res, 403, 'Risk reviewer permission is required', 'RISK_PERMISSION_REQUIRED');
  return false;
}

function requireSupportReviewer(req: AuthenticatedRequest, res: Response): boolean {
  if (req.user && supportReviewerRoles.includes(req.user.role)) return true;
  sendError(res, 403, 'Support reviewer permission is required', 'SUPPORT_PERMISSION_REQUIRED');
  return false;
}

const supportCategories: SupportTicketCategory[] = [
  'ride_issue',
  'driver_issue',
  'customer_issue',
  'payment',
  'refund',
  'account',
  'account_review',
  'kyc',
  'safety',
  'technical',
  'other'
];
const supportStatuses: SupportTicketStatus[] = ['open', 'pending_review', 'in_progress', 'resolved', 'closed'];
const privacyRequestTypes: PrivacyRequestType[] = ['account_deletion', 'data_access', 'data_correction'];
const ratingReasons = ['cleanliness', 'driving', 'behavior', 'vehicle', 'navigation', 'other'];
const sensitiveAnalyticsKeys = new Set([
  'phone',
  'phoneNumber',
  'name',
  'fullName',
  'customerName',
  'driverName',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'gps',
  'kyc',
  'documentUrl',
  'bank',
  'walletBalance',
  'incidentDescription',
  'description',
  'comment'
]);

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function sanitizeAnalyticsParameters(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (sensitiveAnalyticsKeys.has(key)) continue;
    if (typeof value === 'string') output[key] = value.slice(0, 80);
    else if (typeof value === 'number' || typeof value === 'boolean') output[key] = value;
  }
  return output;
}

const riskPriorityRank: Record<RiskCasePriority, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function riskSubjectFromSignal(signal: RiskSignal): { subjectUserId: string; subjectRole: RiskSubjectRole } {
  if (signal.driverId) return { subjectUserId: signal.driverId, subjectRole: 'DRIVER' };
  if (signal.userId) return { subjectUserId: signal.userId, subjectRole: 'CUSTOMER' };
  return { subjectUserId: 'unknown', subjectRole: 'UNKNOWN' };
}

function evidenceFromSignal(signal: RiskSignal): RiskCaseEvidence[] {
  const evidence: RiskCaseEvidence[] = [];
  if (signal.rideId) evidence.push({ type: 'ride', id: signal.rideId });
  if (signal.paymentId) evidence.push({ type: 'payment', id: signal.paymentId });
  if (signal.incidentId) evidence.push({ type: 'incident', id: signal.incidentId });
  if (signal.financialRiskFlagId) evidence.push({ type: 'financial_risk_flag', id: signal.financialRiskFlagId });
  if (signal.kycReviewId) evidence.push({ type: 'kyc_review', id: signal.kycReviewId });
  if (signal.type === 'suspicious_location_pattern') evidence.push({ type: 'geo_signal', id: signal.id });
  return evidence;
}

function mergeEvidence(existing: RiskCaseEvidence[], incoming: RiskCaseEvidence[]): RiskCaseEvidence[] {
  const keyed = new Map(existing.map((item) => [`${item.type}:${item.id}`, item]));
  incoming.forEach((item) => keyed.set(`${item.type}:${item.id}`, item));
  return Array.from(keyed.values());
}

function findOpenRiskCase(signal: RiskSignal): RiskCase | undefined {
  const subject = riskSubjectFromSignal(signal);
  return Array.from(riskCasesStore.values()).find((riskCase) =>
    riskCase.subjectUserId === subject.subjectUserId &&
    !['resolved', 'dismissed'].includes(riskCase.status)
  );
}

function findDuplicateRiskSignal(input: Omit<RiskSignal, 'id' | 'status' | 'createdAt'>): RiskSignal | undefined {
  const subjectKey = input.driverId || input.userId || 'unknown';
  return Array.from(riskSignalsStore.values()).find((signal) =>
    signal.type === input.type &&
    signal.source === input.source &&
    (signal.driverId || signal.userId || 'unknown') === subjectKey &&
    (signal.rideId || '') === (input.rideId || '') &&
    (signal.paymentId || '') === (input.paymentId || '') &&
    (signal.incidentId || '') === (input.incidentId || '') &&
    !['resolved', 'dismissed'].includes(signal.status)
  );
}

async function persistRiskSignal(req: AuthenticatedRequest | null, signal: RiskSignal): Promise<void> {
  riskSignalsStore.set(signal.id, signal);
  if (!req || !usePersistentStore(req)) return;
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) return;
  await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`riskSignals/${signal.id}`).set(signal);
}

async function persistRiskCase(req: AuthenticatedRequest | null, riskCase: RiskCase): Promise<void> {
  riskCasesStore.set(riskCase.id, riskCase);
  if (!req || !usePersistentStore(req)) return;
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) return;
  await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`riskCases/${riskCase.id}`).set(riskCase);
}

async function riskAudit(
  req: AuthenticatedRequest | null,
  eventType: 'RISK_SIGNAL_CREATED' | 'RISK_CASE_CREATED' | 'RISK_CASE_ASSIGNED' | 'RISK_CASE_NOTE_ADDED' | 'RISK_CASE_RESOLVED' | 'RISK_ACTION_SUSPENDED' | 'RISK_ACTION_BLOCKED' | 'RISK_ACTION_UNBLOCKED',
  targetType: 'RISK_SIGNAL' | 'RISK_CASE',
  targetId: string,
  metadata: Record<string, unknown> = {}
) {
  riskAuditEventsStore.push({ eventType, targetType, targetId, createdAt: new Date().toISOString(), requestId: req?.requestId });
  try {
    await auditService.log({
      ...(req ? auditActorFromRequest(req) : { actorUid: 'system', actorRole: 'SYSTEM', requestId: undefined }),
      eventType,
      targetType,
      targetId,
      source: req?.user?.role ? 'ADMIN_BACKEND' : 'BACKEND',
      metadata
    });
  } catch {
    // Demo mode may not have Firestore-backed audit available; risk state remains in memory.
  }
}

async function createRiskSignal(
  req: AuthenticatedRequest | null,
  input: Omit<RiskSignal, 'id' | 'status' | 'createdAt'>
): Promise<{ signal: RiskSignal; riskCase: RiskCase; deduplicated: boolean }> {
  const duplicate = findDuplicateRiskSignal(input);
  if (duplicate) {
    const duplicateCase = findOpenRiskCase(duplicate);
    if (duplicateCase) return { signal: duplicate, riskCase: duplicateCase, deduplicated: true };
  }

  const now = new Date().toISOString();
  const signal: RiskSignal = {
    ...input,
    id: `risk_signal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'open',
    createdAt: now,
    requestId: req?.requestId
  };
  await persistRiskSignal(req, signal);
  await riskAudit(req, 'RISK_SIGNAL_CREATED', 'RISK_SIGNAL', signal.id, {
    type: signal.type,
    severity: signal.severity,
    source: signal.source,
    manualReviewRequired: signal.manualReviewRequired
  });
  metrics.increment('risk_signals_total');

  const subject = riskSubjectFromSignal(signal);
  const existing = findOpenRiskCase(signal);
  if (existing) {
    const updated: RiskCase = {
      ...existing,
      status: existing.status === 'open' ? 'under_review' : existing.status,
      priority: riskPriorityRank[signal.severity] > riskPriorityRank[existing.priority] ? signal.severity : existing.priority,
      signalIds: Array.from(new Set([signal.id, ...existing.signalIds])),
      incidentIds: signal.incidentId ? Array.from(new Set([signal.incidentId, ...existing.incidentIds])) : existing.incidentIds,
      evidence: mergeEvidence(existing.evidence, evidenceFromSignal(signal)),
      updatedAt: now
    };
    await persistRiskCase(req, updated);
    riskSignalsStore.set(signal.id, { ...signal, status: 'linked' });
    return { signal: riskSignalsStore.get(signal.id)!, riskCase: updated, deduplicated: false };
  }

  const riskCase: RiskCase = {
    id: `risk_case_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    subjectUserId: subject.subjectUserId,
    subjectRole: subject.subjectRole,
    status: signal.manualReviewRequired ? 'under_review' : 'open',
    priority: signal.severity,
    signalIds: [signal.id],
    incidentIds: signal.incidentId ? [signal.incidentId] : [],
    evidence: evidenceFromSignal(signal),
    notes: [],
    actions: [],
    createdAt: now,
    updatedAt: now,
    requestId: req?.requestId
  };
  await persistRiskCase(req, riskCase);
  riskSignalsStore.set(signal.id, { ...signal, status: 'linked' });
  await riskAudit(req, 'RISK_CASE_CREATED', 'RISK_CASE', riskCase.id, {
    subjectRole: riskCase.subjectRole,
    priority: riskCase.priority,
    signalId: signal.id
  });
  metrics.increment('risk_cases_open');
  return { signal: riskSignalsStore.get(signal.id)!, riskCase, deduplicated: false };
}

function cancellationCountForActor(userId: string, role: UserRole): number {
  const windowMs = riskThresholds.cancellationWindowHours * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  return Array.from(ridesStore.values()).filter((ride) =>
    ride.cancelledByRole === (role === 'DRIVER' ? 'DRIVER' : 'CUSTOMER') &&
    (role === 'DRIVER' ? ride.driverId === userId : ride.customerId === userId || ride.passengerId === userId) &&
    ride.cancelledAt &&
    Date.parse(ride.cancelledAt) >= cutoff
  ).length;
}

async function maybeCreateCancellationRisk(req: AuthenticatedRequest, ride: Ride): Promise<void> {
  if (!req.user) return;
  const count = cancellationCountForActor(req.user.uid, req.user.role);
  if (count < riskThresholds.maxCancellations) return;
  await createRiskSignal(req, {
    type: 'repeated_ride_cancellations',
    severity: count >= riskThresholds.maxCancellations + 2 ? 'high' : 'medium',
    userId: req.user.role === 'DRIVER' ? undefined : req.user.uid,
    driverId: req.user.role === 'DRIVER' ? req.user.uid : undefined,
    rideId: ride.id,
    source: 'ride_abuse',
    metadata: {
      cancellationCount: count,
      windowHours: riskThresholds.cancellationWindowHours,
      threshold: riskThresholds.maxCancellations
    },
    manualReviewRequired: true
  });
}

async function getRideForSafety(req: AuthenticatedRequest, rideId: string): Promise<Ride | null> {
  if (usePersistentStore(req)) return firestoreRideRepository.getRide(rideId);
  return ridesStore.get(rideId) || null;
}

function isRideActiveForSafety(ride: Ride): boolean {
  return !['TRIP_COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER', 'NO_DRIVER_FOUND', 'NO_DRIVER_AVAILABLE'].includes(ride.status);
}

function isSensitiveIncident(type: SafetyIncidentType): boolean {
  return type === 'harassment' || type === 'unsafe_driver' || type === 'unsafe_passenger';
}

function rideSnapshotForSafety(ride: Ride): Record<string, unknown> {
  return {
    rideId: ride.id,
    rideStatus: ride.status,
    customerId: ride.customerId || ride.passengerId,
    driverId: ride.driverId || null,
    vehicleType: ride.vehicleType,
    vehicle: ride.vehicle || null,
    pickup: ride.pickup,
    destination: ride.destination,
    paymentMethod: ride.paymentMethod,
    createdAt: ride.createdAt,
    assignedAt: ride.assignedAt || null
  };
}

function locationSnapshotForSafety(ride: Ride, clientLocation?: unknown): Record<string, unknown> {
  const safeClientLocation = clientLocation && typeof clientLocation === 'object'
    ? {
      latitude: typeof (clientLocation as Record<string, unknown>).latitude === 'number' ? (clientLocation as Record<string, unknown>).latitude : undefined,
      longitude: typeof (clientLocation as Record<string, unknown>).longitude === 'number' ? (clientLocation as Record<string, unknown>).longitude : undefined,
      accuracy: typeof (clientLocation as Record<string, unknown>).accuracy === 'number' ? (clientLocation as Record<string, unknown>).accuracy : undefined,
      capturedAt: typeof (clientLocation as Record<string, unknown>).capturedAt === 'string' ? (clientLocation as Record<string, unknown>).capturedAt : undefined,
      source: 'client_provided'
    }
    : null;
  return {
    receivedAt: new Date().toISOString(),
    customerLocation: safeClientLocation,
    driverLatestTrustedLocation: ride.driverLocation
      ? {
        ...ride.driverLocation,
        capturedAt: ride.driverLocationUpdatedAt || null,
        source: 'backend_driver_location'
      }
      : null,
    pickup: ride.pickup,
    destination: ride.destination,
    routeState: {
      routeDistanceMeters: ride.routeDistanceMeters || null,
      routeDurationSeconds: ride.routeDurationSeconds || null,
      routingProvider: ride.routingProvider || null
    }
  };
}

function sanitizeIncidentForUser(incident: SafetyIncident, user: AuthenticatedRequest['user']): SafetyIncident {
  if (!user || safetyAdminRoles.includes(user.role) || user.uid === incident.reporterId) return incident;
  if (!isSensitiveIncident(incident.type)) return incident;
  return {
    ...incident,
    description: undefined,
    attachments: [],
    locationSnapshot: {
      receivedAt: incident.locationSnapshot.receivedAt,
      pickup: incident.locationSnapshot.pickup,
      destination: incident.locationSnapshot.destination
    }
  };
}

async function persistSafetyIncident(req: AuthenticatedRequest, incident: SafetyIncident): Promise<void> {
  safetyIncidentsStore.set(incident.id, incident);
  if (!usePersistentStore(req)) return;
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) return;
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  await db.doc(`safetyIncidents/${incident.id}`).set({
    ...incident,
    serverCreatedAt: new Date().toISOString()
  });
}

async function persistSafetySignal(req: AuthenticatedRequest, signal: SafetySignal): Promise<void> {
  safetySignalsStore.set(signal.id, signal);
  if (!usePersistentStore(req)) return;
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) return;
  await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`safetySignals/${signal.id}`).set(signal);
}

async function safetyAudit(req: AuthenticatedRequest, incident: SafetyIncident, eventType: 'SAFETY_INCIDENT_CREATED' | 'SAFETY_SOS_TRIGGERED' | 'SAFETY_INCIDENT_ACKNOWLEDGED' | 'SAFETY_INCIDENT_ESCALATED' | 'SAFETY_INCIDENT_RESOLVED' | 'SAFETY_ATTACHMENT_ADDED') {
  try {
    await auditService.log({
      ...auditActorFromRequest(req),
      eventType,
      targetType: 'SAFETY_INCIDENT',
      targetId: incident.id,
      rideId: incident.rideId,
      source: 'BACKEND',
      metadata: {
        type: incident.type,
        severity: incident.severity,
        status: incident.status
      }
    });
  } catch {
    // Demo mode may not have Firestore-backed audit available; the incident itself is still kept.
  }
}

const maxLocationAccuracyMeters = 500;
const maxDeviceClockSkewMs = 2 * 60 * 1000;
const maxLocationStaleMs = 2 * 60 * 1000;
const maxImpossibleJumpSpeedMps = 65;

type ValidatedDriverLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  clientUpdatedAt?: string;
  skippedCount: number;
};

function validateDriverLocationPayload(req: AuthenticatedRequest, res: Response, previousRide?: Ride): ValidatedDriverLocation | null {
  const latitude = req.body?.latitude;
  const longitude = req.body?.longitude;
  const accuracy = req.body?.accuracy;
  const heading = req.body?.heading;
  const speed = req.body?.speed;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    metrics.increment('driver_location_rejected_total');
    sendError(res, 400, 'Valid latitude and longitude are required', 'INVALID_LOCATION');
    return null;
  }
  if (accuracy !== undefined && (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 5000)) {
    metrics.increment('driver_location_rejected_total');
    sendError(res, 400, 'Location accuracy must be a reasonable number', 'INVALID_LOCATION_ACCURACY');
    return null;
  }
  if (accuracy !== undefined && accuracy > maxLocationAccuracyMeters) {
    metrics.increment('driver_location_rejected_total');
    sendError(res, 400, 'Location accuracy is too low for live tracking', 'LOCATION_ACCURACY_TOO_LOW');
    return null;
  }
  if (heading !== undefined && (typeof heading !== 'number' || !Number.isFinite(heading) || heading < 0 || heading > 360)) {
    metrics.increment('driver_location_rejected_total');
    sendError(res, 400, 'Location heading must be between 0 and 360', 'INVALID_LOCATION_HEADING');
    return null;
  }
  if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0 || speed > 90)) {
    metrics.increment('driver_location_rejected_total');
    sendError(res, 400, 'Location speed must be reasonable', 'INVALID_LOCATION_SPEED');
    return null;
  }

  const skippedCount = typeof req.body.skippedCount === 'number' && Number.isFinite(req.body.skippedCount)
    ? Math.max(0, Math.min(1000, Math.floor(req.body.skippedCount)))
    : 0;
  const clientUpdatedAt = typeof req.body.clientUpdatedAt === 'string' ? req.body.clientUpdatedAt : undefined;
  const nowMs = Date.now();
  const clientMs = clientUpdatedAt ? Date.parse(clientUpdatedAt) : nowMs;
  if (!Number.isFinite(clientMs)) {
    metrics.increment('driver_location_rejected_total');
    sendError(res, 400, 'clientUpdatedAt must be a valid timestamp', 'INVALID_LOCATION_TIMESTAMP');
    return null;
  }
  if (clientMs - nowMs > maxDeviceClockSkewMs) {
    metrics.increment('driver_location_rejected_total');
    sendError(res, 400, 'Location timestamp is in the future', 'LOCATION_TIMESTAMP_FUTURE');
    return null;
  }
  if (nowMs - clientMs > maxLocationStaleMs) {
    metrics.increment('driver_location_stale_total');
    sendError(res, 409, 'Location timestamp is stale', 'LOCATION_TIMESTAMP_STALE');
    return null;
  }

  const previous = previousRide?.driverLocation;
  const previousUpdatedAt = previousRide?.driverLocationUpdatedAt ? Date.parse(previousRide.driverLocationUpdatedAt) : NaN;
  if (previous && Number.isFinite(previousUpdatedAt) && clientMs > previousUpdatedAt) {
    const elapsedSeconds = Math.max(1, (clientMs - previousUpdatedAt) / 1000);
    const movedMeters = calculateDistanceKm(previous, { latitude, longitude }) * 1000;
    if (movedMeters / elapsedSeconds > maxImpossibleJumpSpeedMps) {
      metrics.increment('driver_location_rejected_total');
      res.locals.riskSignal = {
        type: 'suspicious_location_pattern',
        severity: 'medium',
        movedMeters: Math.round(movedMeters),
        elapsedSeconds: Math.round(elapsedSeconds)
      };
      sendError(res, 409, 'Location jump is not plausible yet', 'LOCATION_IMPOSSIBLE_JUMP');
      return null;
    }
  }

  return { latitude, longitude, accuracy, heading, speed, clientUpdatedAt, skippedCount };
}

async function maybeCreateLocationRisk(req: AuthenticatedRequest, res: Response, ride: Ride): Promise<void> {
  const riskSignal = res.locals.riskSignal as Record<string, unknown> | undefined;
  if (!riskSignal || riskSignal.type !== 'suspicious_location_pattern') return;
  await createRiskSignal(req, {
    type: 'suspicious_location_pattern',
    severity: riskSignal.severity === 'high' ? 'high' : 'medium',
    driverId: req.user!.uid,
    rideId: ride.id,
    source: 'geo',
    metadata: {
      movedMeters: riskSignal.movedMeters,
      elapsedSeconds: riskSignal.elapsedSeconds,
      policy: 'pattern_review_not_confirmed_fraud'
    },
    manualReviewRequired: true
  });
}

async function notifyRideParticipants(
  ride: Ride,
  title: string,
  body: string,
  data: Record<string, string> = {}
) {
  const event = data.event || 'ride_status';
  await Promise.all([
    notifyUser({
      userId: ride.customerId || ride.passengerId,
      title,
      body,
      event,
      rideId: ride.id,
      data: { ...data, rideId: ride.id, status: ride.status }
    }),
    notifyUser({
      userId: ride.driverId,
      title,
      body,
      event,
      rideId: ride.id,
      data: { ...data, rideId: ride.id, status: ride.status }
    })
  ]);
}

async function notifyEligibleDriversForRide(ride: Ride) {
  if (!ride.id) return;
  if (!shouldUseFirestorePersistence('firebase')) return;
  const driverIds = await firestoreDispatchRepository.listEligibleDriverIdsForOffer(ride.vehicleType);
  await notifyUsers({
    userIds: driverIds,
    title: 'طلب مشوار جديد',
    body: 'يوجد طلب مشوار متاح للمراجعة.',
    event: 'new_ride_offer',
    rideId: ride.id,
    data: {
      rideId: ride.id,
      status: ride.status,
      vehicleType: ride.vehicleType
    }
  });
}

function sendTrustedRoleError(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : 'TRUSTED_ROLE_ERROR';
  if (code === 'FIREBASE_ADMIN_NOT_CONFIGURED') {
    return sendError(res, 503, 'Firebase Admin is not configured on this backend', code);
  }
  if (code === 'AUDIT_LOG_UNAVAILABLE') {
    return sendError(res, 503, 'Audit logging is unavailable on this backend', code);
  }
  if (code === 'DRIVER_KYC_NOT_FOUND') {
    return sendError(res, 404, 'Driver KYC record was not found', code);
  }
  if (code === 'DRIVER_KYC_NOT_READY') {
    return sendError(res, 409, 'Driver KYC is not ready for approval', code);
  }
  if (code === 'REJECTION_REASON_REQUIRED' || code === 'DRIVER_UID_REQUIRED' || code === 'INVALID_ROLE') {
    return sendError(res, 400, code, code);
  }
  if (code === 'TRUSTED_ADMIN_REQUIRED') {
    return sendError(res, 403, 'Trusted admin role is required', code);
  }
  if (code === 'USER_UID_REQUIRED') {
    return sendError(res, 400, 'User UID is required', code);
  }
  if (code === 'INVALID_PROFILE_PHOTO_OWNER') {
    return sendError(res, 400, 'Profile photo must belong to the authenticated user', code);
  }
  return sendError(res, 500, 'Trusted role operation failed', code);
}

// Rate Limiter Middleware (Anti-Spam)
function rateLimit(limitCount: number = 30, windowMs: number = 60000) {
  const requestLogs = new Map<string, number[]>();
  let lastSweep = Date.now();
  return (req: Request, res: Response, next: NextFunction) => {
    // Limit per authenticated user so riders/drivers sharing a NAT or proxy IP don't throttle each other;
    // fall back to the client IP for unauthenticated routes.
    const uid = (req as AuthenticatedRequest).user?.uid;
    const key = uid ? `user:${uid}` : `ip:${req.ip || 'global_client'}`;
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [entryKey, entry] of requestLogs) {
        if (!entry.length || now - entry[entry.length - 1] >= windowMs) requestLogs.delete(entryKey);
      }
      lastSweep = now;
    }
    const timestamps = (requestLogs.get(key) || []).filter((t) => now - t < windowMs);

    if (timestamps.length >= limitCount) {
      return sendError(res, 429, 'تجاوزت الحد المسموح من الطلبات. يرجى الانتظار.', 'RATE_LIMIT_EXCEEDED');
    }

    timestamps.push(now);
    requestLogs.set(key, timestamps);
    next();
  };
}

const serviceStartedAt = new Date().toISOString();

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('READINESS_TIMEOUT')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const isMetricsAuthorized = (req: Request): boolean => {
  if (!isStrictBackend()) return true;
  const token = req.headers['x-metrics-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return Boolean(backendConfig.metricsToken && token === backendConfig.metricsToken);
};

const packageVersion = (() => {
  try {
    const packagePath = path.resolve(process.cwd(), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// 1. Liveness, readiness, and production metrics
app.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    status: 'ok',
    service: 'mishwar-backend',
    mode: backendConfig.mode,
    timestamp: new Date().toISOString(),
    startedAt: serviceStartedAt,
    uptime: Math.round(process.uptime())
  });
});

app.get('/version', (_req: Request, res: Response) => {
  return res.status(200).json({
    service: 'mishwar-backend',
    version: backendConfig.releaseVersion || packageVersion,
    buildNumber: backendConfig.releaseBuildNumber || null,
    commit: backendConfig.releaseCommit || null,
    mode: backendConfig.mode,
    generatedAt: new Date().toISOString()
  });
});

app.get('/api/config/public', (_req: Request, res: Response) => {
  return sendSuccess(res, {
    supportUrl: backendConfig.supportUrl || null,
    supportEmail: backendConfig.supportEmail || null,
    privacyPolicyUrl: backendConfig.privacyPolicyUrl || null,
    termsUrl: backendConfig.termsUrl || null,
    mode: backendConfig.nodeEnv === 'production' ? undefined : backendConfig.mode
  }, 'Public app configuration fetched');
});

app.get('/ready', async (_req: Request, res: Response) => {
  const requiresFirebase = isStrictBackend() || backendConfig.useRealDatabase || backendConfig.useRealAuth;
  const geoConfig = validateGeoProviderConfig();
  const credentialSource = backendConfig.firebaseClientEmail && backendConfig.firebasePrivateKey
    ? 'service_account_env'
    : backendConfig.googleApplicationCredentials
      ? 'google_application_credentials'
      : 'application_default_credentials';
  const checks = {
    requiredConfiguration: !requiresFirebase || Boolean(backendConfig.firebaseProjectId),
    firebaseAdmin: !requiresFirebase,
    firestore: !requiresFirebase,
    realAuthEnabled: !isStrictBackend() || backendConfig.useRealAuth,
    realDatabaseEnabled: !isStrictBackend() || backendConfig.useRealDatabase,
    geoProviderConfig: geoConfig.valid
  };

  if (checks.requiredConfiguration && requiresFirebase) {
    try {
      const firebaseAdmin = await withTimeout(getFirebaseAdmin(), 2500);
      checks.firebaseAdmin = Boolean(firebaseAdmin);
      if (firebaseAdmin) {
        await withTimeout(firebaseAdmin.admin.firestore(firebaseAdmin.app).doc('system/schema').get(), 2500);
        checks.firestore = true;
      }
    } catch (error) {
      logEvent('warn', 'readiness_check_failed', {
        errorType: error instanceof Error ? error.message : 'UNKNOWN'
      });
    }
  }

  const ready = Object.values(checks).every(Boolean);
  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    service: 'mishwar-backend',
    mode: backendConfig.mode,
    timestamp: new Date().toISOString(),
    firebase: {
      projectIdConfigured: Boolean(backendConfig.firebaseProjectId),
      credentialSource,
      explicitCredentialHintConfigured: hasExplicitFirebaseAdminCredentials(),
      firestoreProbe: 'system/schema'
    },
    persistence: {
      requested: backendConfig.useRealDatabase || isStrictBackend() ? 'firestore' : 'memory',
      strictModeRequiresFirestore: isStrictBackend(),
      demoFallbackAllowed: !isStrictBackend()
    },
    checks
  });
});

app.get('/metrics', (req: Request, res: Response) => {
  if (!isMetricsAuthorized(req)) {
    metrics.increment('metrics_unauthorized_total');
    return sendError(res, 403, 'Metrics access is restricted', 'METRICS_FORBIDDEN');
  }
  return res.status(200).json(metrics.snapshot());
});

app.get('/api/geo/search', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 2) return sendSuccess(res, [], 'Place search results');
  try {
    const near = typeof req.query.latitude === 'string' && typeof req.query.longitude === 'string'
      ? assertGeoPointModel({
          latitude: Number(req.query.latitude),
          longitude: Number(req.query.longitude)
        }, 'near')
      : undefined;
    const results = await geoService.searchPlaces(query, near);
    return sendSuccess(res, results, 'Place search results');
  } catch (error) {
    if (error instanceof ApiValidationError) return sendValidationError(res, error);
    return sendError(res, 503, 'Geo search is unavailable', 'GEO_PROVIDER_UNAVAILABLE');
  }
});

app.get('/api/geo/reverse', requireApiAuth(), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const point = assertGeoPointModel({
      latitude: Number(req.query.latitude),
      longitude: Number(req.query.longitude)
    }, 'location');
    const result = await geoService.reverseGeocode(point);
    return sendSuccess(res, result, 'Reverse geocode result');
  } catch (error) {
    if (error instanceof ApiValidationError) return sendValidationError(res, error);
    return sendError(res, 503, 'Reverse geocoding is unavailable', 'GEO_PROVIDER_UNAVAILABLE');
  }
});

app.post('/api/geo/route', requireApiAuth(), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const origin = assertGeoPointModel(req.body.origin, 'origin');
    const destination = assertGeoPointModel(req.body.destination, 'destination');
    const vehicleType = req.body.vehicleType ? assertVehicleType(req.body.vehicleType) : 'CAR';
    const result = await geoService.route(origin, destination, vehicleType);
    return sendSuccess(res, result, 'Route calculated');
  } catch (error) {
    if (error instanceof ApiValidationError) return sendValidationError(res, error);
    return sendError(res, 503, 'Routing is unavailable', 'GEO_PROVIDER_UNAVAILABLE');
  }
});

app.post('/api/devices/register', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  const platform = typeof req.body.platform === 'string' ? req.body.platform.trim() : 'unknown';
  const appName = req.user!.role === 'DRIVER' ? 'driver' : 'customer';
  if (token.length < 20) {
    return sendError(res, 400, 'A valid FCM token is required', 'INVALID_DEVICE_TOKEN');
  }
  try {
    const record = await registerDeviceToken({
      userId: req.user!.uid,
      role: req.user!.role,
      token,
      platform,
      app: appName
    });
    return sendSuccess(res, record, 'Device token registered');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/devices/unregister', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  if (token.length < 20) {
    return sendError(res, 400, 'A valid FCM token is required', 'INVALID_DEVICE_TOKEN');
  }
  try {
    const record = await disableDeviceToken({
      userId: req.user!.uid,
      token,
      reason: 'client_logout'
    });
    return sendSuccess(res, record, 'Device token disabled');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/auth/passenger/complete', requireApiAuth(), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user!.role !== 'CUSTOMER') {
      return sendError(res, 403, 'Passenger onboarding can only confirm a CUSTOMER role', 'FORBIDDEN_ROLE_CHANGE');
    }
    await setTrustedRoleClaim(req.user!.uid, 'CUSTOMER');
    return sendSuccess(res, {
      uid: req.user!.uid,
      role: 'CUSTOMER'
    }, 'Passenger trusted CUSTOMER claim confirmed');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.get('/api/me', requireApiAuth(), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await getOwnProfile(req.user!.uid);
    return sendSuccess(res, profile, 'Profile fetched');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.patch('/api/me', requireApiAuth('CUSTOMER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const validation = validatePassengerProfilePatch(req.body || {});
  if (!validation.valid) return sendError(res, 400, validation.message, validation.code);
  try {
    const profile = await updatePassengerProfile(req.user!.uid, validation.data);
    return sendSuccess(res, profile, 'Passenger profile updated');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.get('/api/driver/me', [requireAuth, requireRole('DRIVER')], rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await getOwnProfile(req.user!.uid);
    return sendSuccess(res, profile.driver, 'Driver profile fetched');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.patch('/api/driver/me', [requireAuth, requireRole('DRIVER')], rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const validation = validateDriverProfilePatch(req.body || {});
  if (!validation.valid) return sendError(res, 400, validation.message, validation.code);
  try {
    const profile = await updateDriverProfile(req.user!.uid, validation.data);
    const actualPlateChanged = Boolean(validation.data.vehicle?.plateNumber && profile.kycStatus === 'needs_resubmission');
    const message = actualPlateChanged
      ? 'Driver profile updated. Vehicle identity change requires KYC resubmission.'
      : 'Driver profile updated';
    return sendSuccess(res, profile, message);
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

// 2. Server-Authoritative Pricing Calculation
app.post('/api/pricing/calculate', requireApiAuth(), rateLimit(60), async (req: Request, res: Response) => {
  const { pickup, destination, vehicleType, pricingRule, zoneMultiplier } = req.body;

  if (!pickup || !destination || !vehicleType || !pricingRule) {
    return sendError(res, 400, 'البيانات المطلوبة لحساب السعر غير مكتملة', 'INVALID_INPUT');
  }

  try {
    const route = await geoService.route(assertGeoPointModel(pickup, 'pickup'), assertGeoPointModel(destination, 'destination'), vehicleType as VehicleType);
    const distanceKm = Math.round((route.distanceMeters / 1000) * 100) / 100;
    const durationMins = Math.max(1, Math.ceil(route.durationSeconds / 60));
    const fare = calculateFare(distanceKm, durationMins, pricingRule as PricingRule, zoneMultiplier || 1.0);

    return sendSuccess(res, { fare, distanceKm, durationMins, route }, 'تم احتساب الأجرة بدقة من السيرفر');
  } catch (error) {
    if (error instanceof ApiValidationError) return sendValidationError(res, error);
    return sendError(res, 503, 'Routing is unavailable', 'GEO_PROVIDER_UNAVAILABLE');
  }
});

// Real Pilot Ride API: server-authoritative request creation.
app.post('/api/rides', requireApiAuth('CUSTOMER'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  if (!backendConfig.rideCreationEnabled) {
    return sendError(res, 503, 'Ride creation is temporarily disabled by operations', 'RIDE_CREATION_DISABLED');
  }
  try {
    const idempotencyKey = req.headers['x-idempotency-key'] as string;
    if (!idempotencyKey) {
      return sendError(res, 400, 'x-idempotency-key is required', 'MISSING_IDEMPOTENCY_KEY');
    }
    if (processedIdempotencyKeys.has(idempotencyKey)) {
      const cached = processedIdempotencyKeys.get(idempotencyKey)!;
      return sendSuccess(res, cached.response, 'Idempotent ride request replay returned safely');
    }

    const pickup = assertGeoPoint(req.body.pickup, 'pickup');
    const destination = assertGeoPoint(req.body.destination, 'destination');
    const vehicleType = assertVehicleType(req.body.vehicleType);
    const passengerCount = assertPassengerCount(req.body.passengerCount);
    const paymentMethod = assertPaymentMethod(req.body.paymentMethod || 'CASH');
    const airConditioningRequired = Boolean(req.body.airConditioningRequired);
    const pricingRule = defaultPricingRules[vehicleType] || defaultPricingRules.CAR;
    const route = await geoService.routeForRide(pickup, destination, vehicleType);
    const distanceKm = Math.round((route.distanceMeters / 1000) * 100) / 100;
    const durationMins = Math.max(1, Math.ceil(route.durationSeconds / 60));
    const fare = calculateFare(distanceKm, durationMins, pricingRule, 1);

    if (paymentMethod === 'WALLET') {
      // Fail at booking time rather than after the trip, when the wallet debit would be rejected.
      const balance = await paymentService.getWalletBalance(req.user!.uid, usePersistentStore(req));
      if (balance < fare.grossFare) {
        return sendError(res, 402, 'Wallet balance is not enough for this ride', 'INSUFFICIENT_WALLET_BALANCE');
      }
    }

    const now = new Date().toISOString();
    const rideId = `ride_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const ride: Ride = {
      id: rideId,
      rideId,
      idempotencyKey,
      customerId: req.user!.uid,
      passengerId: req.user!.uid,
      customerName: typeof req.body.customerName === 'string' ? req.body.customerName : 'MISHWAR Passenger',
      customerPhone: typeof req.body.customerPhone === 'string' ? req.body.customerPhone : req.user!.phone || '',
      customerRating: 5,
      vehicleType,
      status: 'SEARCHING_DRIVER',
      pickup,
      destination,
      passengerCount,
      airConditioningRequired,
      scheduledAt: typeof req.body.scheduledAt === 'string' ? req.body.scheduledAt : undefined,
      estimatedDistanceKm: distanceKm,
      distance: distanceKm,
      estimatedDurationMins: durationMins,
      estimatedDuration: durationMins,
      routeDistanceMeters: route.distanceMeters,
      routeDurationSeconds: route.durationSeconds,
      routingProvider: route.provider,
      routeCalculatedAt: route.calculatedAt,
      routePolyline: route.polyline,
      fare,
      estimatedFare: fare.grossFare,
      finalFare: fare.grossFare,
      paymentMethod,
      paymentStatus: 'PENDING',
      createdAt: now
    };

    if (usePersistentStore(req)) {
      const persistedRide = await firestoreRideRepository.createRideWithIdempotency(req.user!.uid, idempotencyKey, ride, auditActorFromRequest(req));
      metrics.increment('rides_created_total');
      await notifyEligibleDriversForRide(persistedRide);
      return sendSuccess(res, persistedRide, 'Ride created with persistent storage');
    }

    ridesStore.set(rideId, ride);
    processedIdempotencyKeys.set(idempotencyKey, { timestamp: Date.now(), response: ride });
    metrics.increment('rides_created_total');
    return sendSuccess(res, ride, 'Ride created with server-authoritative fare');
  } catch (error) {
    if (error instanceof ApiValidationError) return sendValidationError(res, error);
    return sendPersistenceError(res, error);
  }
});

app.get('/api/rides/active', requireApiAuth(), rateLimit(120), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const role = req.user!.role === 'DRIVER' ? 'DRIVER' : 'CUSTOMER';
      const ride = await firestoreRideRepository.listActiveRideForUser(req.user!.uid, role);
      return sendSuccess(res, ride, 'Latest ride fetched');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = Array.from(ridesStore.values())
    .filter((candidate) => req.user!.role === 'DRIVER'
      ? candidate.driverId === req.user!.uid
      : candidate.customerId === req.user!.uid)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] || null;

  return sendSuccess(res, ride, 'Latest ride fetched');
});

app.get('/api/rides/:id', requireApiAuth(), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const ride = await firestoreRideRepository.getRide(req.params.id);
      if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
      if (!requireRideAccess(req, res, ride)) return;
      return sendSuccess(res, ride, 'Ride fetched');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireRideAccess(req, res, ride)) return;
  return sendSuccess(res, ride, 'Ride fetched');
});

app.post('/api/rides/:id/location', requireApiAuth('DRIVER'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const existingRide = await firestoreRideRepository.getRide(req.params.id);
      if (!existingRide) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
      if (!requireAssignedDriver(req, res, existingRide)) return;
      const location = validateDriverLocationPayload(req, res, existingRide);
      if (!location) {
        await maybeCreateLocationRisk(req, res, existingRide);
        return;
      }
      const updated = await firestoreRideRepository.updateDriverLocation(req.params.id, req.user!.uid, {
        driverId: req.user!.uid,
        latitude: location.latitude,
        longitude: location.longitude,
        rideId: req.params.id,
        heading: location.heading,
        speed: location.speed,
        accuracy: location.accuracy,
        clientUpdatedAt: location.clientUpdatedAt,
        updatedAt: new Date().toISOString()
      });
      metrics.increment('driver_location_updates_total');
      if (location.skippedCount > 0) metrics.increment('driver_location_updates_skipped_total', location.skippedCount);
      return sendSuccess(res, updated, 'Driver location updated');
    } catch (error) {
      metrics.increment('location_write_failures_total');
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (ride.driverId !== req.user!.uid) {
    return sendError(res, 403, 'Only the assigned driver can update this location', 'RIDE_FORBIDDEN');
  }
  if (['TRIP_COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'].includes(ride.status)) {
    return sendError(res, 409, 'Location updates are closed for this ride', 'RIDE_NOT_ACTIVE');
  }

  const location = validateDriverLocationPayload(req, res, ride);
  if (!location) {
    await maybeCreateLocationRisk(req, res, ride);
    return;
  }

  const updated = {
    ...ride,
    driverLocation: {
      latitude: location.latitude,
      longitude: location.longitude,
      addressName: 'Current driver location',
      accuracy: location.accuracy,
      heading: location.heading,
      speed: location.speed
    },
    driverLocationUpdatedAt: new Date().toISOString()
  };
  ridesStore.set(ride.id, updated);
  metrics.increment('driver_location_updates_total');
  if (location.skippedCount > 0) metrics.increment('driver_location_updates_skipped_total', location.skippedCount);
  return sendSuccess(res, updated, 'Driver location updated');
});

const closedRideStatuses: RideStatus[] = [
  'TRIP_COMPLETED',
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_PASSENGER',
  'CANCELLED_BY_DRIVER',
  'NO_DRIVER_FOUND',
  'NO_DRIVER_AVAILABLE'
];

// Demo-only short-lived exclusive offers so concurrent drivers polling /api/dispatch/incoming
// are shown different searching rides instead of all racing for the oldest one. Firestore
// mode uses persistent rideOffers/rideOfferLocks in FirestoreDispatchRepository.
const RIDE_OFFER_TTL_MS = Math.max(100, backendConfig.dispatchOfferTtlMs);
const rideOffers = new Map<string, { driverId: string; expiresAt: number }>(); // rideId -> current offer

function pickSearchingRideForDriver(candidates: Ride[], driverId: string): Ride | null {
  const now = Date.now();
  for (const [rideId, offer] of rideOffers) {
    if (offer.expiresAt <= now) rideOffers.delete(rideId);
  }
  const ownOffer = candidates.find((ride) => rideOffers.get(ride.id)?.driverId === driverId);
  if (ownOffer) return ownOffer;
  const next = candidates.find((ride) => !rideOffers.has(ride.id));
  if (!next) return null;
  rideOffers.set(next.id, { driverId, expiresAt: now + RIDE_OFFER_TTL_MS });
  return next;
}

function findActiveRideForDriver(driverId: string, excludeRideId?: string): Ride | undefined {
  return Array.from(ridesStore.values())
    .filter((ride) => ride.driverId === driverId && ride.id !== excludeRideId && !closedRideStatuses.includes(ride.status))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function updateRideTransition(
  rideId: string,
  nextStatus: RideStatus,
  patch: Partial<Ride> = {}
): { success: boolean; ride?: Ride; error?: string } {
  const ride = ridesStore.get(rideId);
  if (!ride) return { success: false, error: 'RIDE_NOT_FOUND' };

  const allowedTransitions: Record<RideStatus, RideStatus[]> = {
    REQUESTED: ['SEARCHING_DRIVER', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER'],
    SEARCHING_DRIVER: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'NO_DRIVER_FOUND', 'NO_DRIVER_AVAILABLE', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER'],
    DRIVER_ASSIGNED: ['DRIVER_ARRIVING', 'DRIVER_ON_THE_WAY', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ARRIVING: ['DRIVER_ARRIVED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ON_THE_WAY: ['DRIVER_ARRIVED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ARRIVED: ['TRIP_STARTED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    TRIP_STARTED: ['TRIP_COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    TRIP_COMPLETED: [],
    CANCELLED_BY_CUSTOMER: [],
    CANCELLED_BY_PASSENGER: [],
    CANCELLED_BY_DRIVER: [],
    NO_DRIVER_FOUND: [],
    NO_DRIVER_AVAILABLE: []
  };

  if (!allowedTransitions[ride.status]?.includes(nextStatus)) {
    return { success: false, error: 'INVALID_RIDE_TRANSITION' };
  }

  const updated = { ...ride, ...patch, status: nextStatus };
  ridesStore.set(rideId, updated);
  rideOffers.delete(rideId);
  if (closedRideStatuses.includes(nextStatus)) activeRideLocks.delete(rideId);
  return { success: true, ride: updated };
}

app.post('/api/rides/:id/accept', requireApiAuth('DRIVER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const ride = await firestoreDispatchRepository.acceptRide(
        req.params.id,
        req.user!.uid,
        typeof req.body.driverName === 'string' ? req.body.driverName : 'MISHWAR Driver',
        auditActorFromRequest(req)
      );
      metrics.increment('rides_accepted_total');
      await notifyRideParticipants(ride, 'تم قبول المشوار', 'الكابتن في الطريق إليك.', { event: 'ride_accepted' });
      return sendSuccess(res, ride, 'Ride accepted');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (ride.driverId && ride.driverId !== req.user!.uid) {
    metrics.increment('ride_assignment_conflicts_total');
    return sendError(res, 409, 'Ride already assigned to another driver', 'RIDE_ALREADY_ASSIGNED');
  }
  if (activeRideLocks.has(ride.id) && activeRideLocks.get(ride.id) !== req.user!.uid) {
    metrics.increment('ride_assignment_conflicts_total');
    return sendError(res, 409, 'Ride already assigned to another driver', 'RIDE_ALREADY_ASSIGNED');
  }
  if (findActiveRideForDriver(req.user!.uid, ride.id)) {
    metrics.increment('ride_assignment_conflicts_total');
    return sendError(res, 409, 'Driver already has an active ride', 'DRIVER_ALREADY_BUSY');
  }
  activeRideLocks.set(ride.id, req.user!.uid);
  const result = updateRideTransition(ride.id, 'DRIVER_ARRIVING', {
    driverId: req.user!.uid,
    driverName: typeof req.body.driverName === 'string' ? req.body.driverName : 'MISHWAR Driver',
    assignedAt: new Date().toISOString()
  });
  if (!result.success) {
    if (!ride.driverId) activeRideLocks.delete(ride.id);
    return sendError(res, 409, result.error || 'Ride accept failed', result.error || 'RIDE_ACCEPT_FAILED');
  }
  metrics.increment('rides_accepted_total');
  await notifyRideParticipants(result.ride!, 'تم قبول المشوار', 'الكابتن في الطريق إليك.', { event: 'ride_accepted' });
  return sendSuccess(res, result.ride, 'Ride accepted');
});

app.get('/api/dispatch/incoming', requireApiAuth('DRIVER'), rateLimit(120), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const activeRide = await firestoreRideRepository.listActiveRideForUser(req.user!.uid, 'DRIVER');
      const incomingRide = activeRide || (await firestoreDispatchRepository.getOrCreateOfferForDriver(
          req.user!.uid,
          await firestoreRideRepository.listSearchingRidesForDriver(req.user!.uid),
          RIDE_OFFER_TTL_MS
        ));
      return sendSuccess(res, incomingRide, incomingRide ? 'Incoming ride fetched' : 'No eligible ride offer is currently available');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const driverId = req.user!.uid;
  const activeRide = findActiveRideForDriver(driverId);
  const incomingRide = activeRide || pickSearchingRideForDriver(
    Array.from(ridesStore.values())
      .filter((ride) => ride.status === 'SEARCHING_DRIVER' && !ride.driverId && !ride.declinedByDriverIds?.includes(driverId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    driverId
  );

  return sendSuccess(res, incomingRide, 'Incoming ride fetched');
});

app.post('/api/rides/:id/decline', requireApiAuth('DRIVER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      // A decline only removes the ride from this driver's queue; it stays SEARCHING_DRIVER for others.
      const updated = await firestoreRideRepository.declineRide(req.params.id, req.user!.uid, auditActorFromRequest(req));
      metrics.increment('rides_declined_total');
      return sendSuccess(res, updated, 'Ride declined');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (ride.status !== 'SEARCHING_DRIVER' || ride.driverId) {
    return sendError(res, 409, 'Ride is no longer available to decline', 'RIDE_NOT_AVAILABLE');
  }
  const updated: Ride = {
    ...ride,
    declinedByDriverIds: Array.from(new Set([...(ride.declinedByDriverIds || []), req.user!.uid]))
  };
  ridesStore.set(ride.id, updated);
  rideOffers.delete(ride.id);
  metrics.increment('rides_declined_total');
  return sendSuccess(res, updated, 'Ride declined');
});

app.post('/api/rides/:id/cancel', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const ride = await firestoreRideRepository.getRide(req.params.id);
      if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
      if (!requireRideAccess(req, res, ride)) return;
      const nextStatus: RideStatus = req.user!.role === 'DRIVER' ? 'CANCELLED_BY_DRIVER' : 'CANCELLED_BY_CUSTOMER';
      const updated = await firestoreRideRepository.transitionRide(ride.id, nextStatus, {
        cancellationReason: typeof req.body.reason === 'string' ? req.body.reason : 'Cancelled',
        cancelledByRole: req.user!.role === 'DRIVER' ? 'DRIVER' : 'CUSTOMER',
        cancelledAt: new Date().toISOString()
      }, {
        actor: auditActorFromRequest(req),
        eventType: 'RIDE_CANCELLED'
      });
      metrics.increment('rides_cancelled_total');
      await maybeCreateCancellationRisk(req, updated);
      await notifyRideParticipants(updated, 'تم إلغاء المشوار', 'تم تحديث حالة المشوار إلى ملغى.', { event: 'ride_cancelled' });
      return sendSuccess(res, updated, 'Ride cancelled');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireRideAccess(req, res, ride)) return;
  const nextStatus: RideStatus = req.user!.role === 'DRIVER' ? 'CANCELLED_BY_DRIVER' : 'CANCELLED_BY_CUSTOMER';
  const result = updateRideTransition(ride.id, nextStatus, {
    cancellationReason: typeof req.body.reason === 'string' ? req.body.reason : 'Cancelled',
    cancelledByRole: req.user!.role === 'DRIVER' ? 'DRIVER' : 'CUSTOMER',
    cancelledAt: new Date().toISOString()
  });
  if (!result.success) return sendError(res, 409, result.error || 'Ride cancel failed', result.error || 'RIDE_CANCEL_FAILED');
  metrics.increment('rides_cancelled_total');
  await maybeCreateCancellationRisk(req, result.ride!);
  await notifyRideParticipants(result.ride!, 'تم إلغاء المشوار', 'تم تحديث حالة المشوار إلى ملغى.', { event: 'ride_cancelled' });
  return sendSuccess(res, result.ride, 'Ride cancelled');
});

app.post('/api/rides/:id/arrived', requireApiAuth('DRIVER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const ride = await firestoreRideRepository.getRide(req.params.id);
      if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
      if (!requireAssignedDriver(req, res, ride)) return;
      const updated = await firestoreRideRepository.transitionRide(req.params.id, 'DRIVER_ARRIVED', { arrivedAt: new Date().toISOString() }, {
        actor: auditActorFromRequest(req),
        eventType: 'RIDE_ARRIVED'
      });
      await notifyRideParticipants(updated, 'وصل الكابتن', 'الكابتن وصل إلى موقع الانطلاق.', { event: 'driver_arrived' });
      return sendSuccess(res, updated, 'Driver arrived');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireAssignedDriver(req, res, ride)) return;
  const result = updateRideTransition(req.params.id, 'DRIVER_ARRIVED', { arrivedAt: new Date().toISOString() });
  if (!result.success) return sendError(res, 409, result.error || 'Invalid ride transition', result.error || 'INVALID_RIDE_TRANSITION');
  await notifyRideParticipants(result.ride!, 'وصل الكابتن', 'الكابتن وصل إلى موقع الانطلاق.', { event: 'driver_arrived' });
  return sendSuccess(res, result.ride, 'Driver arrived');
});

app.post('/api/rides/:id/start', requireApiAuth('DRIVER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const ride = await firestoreRideRepository.getRide(req.params.id);
      if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
      if (!requireAssignedDriver(req, res, ride)) return;
      const updated = await firestoreRideRepository.transitionRide(req.params.id, 'TRIP_STARTED', { startedAt: new Date().toISOString() }, {
        actor: auditActorFromRequest(req),
        eventType: 'RIDE_STARTED'
      });
      await notifyRideParticipants(updated, 'بدأ المشوار', 'المشوار جارٍ الآن.', { event: 'ride_started' });
      return sendSuccess(res, updated, 'Trip started');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireAssignedDriver(req, res, ride)) return;
  const result = updateRideTransition(req.params.id, 'TRIP_STARTED', { startedAt: new Date().toISOString() });
  if (!result.success) return sendError(res, 409, result.error || 'Invalid ride transition', result.error || 'INVALID_RIDE_TRANSITION');
  await notifyRideParticipants(result.ride!, 'بدأ المشوار', 'المشوار جارٍ الآن.', { event: 'ride_started' });
  return sendSuccess(res, result.ride, 'Trip started');
});

app.post('/api/rides/:id/complete', requireApiAuth('DRIVER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (usePersistentStore(req)) {
    try {
      const ride = await firestoreRideRepository.getRide(req.params.id);
      if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
      if (!requireAssignedDriver(req, res, ride)) return;
      const updated = await firestoreRideRepository.transitionRide(req.params.id, 'TRIP_COMPLETED', {
        completedAt: new Date().toISOString(),
        paymentStatus: 'PENDING'
      }, {
        actor: auditActorFromRequest(req),
        eventType: 'RIDE_COMPLETED'
      });
      metrics.increment('rides_completed_total');
      await notifyRideParticipants(updated, 'اكتمل المشوار', 'شكراً لاستخدام مشوار.', { event: 'ride_completed' });
      return sendSuccess(res, updated, 'Trip completed');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  const ride = ridesStore.get(req.params.id);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireAssignedDriver(req, res, ride)) return;
  const result = updateRideTransition(req.params.id, 'TRIP_COMPLETED', {
    completedAt: new Date().toISOString(),
    paymentStatus: 'PENDING'
  });
  if (!result.success) return sendError(res, 409, result.error || 'Invalid ride transition', result.error || 'INVALID_RIDE_TRANSITION');
  metrics.increment('rides_completed_total');
  await notifyRideParticipants(result.ride!, 'اكتمل المشوار', 'شكراً لاستخدام مشوار.', { event: 'ride_completed' });
  return sendSuccess(res, result.ride, 'Trip completed');
});

// 3. Create Ride with Strict Idempotency
app.post('/api/rides/create', requireApiAuth('CUSTOMER'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) {
    return sendError(res, 400, 'مفتاح الحماية ضد التكرار مطلوب (x-idempotency-key)', 'MISSING_IDEMPOTENCY_KEY');
  }

  // Check if request was already processed

  if (processedIdempotencyKeys.has(idempotencyKey)) {
    const cached = processedIdempotencyKeys.get(idempotencyKey)!;
    return sendSuccess(res, cached.response, 'تم استرجاع الطلب السابق بنجاح (Idempotency Safe)');
  }

  const { customerName, customerPhone, pickup, destination, vehicleType } = req.body;

  if (!pickup || !destination || !vehicleType) {
    return sendError(res, 400, 'بيانات طلب المشوار غير مكتملة', 'INVALID_RIDE_PAYLOAD');
  }

  let trustedPickup: ReturnType<typeof assertGeoPoint>;
  let trustedDestination: ReturnType<typeof assertGeoPoint>;
  let trustedVehicleType: VehicleType;
  let route: Awaited<ReturnType<typeof geoService.routeForRide>>;
  let distanceKm: number;
  let durationMins: number;
  let fare: ReturnType<typeof calculateFare>;
  try {
    trustedPickup = assertGeoPoint(pickup, 'pickup');
    trustedDestination = assertGeoPoint(destination, 'destination');
    trustedVehicleType = assertVehicleType(vehicleType);
    const pricingRule = defaultPricingRules[trustedVehicleType] || defaultPricingRules.CAR;
    route = await geoService.routeForRide(trustedPickup, trustedDestination, trustedVehicleType);
    distanceKm = Math.round((route.distanceMeters / 1000) * 100) / 100;
    durationMins = Math.max(1, Math.ceil(route.durationSeconds / 60));
    fare = calculateFare(distanceKm, durationMins, pricingRule, 1);
  } catch (error) {
    if (error instanceof ApiValidationError) return sendValidationError(res, error);
    return sendError(res, 503, 'Routing is unavailable', 'GEO_PROVIDER_UNAVAILABLE');
  }

  const rideId = `ride_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const createdRide: Partial<Ride> = {
    id: rideId,
    rideId,
    idempotencyKey,
    customerId: req.user!.uid,
    passengerId: req.user!.uid,
    customerName,
    customerPhone,
    customerRating: 5,
    pickup: trustedPickup,
    destination: trustedDestination,
    vehicleType: trustedVehicleType,
    passengerCount: 1,
    airConditioningRequired: false,
    estimatedDistanceKm: distanceKm,
    distance: distanceKm,
    estimatedDurationMins: durationMins,
    estimatedDuration: durationMins,
    routeDistanceMeters: route.distanceMeters,
    routeDurationSeconds: route.durationSeconds,
    routingProvider: route.provider,
    routeCalculatedAt: route.calculatedAt,
    routePolyline: route.polyline,
    fare,
    estimatedFare: typeof fare?.grossFare === 'number' ? fare.grossFare : undefined,
    finalFare: typeof fare?.grossFare === 'number' ? fare.grossFare : undefined,
    status: 'SEARCHING_DRIVER',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    createdAt: new Date().toISOString()
  };

  if (usePersistentStore(req)) {
    try {
      const persistedRide = await firestoreRideRepository.createRideWithIdempotency(req.user!.uid, idempotencyKey, createdRide as Ride, auditActorFromRequest(req));
      metrics.increment('rides_created_total');
      await notifyEligibleDriversForRide(persistedRide);
      return sendSuccess(res, persistedRide, 'Ride created with persistent storage');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  // Cache response for 10 minutes
  processedIdempotencyKeys.set(idempotencyKey, {
    timestamp: Date.now(),
    response: createdRide
  });
  metrics.increment('rides_created_total');

  return sendSuccess(res, createdRide, 'تم إنشاء المشوار بنجاح وبدء محرك التوزيع');
});

// 4. Dispatch Accept (Atomic Driver Locking to prevent race conditions)
app.post('/api/dispatch/accept', requireApiAuth('DRIVER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const { rideId, driverName } = req.body;
  const driverId = req.user!.uid;

  if (!rideId) {
    return sendError(res, 400, 'معرف الرحلة ومعرف السائق مطلوبان', 'MISSING_PARAMS');
  }

  if (usePersistentStore(req)) {
    try {
      const ride = await firestoreDispatchRepository.acceptRide(
        rideId,
        driverId,
        typeof driverName === 'string' ? driverName : 'MISHWAR Driver',
        auditActorFromRequest(req)
      );
      metrics.increment('rides_accepted_total');
      await notifyRideParticipants(ride, 'تم قبول المشوار', 'الكابتن في الطريق إليك.', { event: 'ride_accepted' });
      return sendSuccess(res, ride, 'Ride accepted with atomic assignment');
    } catch (error) {
      return sendPersistenceError(res, error);
    }
  }

  // Atomic check: Has another driver already accepted this ride?
  if (activeRideLocks.has(rideId) && activeRideLocks.get(rideId) !== driverId) {
    metrics.increment('ride_assignment_conflicts_total');
    return sendError(res, 409, 'عذراً، تم إسناد هذا المشوار لكابتن آخر بالفعل.', 'RIDE_ALREADY_ASSIGNED');
  }
  if (findActiveRideForDriver(driverId, rideId)) {
    metrics.increment('ride_assignment_conflicts_total');
    return sendError(res, 409, 'Driver already has an active ride', 'DRIVER_ALREADY_BUSY');
  }

  // Lock the ride to this driver
  activeRideLocks.set(rideId, driverId);
  metrics.increment('rides_accepted_total');

  return sendSuccess(res, {
    rideId,
    driverId,
    assignedAt: new Date().toISOString(),
    status: 'DRIVER_ARRIVING'
  }, 'تم تأكيد قبول المشوار وإسناده بنجاح');
});

// 5. Trigger SOS Emergency Broadcast
app.post('/api/sos/trigger', requireApiAuth(), rateLimit(10), (req: AuthenticatedRequest, res: Response) => {
  const { rideId, location } = req.body;

  if (!rideId || !location) {
    return sendError(res, 400, 'بيانات نداء الاستغاثة غير مكتملة', 'INVALID_SOS_PAYLOAD');
  }

  const sosAlert: SOSAlert = {
    id: `sos_${Date.now()}`,
    rideId,
    triggeredByUserId: req.user!.uid,
    triggeredByRole: req.user!.role === 'DRIVER' ? 'DRIVER' : 'CUSTOMER',
    location,
    timestamp: new Date().toISOString(),
    status: 'ACTIVE'
  };

  logEvent('warn', 'sos_alert_triggered', {
    requestId: req.requestId,
    rideId,
    triggeredByRole: sosAlert.triggeredByRole
  });

  return sendSuccess(res, sosAlert, 'تم إرسال نداء الطوارئ وتنبيه عمليات مشوار بنجاح');
});

async function handleCreatePaymentRequest(req: AuthenticatedRequest, res: Response) {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) {
    return sendError(res, 400, 'x-idempotency-key is required', 'MISSING_IDEMPOTENCY_KEY');
  }

  try {
    const rideId = typeof req.body.rideId === 'string' ? req.body.rideId : '';
    const method = req.body.paymentMethod || req.body.method;
    if (!rideId || !method) return sendError(res, 400, 'rideId and paymentMethod are required', 'INVALID_PAYMENT_PAYLOAD');
    if (method === 'digital_provider' && !backendConfig.digitalPaymentsEnabled) {
      return sendError(res, 503, 'Digital payments are temporarily disabled by operations', 'DIGITAL_PAYMENTS_DISABLED');
    }
    const response = await paymentService.createRidePayment({
      user: req.user!,
      rideId,
      method,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req),
      demoRide: ridesStore.get(rideId) || null
    });
    metrics.increment('payment_operations_total');
    if (response.payment.status === 'failed') {
      metrics.increment('wallet_operation_failures_total');
      return sendError(res, 402, 'Payment failed', 'PAYMENT_FAILED', response);
    }
    await notifyUser({
      userId: req.user!.uid,
      title: 'تم تحديث حالة الدفع',
      body: 'تمت معالجة عملية الدفع للمشوار.',
      event: 'payment_status',
      rideId,
      data: {
        event: 'payment_status',
        rideId,
        status: String(response.payment.status || '')
      }
    });
    return sendSuccess(res, response, 'Payment processed');
  } catch (error) {
    return sendPaymentError(res, error);
  }
}

// 6. Payment Core: server-trusted fare, idempotency, ledger, provider adapter
app.post('/api/payments', requireApiAuth('CUSTOMER'), rateLimit(30), handleCreatePaymentRequest);

app.post('/api/payments/ride', requireApiAuth('CUSTOMER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  req.body.paymentMethod = req.body.paymentMethod || req.body.method;
  return handleCreatePaymentRequest(req, res);
});

app.post('/api/payments/cash/confirm', requireApiAuth('DRIVER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) return sendError(res, 400, 'x-idempotency-key is required', 'MISSING_IDEMPOTENCY_KEY');
  try {
    const rideId = typeof req.body.rideId === 'string' ? req.body.rideId : '';
    if (!rideId) return sendError(res, 400, 'rideId is required', 'INVALID_PAYMENT_PAYLOAD');
    const response = await paymentService.confirmCashPayment({
      user: req.user!,
      rideId,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req),
      demoRide: ridesStore.get(rideId) || null
    });
    metrics.increment('payment_operations_total');
    await Promise.all([
      notifyUser({
        userId: response.payment.customerId,
        title: 'تم تأكيد الدفع النقدي',
        body: 'تم تسجيل حالة الدفع للمشوار.',
        event: 'payment_status',
        rideId,
        data: { event: 'payment_status', rideId, status: response.payment.status }
      }),
      notifyUser({
        userId: response.payment.driverId || req.user!.uid,
        title: 'تم تأكيد الدفع النقدي',
        body: 'تم تسجيل حالة الدفع للمشوار.',
        event: 'payment_status',
        rideId,
        data: { event: 'payment_status', rideId, status: response.payment.status }
      })
    ]);
    return sendSuccess(res, response, 'Cash payment confirmed');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/rides/:rideId/payment', requireApiAuth(), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payment = await paymentService.getPaymentForRide({
      user: req.user!,
      rideId: req.params.rideId,
      usePersistentStore: usePersistentStore(req),
      demoRide: ridesStore.get(req.params.rideId) || null
    });
    return sendSuccess(res, payment, 'Ride payment fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/payments/webhooks/:provider', rateLimit(120), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const response = await paymentService.processWebhook({
      provider: req.params.provider,
      headers: req.headers,
      body: req.body,
      requestId: req.requestId,
      usePersistentStore: backendConfig.useRealDatabase || isStrictBackend()
    });
    return sendSuccess(res, response, 'Webhook processed');
  } catch (error) {
    const paymentError = asPaymentError(error);
    if (paymentError.code === 'DUPLICATE_WEBHOOK') {
      return sendSuccess(res, { duplicate: true }, 'Duplicate webhook ignored safely');
    }
    return sendPaymentError(res, error);
  }
});

// 6B. Financial operations: reconciliation, payouts, refunds, settlements, adjustments
app.get('/api/driver/finance', requireApiAuth('DRIVER'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const finance = await financialOperationsService.getDriverFinance({
      user: req.user!,
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, finance, 'Driver finance summary fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/driver/earnings', requireApiAuth('DRIVER'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const finance = await financialOperationsService.getDriverFinance({
      user: req.user!,
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, finance.recentTransactions, 'Driver earnings fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/driver/payouts', requireApiAuth('DRIVER'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const finance = await financialOperationsService.getDriverFinance({
      user: req.user!,
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, finance.payouts, 'Driver payouts fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/driver/payouts', requireApiAuth('DRIVER'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  if (!backendConfig.payoutsEnabled) {
    return sendError(res, 503, 'Payouts are temporarily disabled by operations', 'PAYOUTS_DISABLED');
  }
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) return sendError(res, 400, 'x-idempotency-key is required', 'MISSING_IDEMPOTENCY_KEY');
  try {
    const payout = await financialOperationsService.requestPayout({
      user: req.user!,
      amount: Number(req.body.amount),
      method: req.body.method,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    metrics.increment('payouts_total');
    return sendSuccess(res, payout, 'Payout requested');
  } catch (error) {
    metrics.increment('payouts_failed_total');
    const paymentError = asPaymentError(error);
    if (paymentError.code === 'INSUFFICIENT_PAYOUT_BALANCE') {
      await createRiskSignal(req, {
        type: 'rapid_payout_requests',
        severity: 'medium',
        driverId: req.user!.uid,
        source: 'financial',
        metadata: {
          reason: paymentError.code,
          threshold: riskThresholds.maxPayoutRequests,
          requestedAmount: Number(req.body.amount)
        },
        manualReviewRequired: true
      });
    }
    return sendPaymentError(res, error);
  }
});

app.get('/api/payments/:id', requireApiAuth(), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payment = await paymentService.getPaymentById({
      user: req.user!,
      paymentId: req.params.id,
      usePersistentStore: usePersistentStore(req)
    });
    if (!payment) return sendError(res, 404, 'Payment not found', 'PAYMENT_NOT_FOUND');
    return sendSuccess(res, payment, 'Payment fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/payments/:id/refunds', requireApiAuth(), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) return sendError(res, 400, 'x-idempotency-key is required', 'MISSING_IDEMPOTENCY_KEY');
  try {
    const refund = await financialOperationsService.requestRefund({
      user: req.user!,
      paymentId: req.params.id,
      amount: req.body.amount === undefined ? undefined : Number(req.body.amount),
      reason: req.body.reason,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    metrics.increment('refunds_total');
    return sendSuccess(res, refund, 'Refund requested');
  } catch (error) {
    metrics.increment('refunds_failed_total');
    const paymentError = asPaymentError(error);
    if (paymentError.code === 'REFUND_AMOUNT_EXCEEDS_REMAINING') {
      await createRiskSignal(req, {
        type: 'duplicate_refund_attempt',
        severity: 'high',
        userId: req.user!.uid,
        paymentId: req.params.id,
        source: 'financial',
        metadata: {
          reason: paymentError.code,
          financialRiskFlagReference: 'financialRiskFlags',
          details: paymentError.details || {}
        },
        manualReviewRequired: true
      });
    }
    return sendPaymentError(res, error);
  }
});

app.get('/api/admin/finance/summary', requireApiAuth('FINANCE'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const report = await financialOperationsService.generateSettlement({
      user: req.user!,
      period: 'custom',
      dateFrom: String(req.query.dateFrom || '1970-01-01T00:00:00.000Z'),
      dateTo: String(req.query.dateTo || new Date().toISOString()),
      driverId: typeof req.query.driverId === 'string' ? req.query.driverId : undefined,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, report, 'Finance summary generated');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/admin/finance/settlements', requireApiAuth('FINANCE'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const report = await financialOperationsService.generateSettlement({
      user: req.user!,
      period: (req.query.period === 'daily' || req.query.period === 'weekly') ? req.query.period : 'custom',
      dateFrom: String(req.query.dateFrom || '1970-01-01T00:00:00.000Z'),
      dateTo: String(req.query.dateTo || new Date().toISOString()),
      driverId: typeof req.query.driverId === 'string' ? req.query.driverId : undefined,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, [report], 'Settlement reports fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/admin/finance/drivers', requireApiAuth('FINANCE'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  const driverId = typeof req.query.driverId === 'string' ? req.query.driverId : '';
  if (!driverId) return sendError(res, 400, 'driverId query parameter is required', 'DRIVER_ID_REQUIRED');
  try {
    const finance = await financialOperationsService.getDriverFinance({
      user: req.user!,
      driverId,
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, [finance], 'Driver finance accounts fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/admin/finance/drivers/:driverId', requireApiAuth('FINANCE'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const finance = await financialOperationsService.getDriverFinance({
      user: req.user!,
      driverId: req.params.driverId,
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, finance, 'Driver finance account fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/admin/finance/drivers/:driverId/commission-settlements', requireApiAuth('FINANCE'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) return sendError(res, 400, 'x-idempotency-key is required', 'MISSING_IDEMPOTENCY_KEY');
  try {
    const result = await financialOperationsService.settleDriverCommission({
      user: req.user!,
      driverId: req.params.driverId,
      amount: Number(req.body.amount),
      method: req.body.method,
      reference: typeof req.body.reference === 'string' ? req.body.reference : undefined,
      note: typeof req.body.note === 'string' ? req.body.note : undefined,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, result, 'Commission settlement recorded');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/admin/finance/demo-digital-payments', requireApiAuth('FINANCE'), rateLimit(10), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) return sendError(res, 400, 'x-idempotency-key is required', 'MISSING_IDEMPOTENCY_KEY');
  try {
    const result = await financialOperationsService.recordDemoDigitalPayment({
      user: req.user!,
      driverId: String(req.body.driverId || ''),
      customerId: String(req.body.customerId || ''),
      rideId: String(req.body.rideId || ''),
      amount: Number(req.body.amount),
      allowDebtOffset: req.body.allowDebtOffset === true,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, result, 'Demo digital payment recorded');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/admin/finance/reconciliation', requireApiAuth('FINANCE'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await financialOperationsService.runFinancialReconciliation({
      user: req.user!,
      dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
      paymentId: typeof req.query.paymentId === 'string' ? req.query.paymentId : undefined,
      driverId: typeof req.query.driverId === 'string' ? req.query.driverId : undefined,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    if (result.issues.length > 0) metrics.increment('reconciliation_mismatches_total', result.issues.length);
    return sendSuccess(res, result, 'Financial reconciliation completed');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.get('/api/admin/finance/payouts', requireApiAuth('FINANCE'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const finance = await financialOperationsService.getDriverFinance({
      user: req.user!,
      driverId: typeof req.query.driverId === 'string' ? req.query.driverId : req.user!.uid,
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, finance.payouts, 'Payouts fetched');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/admin/finance/payouts/:id/approve', requireApiAuth('FINANCE'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string || `approve-${req.params.id}`;
  try {
    const payout = await financialOperationsService.approvePayout({
      user: req.user!,
      payoutId: req.params.id,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, payout, 'Payout approved');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/admin/finance/payouts/:id/complete', requireApiAuth('FINANCE'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payout = await financialOperationsService.completePayout({
      user: req.user!,
      payoutId: req.params.id,
      providerReference: typeof req.body.providerReference === 'string' ? req.body.providerReference : undefined,
      markFailed: req.body.status === 'failed',
      failedReason: typeof req.body.reason === 'string' ? req.body.reason : undefined,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, payout, 'Payout finalized');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/admin/finance/refunds/:id/approve', requireApiAuth('FINANCE'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string || `refund-approve-${req.params.id}`;
  try {
    const refund = await financialOperationsService.approveRefund({
      user: req.user!,
      refundId: req.params.id,
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, refund, 'Refund approved');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

app.post('/api/admin/finance/adjustments', requireApiAuth('FINANCE'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string || `adjust-${Date.now()}`;
  try {
    const adjustment = await financialOperationsService.createAdjustment({
      user: req.user!,
      targetUserId: String(req.body.userId || ''),
      type: req.body.type === 'adjustment_debit' ? 'adjustment_debit' : 'adjustment_credit',
      amount: Number(req.body.amount),
      reason: String(req.body.reason || ''),
      idempotencyKey,
      requestId: req.requestId,
      actor: auditActorFromRequest(req),
      usePersistentStore: usePersistentStore(req)
    });
    return sendSuccess(res, adjustment, 'Financial adjustment created');
  } catch (error) {
    return sendPaymentError(res, error);
  }
});

// 6C. Risk operations: signals, cases, review queues, notes, and safe enforcement
app.get('/api/admin/risk/signals', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  return sendSuccess(res, Array.from(riskSignalsStore.values()), 'Risk signals fetched');
});

app.get('/api/admin/risk/audit-events', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  return sendSuccess(res, riskAuditEventsStore, 'Risk audit events fetched');
});

app.post('/api/admin/risk/signals', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  const allowedTypes: RiskSignalType[] = [
    'duplicate_account_behavior',
    'repeated_ride_cancellations',
    'repeated_no_show',
    'rapid_account_switching',
    'suspicious_location_pattern',
    'repeated_failed_payment',
    'duplicate_refund_attempt',
    'rapid_payout_requests',
    'wallet_balance_mismatch',
    'provider_mismatch',
    'repeated_safety_reports',
    'kyc_inconsistency',
    'manual_review'
  ];
  const allowedSources: RiskSignal['source'][] = ['ride_abuse', 'financial', 'geo', 'safety', 'kyc', 'admin', 'system'];
  const type = allowedTypes.includes(req.body.type) ? req.body.type as RiskSignalType : 'manual_review';
  const severity = ['low', 'medium', 'high', 'critical'].includes(req.body.severity) ? req.body.severity as RiskSeverity : 'medium';
  const source = allowedSources.includes(req.body.source) ? req.body.source as RiskSignal['source'] : 'admin';
  const result = await createRiskSignal(req, {
    type,
    severity,
    userId: typeof req.body.userId === 'string' ? req.body.userId : undefined,
    driverId: typeof req.body.driverId === 'string' ? req.body.driverId : undefined,
    rideId: typeof req.body.rideId === 'string' ? req.body.rideId : undefined,
    paymentId: typeof req.body.paymentId === 'string' ? req.body.paymentId : undefined,
    incidentId: typeof req.body.incidentId === 'string' ? req.body.incidentId : undefined,
    financialRiskFlagId: typeof req.body.financialRiskFlagId === 'string' ? req.body.financialRiskFlagId : undefined,
    kycReviewId: typeof req.body.kycReviewId === 'string' ? req.body.kycReviewId : undefined,
    source,
    metadata: typeof req.body.metadata === 'object' && req.body.metadata ? req.body.metadata : {},
    manualReviewRequired: req.body.manualReviewRequired !== false
  });
  return sendSuccess(res, result, result.deduplicated ? 'Duplicate risk signal linked to existing review' : 'Risk signal created');
});

app.get('/api/admin/risk/cases', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const cases = Array.from(riskCasesStore.values())
    .filter((riskCase) => !status || riskCase.status === status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return sendSuccess(res, cases, 'Risk cases fetched');
});

app.get('/api/admin/risk/cases/:id', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  const riskCase = riskCasesStore.get(req.params.id);
  if (!riskCase) return sendError(res, 404, 'Risk case not found', 'RISK_CASE_NOT_FOUND');
  return sendSuccess(res, riskCase, 'Risk case fetched');
});

app.post('/api/admin/risk/cases/:id/assign', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  const riskCase = riskCasesStore.get(req.params.id);
  if (!riskCase) return sendError(res, 404, 'Risk case not found', 'RISK_CASE_NOT_FOUND');
  const assignedTo = typeof req.body.assignedTo === 'string' && req.body.assignedTo.trim() ? req.body.assignedTo.trim() : req.user!.uid;
  const updated: RiskCase = {
    ...riskCase,
    assignedTo,
    status: riskCase.status === 'open' ? 'under_review' : riskCase.status,
    updatedAt: new Date().toISOString()
  };
  await persistRiskCase(req, updated);
  await riskAudit(req, 'RISK_CASE_ASSIGNED', 'RISK_CASE', updated.id, { assignedTo });
  return sendSuccess(res, updated, 'Risk case assigned');
});

app.post('/api/admin/risk/cases/:id/note', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  const riskCase = riskCasesStore.get(req.params.id);
  if (!riskCase) return sendError(res, 404, 'Risk case not found', 'RISK_CASE_NOT_FOUND');
  const noteText = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 1600) : '';
  if (!noteText) return sendError(res, 400, 'Risk note is required', 'INVALID_RISK_NOTE');
  const note: RiskCaseNote = {
    id: `risk_note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    reviewerId: req.user!.uid,
    reviewerRole: req.user!.role,
    note: noteText,
    createdAt: new Date().toISOString(),
    requestId: req.requestId
  };
  const updated: RiskCase = {
    ...riskCase,
    notes: [...riskCase.notes, note],
    updatedAt: note.createdAt
  };
  await persistRiskCase(req, updated);
  await riskAudit(req, 'RISK_CASE_NOTE_ADDED', 'RISK_CASE', updated.id, { noteId: note.id });
  return sendSuccess(res, updated, 'Risk case note added');
});

app.post('/api/admin/risk/cases/:id/resolve', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  const riskCase = riskCasesStore.get(req.params.id);
  if (!riskCase) return sendError(res, 404, 'Risk case not found', 'RISK_CASE_NOT_FOUND');
  if (['resolved', 'dismissed'].includes(riskCase.status)) return sendError(res, 409, 'Risk case is already final', 'RISK_CASE_FINAL');
  const status: RiskCaseStatus = req.body.status === 'dismissed' ? 'dismissed' : 'resolved';
  const now = new Date().toISOString();
  const updated: RiskCase = {
    ...riskCase,
    status,
    resolution: typeof req.body.resolution === 'string' ? req.body.resolution.slice(0, 1600) : 'Reviewed by risk operations',
    resolvedAt: now,
    resolvedBy: req.user!.uid,
    updatedAt: now
  };
  updated.signalIds.forEach((id) => {
    const signal = riskSignalsStore.get(id);
    if (signal) riskSignalsStore.set(id, { ...signal, status: status === 'dismissed' ? 'dismissed' : 'resolved' });
  });
  await persistRiskCase(req, updated);
  await riskAudit(req, 'RISK_CASE_RESOLVED', 'RISK_CASE', updated.id, { status, resolution: updated.resolution });
  metrics.increment('risk_cases_resolved_total');
  return sendSuccess(res, updated, 'Risk case resolved');
});

app.post('/api/admin/risk/cases/:id/enforcement', requireApiAuth(), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  if (!requireRiskReviewer(req, res)) return;
  const riskCase = riskCasesStore.get(req.params.id);
  if (!riskCase) return sendError(res, 404, 'Risk case not found', 'RISK_CASE_NOT_FOUND');
  if (!['ADMIN', 'SUPER_ADMIN', 'OPS_MANAGER'].includes(req.user!.role)) {
    return sendError(res, 403, 'Account enforcement requires operations admin permission', 'RISK_ENFORCEMENT_PERMISSION_REQUIRED');
  }
  const action = String(req.body.action || '');
  if (!['warning', 'review', 'temporary_suspension', 'financial_restriction', 'full_block', 'unblock'].includes(action)) {
    return sendError(res, 400, 'Invalid risk enforcement action', 'INVALID_RISK_ACTION');
  }
  const reason = typeof req.body.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim().slice(0, 800)
    : 'Risk case reviewed by operations';
  const targetUserId = typeof req.body.userId === 'string' && req.body.userId ? req.body.userId : riskCase.subjectUserId;
  if (!targetUserId || targetUserId === 'unknown') return sendError(res, 400, 'Risk case has no enforceable subject', 'RISK_SUBJECT_REQUIRED');

  let result: Record<string, unknown> = { recordedOnly: true };
  let auditEvent: 'RISK_ACTION_SUSPENDED' | 'RISK_ACTION_BLOCKED' | 'RISK_ACTION_UNBLOCKED' | undefined;
  try {
    if (action === 'temporary_suspension') {
      result = await suspendUser(targetUserId, requireAccountAdmin(req), reason);
      auditEvent = 'RISK_ACTION_SUSPENDED';
    } else if (action === 'full_block') {
      result = await blockUser(targetUserId, requireAccountAdmin(req), reason);
      auditEvent = 'RISK_ACTION_BLOCKED';
    } else if (action === 'unblock') {
      result = await unblockUser(targetUserId, requireAccountAdmin(req), reason);
      auditEvent = 'RISK_ACTION_UNBLOCKED';
    }
  } catch (error) {
    if (req.user!.authSource !== 'demo') return sendTrustedRoleError(res, error);
    result = { recordedOnly: true, accountStatusUnavailable: true };
  }

  const now = new Date().toISOString();
  const caseAction: RiskCaseAction = {
    id: `risk_action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: action as RiskCaseActionType,
    targetUserId,
    createdBy: req.user!.uid,
    createdAt: now,
    reason,
    result,
    requestId: req.requestId
  };
  const updated: RiskCase = {
    ...riskCase,
    status: ['warning', 'review'].includes(action) ? 'under_review' : 'action_required',
    actions: [...riskCase.actions, caseAction],
    updatedAt: now
  };
  await persistRiskCase(req, updated);
  if (auditEvent) await riskAudit(req, auditEvent, 'RISK_CASE', updated.id, { action, targetUserId });
  metrics.increment('risk_actions_total');
  return sendSuccess(res, { case: updated, action: caseAction }, 'Risk enforcement action recorded');
});

// 7. Ride safety, SOS, incident lifecycle, user blocks, KYC, immutable ledger, settlements, diagnostics, backups
app.post('/api/rides/:rideId/sos', requireApiAuth(), rateLimit(6, 60000), async (req: AuthenticatedRequest, res: Response) => {
  const ride = await getRideForSafety(req, req.params.rideId);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireRideAccess(req, res, ride)) return;
  if (!isRideActiveForSafety(ride)) return sendError(res, 409, 'SOS is only available for active rides', 'RIDE_NOT_ACTIVE');

  const existing = Array.from(safetyIncidentsStore.values()).find((incident) =>
    incident.rideId === ride.id &&
    incident.reporterId === req.user!.uid &&
    incident.type === 'sos' &&
    !['resolved', 'closed', 'cancelled'].includes(incident.status)
  );
  if (existing) {
    return sendSuccess(
      res,
      { incidentId: existing.id, incident: sanitizeIncidentForUser(existing, req.user) },
      'تم إرسال تنبيه السلامة مسبقاً وهو قيد المتابعة'
    );
  }

  const now = new Date().toISOString();
  const incident: SafetyIncident = {
    id: `safety_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    rideId: ride.id,
    reporterId: req.user!.uid,
    reporterRole: req.user!.role,
    customerId: ride.customerId || ride.passengerId,
    driverId: ride.driverId,
    type: 'sos',
    severity: 'critical',
    status: 'open',
    description: typeof req.body.description === 'string' ? req.body.description.slice(0, 800) : 'SOS pressed from ride screen',
    locationSnapshot: locationSnapshotForSafety(ride, req.body.location),
    rideSnapshot: rideSnapshotForSafety(ride),
    attachments: [],
    createdAt: now,
    requestId: req.requestId
  };
  const signal: SafetySignal = {
    id: `signal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    rideId: ride.id,
    type: 'sos_pressed',
    source: req.user!.role === 'DRIVER' ? 'driver_app' : 'customer_app',
    severity: 'warning',
    createdAt: now,
    requestId: req.requestId,
    metadata: { incidentId: incident.id }
  };
  await persistSafetyIncident(req, incident);
  await persistSafetySignal(req, signal);
  await safetyAudit(req, incident, 'SAFETY_INCIDENT_CREATED');
  await safetyAudit(req, incident, 'SAFETY_SOS_TRIGGERED');
  metrics.increment('safety_incidents_total');
  metrics.increment('sos_events_total');
  metrics.increment('safety_incidents_open');
  await notifyUsers({
    userIds: ['safety_dispatch'],
    title: 'تنبيه سلامة عاجل',
    body: 'تم إنشاء حادث سلامة عاجل داخل مشوار ويحتاج مراجعة فريق العمليات.',
    event: 'sos',
    rideId: ride.id,
    data: { rideId: ride.id, incidentId: incident.id, severity: incident.severity }
  });
  return sendSuccess(res, { incidentId: incident.id, incident: sanitizeIncidentForUser(incident, req.user) }, 'تم إرسال تنبيه السلامة لفريق عمليات مشوار');
});

app.post('/api/rides/:rideId/safety/incidents', requireApiAuth(), rateLimit(12, 60000), async (req: AuthenticatedRequest, res: Response) => {
  const ride = await getRideForSafety(req, req.params.rideId);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireRideAccess(req, res, ride)) return;
  const allowedTypes: SafetyIncidentType[] = ['unsafe_driver', 'unsafe_passenger', 'accident', 'harassment', 'vehicle_issue', 'medical_concern', 'route_concern', 'lost_item', 'other'];
  const type = allowedTypes.includes(req.body.type) ? req.body.type as SafetyIncidentType : 'other';
  const severity = ['low', 'medium', 'high', 'critical'].includes(req.body.severity) ? req.body.severity as SafetyIncidentSeverity : 'medium';
  const now = new Date().toISOString();
  const incident: SafetyIncident = {
    id: `safety_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    rideId: ride.id,
    reporterId: req.user!.uid,
    reporterRole: req.user!.role,
    customerId: ride.customerId || ride.passengerId,
    driverId: ride.driverId,
    type,
    severity,
    status: 'open',
    description: typeof req.body.description === 'string' ? req.body.description.slice(0, 1600) : undefined,
    locationSnapshot: locationSnapshotForSafety(ride, req.body.location),
    rideSnapshot: rideSnapshotForSafety(ride),
    attachments: [],
    createdAt: now,
    requestId: req.requestId
  };
  await persistSafetyIncident(req, incident);
  await safetyAudit(req, incident, 'SAFETY_INCIDENT_CREATED');
  metrics.increment('safety_incidents_total');
  metrics.increment('safety_incidents_open');
  if (['high', 'critical'].includes(incident.severity)) {
    const subjectDriverId = incident.type === 'unsafe_driver' ? incident.driverId : undefined;
    const subjectUserId = incident.type === 'unsafe_passenger' ? incident.customerId : undefined;
    if (subjectDriverId || subjectUserId) {
      await createRiskSignal(req, {
        type: 'repeated_safety_reports',
        severity: incident.severity === 'critical' ? 'critical' : 'high',
        userId: subjectUserId,
        driverId: subjectDriverId,
        rideId: incident.rideId,
        incidentId: incident.id,
        source: 'safety',
        metadata: {
          incidentType: incident.type,
          reporterRole: incident.reporterRole,
          policy: 'reported_subject_only'
        },
        manualReviewRequired: true
      });
    }
  }
  return sendSuccess(res, sanitizeIncidentForUser(incident, req.user), 'Safety incident created');
});

app.post('/api/rides/:rideId/safety/signals', requireApiAuth(), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const ride = await getRideForSafety(req, req.params.rideId);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireRideAccess(req, res, ride)) return;
  const allowedTypes: SafetySignalType[] = ['long_stop', 'significant_route_deviation', 'repeated_location_loss', 'manual_concern'];
  const type = allowedTypes.includes(req.body.type) ? req.body.type as SafetySignalType : 'manual_concern';
  const signal: SafetySignal = {
    id: `signal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    rideId: ride.id,
    type,
    source: req.user!.role === 'DRIVER' ? 'driver_app' : 'customer_app',
    severity: 'warning',
    createdAt: new Date().toISOString(),
    requestId: req.requestId,
    metadata: typeof req.body.metadata === 'object' && req.body.metadata ? req.body.metadata : undefined
  };
  await persistSafetySignal(req, signal);
  try {
    await auditService.log({
      ...auditActorFromRequest(req),
      eventType: 'SAFETY_SIGNAL_CREATED',
      targetType: 'SAFETY_SIGNAL',
      targetId: signal.id,
      rideId: ride.id,
      metadata: { type: signal.type, source: signal.source }
    });
  } catch {}
  return sendSuccess(res, signal, 'Safety signal created');
});

app.get('/api/admin/safety/incidents', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  if (!requireSafetyDispatcher(req, res)) return;
  return sendSuccess(res, Array.from(safetyIncidentsStore.values()), 'Safety incidents fetched');
});

app.get('/api/admin/safety/incidents/:id', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  if (!requireSafetyDispatcher(req, res)) return;
  const incident = safetyIncidentsStore.get(req.params.id);
  if (!incident) return sendError(res, 404, 'Safety incident not found', 'SAFETY_INCIDENT_NOT_FOUND');
  return sendSuccess(res, incident, 'Safety incident fetched');
});

const updateIncidentStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  status: SafetyIncidentStatus,
  patch: Partial<SafetyIncident>,
  eventType: 'SAFETY_INCIDENT_ACKNOWLEDGED' | 'SAFETY_INCIDENT_ESCALATED' | 'SAFETY_INCIDENT_RESOLVED',
  successMessage: string
) => {
  if (!requireSafetyDispatcher(req, res)) return;
  const incident = safetyIncidentsStore.get(req.params.id);
  if (!incident) return sendError(res, 404, 'Safety incident not found', 'SAFETY_INCIDENT_NOT_FOUND');
  if (['resolved', 'closed', 'cancelled'].includes(incident.status)) return sendError(res, 409, 'Safety incident is already final', 'SAFETY_INCIDENT_FINAL');
  const updated = { ...incident, ...patch, status };
  safetyIncidentsStore.set(updated.id, updated);
  await safetyAudit(req, updated, eventType);
  if (status === 'resolved') {
    metrics.increment('safety_incidents_resolved_total');
  }
  if (status === 'escalated') metrics.increment('safety_escalations_total');
  return sendSuccess(res, updated, successMessage);
};

app.post('/api/admin/safety/incidents/:id/acknowledge', requireApiAuth(), rateLimit(30), (req: AuthenticatedRequest, res: Response) => {
  return updateIncidentStatus(req, res, 'acknowledged', {
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: req.user!.uid
  }, 'SAFETY_INCIDENT_ACKNOWLEDGED', 'Safety incident acknowledged');
});

app.post('/api/admin/safety/incidents/:id/escalate', requireApiAuth(), rateLimit(30), (req: AuthenticatedRequest, res: Response) => {
  return updateIncidentStatus(req, res, 'escalated', {
    escalatedAt: new Date().toISOString(),
    escalatedBy: req.user!.uid
  }, 'SAFETY_INCIDENT_ESCALATED', 'Safety incident escalated internally');
});

app.post('/api/admin/safety/incidents/:id/resolve', requireApiAuth(), rateLimit(30), (req: AuthenticatedRequest, res: Response) => {
  return updateIncidentStatus(req, res, 'resolved', {
    resolvedAt: new Date().toISOString(),
    resolvedBy: req.user!.uid,
    resolution: typeof req.body.resolution === 'string' ? req.body.resolution.slice(0, 1600) : 'Resolved by safety operations'
  }, 'SAFETY_INCIDENT_RESOLVED', 'Safety incident resolved');
});

app.post('/api/safety/incidents/:id/attachments', requireApiAuth(), rateLimit(10, 60000), async (req: AuthenticatedRequest, res: Response) => {
  const incident = safetyIncidentsStore.get(req.params.id);
  if (!incident) return sendError(res, 404, 'Safety incident not found', 'SAFETY_INCIDENT_NOT_FOUND');
  if (incident.reporterId !== req.user!.uid && !safetyAdminRoles.includes(req.user!.role)) {
    return sendError(res, 403, 'Forbidden for this incident attachment', 'SAFETY_INCIDENT_FORBIDDEN');
  }
  const contentType = String(req.body.contentType || '');
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(contentType)) {
    return sendError(res, 400, 'Unsupported incident attachment content type', 'UNSUPPORTED_ATTACHMENT_TYPE');
  }
  const attachment = {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    storagePath: `ride-incidents/${incident.rideId}/${incident.id}/${req.user!.uid}/${Date.now()}`,
    contentType,
    uploadedBy: req.user!.uid,
    createdAt: new Date().toISOString()
  };
  const updated = { ...incident, attachments: [attachment, ...incident.attachments] };
  safetyIncidentsStore.set(updated.id, updated);
  await safetyAudit(req, updated, 'SAFETY_ATTACHMENT_ADDED');
  return sendSuccess(res, attachment, 'Incident attachment metadata created');
});

app.post('/api/safety/reports', requireApiAuth(), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  const { rideId, reportedUserId, reportedRole, category, description, severity } = req.body;
  if (!category || !description) return sendError(res, 400, 'Safety report category and description are required', 'INVALID_SAFETY_REPORT');
  const report: SafetyReport = {
    id: `safe_${Date.now()}`,
    rideId,
    reporterUserId: req.user!.uid,
    reporterRole: req.user!.role === 'DRIVER' ? 'DRIVER' : 'CUSTOMER',
    reportedUserId,
    reportedRole,
    category,
    description,
    severity: severity || 'HIGH',
    status: 'OPEN',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignedTo: severity === 'CRITICAL' ? 'OPS_MANAGER' : 'SUPPORT'
  };
  safetyReportsStore.set(report.id, report);
  if (reportedUserId && ['HIGH', 'CRITICAL'].includes(report.severity)) {
    await createRiskSignal(req, {
      type: 'repeated_safety_reports',
      severity: report.severity === 'CRITICAL' ? 'critical' : 'high',
      userId: reportedRole === 'CUSTOMER' ? reportedUserId : undefined,
      driverId: reportedRole === 'DRIVER' ? reportedUserId : undefined,
      rideId,
      incidentId: report.id,
      source: 'safety',
      metadata: {
        category,
        reporterRole: report.reporterRole,
        policy: 'reported_subject_only'
      },
      manualReviewRequired: true
    });
  }
  return sendSuccess(res, report, 'Safety report created');
});

app.get('/api/admin/safety/reports', requireApiAuth('OPS_MANAGER'), rateLimit(60), (_req: Request, res: Response) => {
  return sendSuccess(res, Array.from(safetyReportsStore.values()), 'Safety reports fetched');
});

app.post('/api/safety/blocks', requireApiAuth(), rateLimit(20), (req: AuthenticatedRequest, res: Response) => {
  const { blockedUserId, blockedRole, reason } = req.body;
  if (!blockedUserId || !blockedRole || !reason) return sendError(res, 400, 'Block target and reason are required', 'INVALID_BLOCK_PAYLOAD');
  const block: UserBlockRecord = {
    id: `block_${Date.now()}`,
    blockedUserId,
    blockedRole,
    requestedByUserId: req.user!.uid,
    requestedByRole: req.user!.role === 'DRIVER' ? 'DRIVER' : req.user!.role === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN',
    reason,
    status: 'ACTIVE',
    createdAt: new Date().toISOString()
  };
  userBlocksStore.set(block.id, block);
  return sendSuccess(res, block, 'User block recorded for operations review');
});

app.post('/api/kyc/documents', requireApiAuth(), rateLimit(20), (req: AuthenticatedRequest, res: Response) => {
  const { type, documentUrl, expiresAt } = req.body;
  if (!type || !documentUrl) return sendError(res, 400, 'Document type and URL are required', 'INVALID_KYC_DOCUMENT');
  const document: DriverDocument = {
    id: `doc_${Date.now()}`,
    driverId: req.user!.uid,
    type,
    documentUrl,
    status: 'PENDING',
    uploadedAt: new Date().toISOString(),
    expiresAt
  };
  driverDocumentsStore.set(document.id, document);
  return sendSuccess(res, document, 'KYC document metadata stored');
});

app.post('/api/admin/drivers/:uid/approve', requireApiAuth('KYC_REVIEWER'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = requireTrustedAdminContext(req);
    const result = await approveDriver(req.params.uid, actor);
    return sendSuccess(res, result, 'Driver approved and trusted DRIVER claim granted');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/admin/drivers/:uid/reject', requireApiAuth('KYC_REVIEWER'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = requireTrustedAdminContext(req);
    const result = await rejectDriver(req.params.uid, typeof req.body.reason === 'string' ? req.body.reason : '', actor);
    return sendSuccess(res, result, 'Driver rejected without granting DRIVER claim');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/admin/users/:uid/revoke-sessions', requireApiAuth('ADMIN'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = requireAccountAdmin(req);
    const result = await revokeUserSessions(req.params.uid);
    await auditSessionRevocation(req.params.uid, actor, result.revokedAt);
    return sendSuccess(res, result, 'User sessions revoked');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/admin/users/:uid/block', requireApiAuth('ADMIN'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = requireAccountAdmin(req);
    const result = await blockUser(req.params.uid, actor, typeof req.body.reason === 'string' ? req.body.reason : undefined);
    return sendSuccess(res, result, 'User blocked and sessions revoked');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/admin/users/:uid/suspend', requireApiAuth('ADMIN'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = requireAccountAdmin(req);
    const result = await suspendUser(req.params.uid, actor, typeof req.body.reason === 'string' ? req.body.reason : undefined);
    return sendSuccess(res, result, 'User suspended and sessions revoked');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/admin/users/:uid/unblock', requireApiAuth('ADMIN'), rateLimit(20), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = requireAccountAdmin(req);
    const result = await unblockUser(req.params.uid, actor, typeof req.body.reason === 'string' ? req.body.reason : undefined);
    return sendSuccess(res, result, 'User unblocked. New login is required.');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.post('/api/admin/kyc/documents/:id/review', requireApiAuth('KYC_REVIEWER'), rateLimit(30), async (req: AuthenticatedRequest, res: Response) => {
  const document = driverDocumentsStore.get(req.params.id);
  if (!document) return sendError(res, 404, 'KYC document not found', 'KYC_DOCUMENT_NOT_FOUND');
  const { decision, notes } = req.body;
  if (!['APPROVED', 'REJECTED', 'REQUEST_CHANGES'].includes(decision)) {
    return sendError(res, 400, 'Invalid KYC decision', 'INVALID_KYC_DECISION');
  }
  const updated: DriverDocument = {
    ...document,
    status: decision === 'APPROVED' ? 'APPROVED' : decision === 'REJECTED' ? 'REJECTED' : 'PENDING',
    reviewedAt: new Date().toISOString(),
    reviewedBy: req.user!.uid,
    reviewNotes: notes,
    rejectionReason: decision === 'REJECTED' ? notes : document.rejectionReason
  };
  driverDocumentsStore.set(updated.id, updated);
  const review: KycReviewRecord = {
    id: `kyc_review_${Date.now()}`,
    driverId: updated.driverId,
    documentId: updated.id,
    decision,
    reviewerId: req.user!.uid,
    reviewerRole: 'KYC_REVIEWER',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };
  kycReviewStore.set(review.id, review);
  if (decision !== 'APPROVED') {
    await createRiskSignal(req, {
      type: 'kyc_inconsistency',
      severity: decision === 'REJECTED' ? 'medium' : 'low',
      driverId: updated.driverId,
      kycReviewId: review.id,
      source: 'kyc',
      metadata: {
        decision,
        documentId: updated.id
      },
      manualReviewRequired: decision === 'REJECTED'
    });
  }
  return sendSuccess(res, { document: updated, review }, 'KYC review recorded');
});

app.post('/api/admin/ledger/entries', requireApiAuth('FINANCE'), rateLimit(60), async (req: AuthenticatedRequest, res: Response) => {
  const { userId, type, amount, referenceId } = req.body;
  if (!userId || !type || typeof amount !== 'number' || !referenceId) {
    return sendError(res, 400, 'Ledger entry user, type, amount and reference are required', 'INVALID_LEDGER_ENTRY');
  }
  try {
    const entry = {
      transactionId: `ledger_${Date.now()}`,
      userId,
      type,
      amount,
      status: 'SUCCESS',
      referenceId,
      createdAt: new Date().toISOString(),
      immutableHash: Buffer.from(`${userId}:${type}:${amount}:${referenceId}:${Date.now()}`).toString('base64url')
    };
    const operationType = String(type).toUpperCase();
    const eventType = operationType.includes('DEBIT') || operationType.includes('PAYOUT') || operationType.includes('COMMISSION') || amount < 0
      ? 'WALLET_DEBIT'
      : 'WALLET_CREDIT';
    await auditService.log({
      ...auditActorFromRequest(req),
      eventType,
      targetType: 'WALLET',
      targetId: userId,
      source: 'PAYMENT_BACKEND',
      metadata: {
        transactionId: entry.transactionId,
        userId,
        amount,
        currency: 'YER',
        operationType: type,
        referenceId
      }
    });
    immutableLedgerStore.unshift(entry);
    return sendSuccess(res, entry, 'Immutable ledger entry appended');
  } catch (error) {
    return sendTrustedRoleError(res, error);
  }
});

app.get('/api/admin/ledger/entries', requireApiAuth('FINANCE'), rateLimit(60), (_req: Request, res: Response) => {
  return sendSuccess(res, immutableLedgerStore, 'Ledger entries fetched');
});

app.post('/api/admin/settlements/:id/paid', requireApiAuth('FINANCE'), rateLimit(30), (req: AuthenticatedRequest, res: Response) => {
  const existing = settlementsStore.get(req.params.id);
  if (!existing) return sendError(res, 404, 'Settlement not found', 'SETTLEMENT_NOT_FOUND');
  if (existing.status === 'PAID') return sendError(res, 409, 'Settlement already paid', 'SETTLEMENT_ALREADY_PAID');
  const updated: DriverSettlement = {
    ...existing,
    status: 'PAID',
    referenceNumber: req.body.referenceNumber || existing.referenceNumber,
    proofUrl: req.body.proofUrl,
    paidAt: new Date().toISOString()
  };
  settlementsStore.set(updated.id, updated);
  return sendSuccess(res, updated, 'Settlement marked paid');
});

app.post('/api/support/tickets', requireApiAuth(), rateLimit(20), (req: AuthenticatedRequest, res: Response) => {
  const category = supportCategories.includes(req.body.category) ? req.body.category as SupportTicketCategory : 'other';
  const subject = safeText(req.body.subject, 120);
  const message = safeText(req.body.message, 2000);
  if (!subject || !message) return sendError(res, 400, 'Support subject and message are required', 'INVALID_SUPPORT_TICKET');
  const priority = ['low', 'medium', 'high', 'critical'].includes(req.body.priority) ? req.body.priority : category === 'safety' ? 'high' : 'medium';
  const now = new Date().toISOString();
  const ticket: SupportTicketRecord = {
    id: `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: req.user!.uid,
    role: req.user!.role,
    rideId: safeText(req.body.rideId, 120) || undefined,
    category,
    priority,
    status: 'open',
    subject,
    message,
    createdAt: now,
    updatedAt: now,
    requestId: req.requestId
  };
  supportTicketsStore.set(ticket.id, ticket);
  metrics.increment('support_tickets_created_total');
  return sendSuccess(res, ticket, 'Support ticket created');
});

app.get('/api/support/tickets', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  const tickets = Array.from(supportTicketsStore.values())
    .filter((ticket) => ticket.userId === req.user!.uid)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return sendSuccess(res, tickets, 'Support tickets fetched');
});

app.get('/api/support/tickets/:id', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  const ticket = supportTicketsStore.get(req.params.id);
  if (!ticket) return sendError(res, 404, 'Support ticket not found', 'SUPPORT_TICKET_NOT_FOUND');
  if (ticket.userId !== req.user!.uid && !supportReviewerRoles.includes(req.user!.role)) {
    return sendError(res, 403, 'Forbidden for this support ticket', 'SUPPORT_TICKET_FORBIDDEN');
  }
  return sendSuccess(res, ticket, 'Support ticket fetched');
});

app.get('/api/admin/support/tickets', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  if (!requireSupportReviewer(req, res)) return;
  return sendSuccess(res, Array.from(supportTicketsStore.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt)), 'Support tickets fetched');
});

app.post('/api/admin/support/tickets/:id/status', requireApiAuth(), rateLimit(30), (req: AuthenticatedRequest, res: Response) => {
  if (!requireSupportReviewer(req, res)) return;
  const ticket = supportTicketsStore.get(req.params.id);
  if (!ticket) return sendError(res, 404, 'Support ticket not found', 'SUPPORT_TICKET_NOT_FOUND');
  if (!supportStatuses.includes(req.body.status)) return sendError(res, 400, 'Invalid support ticket status', 'INVALID_SUPPORT_STATUS');
  const updated = { ...ticket, status: req.body.status as SupportTicketStatus, updatedAt: new Date().toISOString() };
  supportTicketsStore.set(updated.id, updated);
  return sendSuccess(res, updated, 'Support ticket status updated');
});

app.post('/api/privacy/requests', requireApiAuth(), rateLimit(10, 60000), (req: AuthenticatedRequest, res: Response) => {
  const type = privacyRequestTypes.includes(req.body.type) ? req.body.type as PrivacyRequestType : null;
  if (!type) return sendError(res, 400, 'Invalid privacy request type', 'INVALID_PRIVACY_REQUEST');
  if (type === 'account_deletion') {
    const duplicate = Array.from(privacyRequestsStore.values()).find((request) =>
      request.userId === req.user!.uid &&
      request.type === 'account_deletion' &&
      ['pending_review', 'approved'].includes(request.status)
    );
    if (duplicate) return sendError(res, 409, 'Account deletion request is already pending review', 'DUPLICATE_ACCOUNT_DELETION_REQUEST');
  }
  const now = new Date().toISOString();
  const privacyRequest: PrivacyRequestRecord = {
    id: `privacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: req.user!.uid,
    role: req.user!.role,
    type,
    status: 'pending_review',
    message: safeText(req.body.message, 1000) || undefined,
    createdAt: now,
    updatedAt: now,
    requestId: req.requestId
  };
  privacyRequestsStore.set(privacyRequest.id, privacyRequest);
  return sendSuccess(res, privacyRequest, 'Privacy request created');
});

app.get('/api/privacy/requests', requireApiAuth(), rateLimit(60), (req: AuthenticatedRequest, res: Response) => {
  const requests = Array.from(privacyRequestsStore.values())
    .filter((request) => request.userId === req.user!.uid)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return sendSuccess(res, requests, 'Privacy requests fetched');
});

app.post('/api/analytics/events', requireApiAuth(), rateLimit(120), (req: AuthenticatedRequest, res: Response) => {
  const name = safeText(req.body.name, 80);
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(name)) return sendError(res, 400, 'Invalid analytics event name', 'INVALID_ANALYTICS_EVENT');
  const event = {
    id: `analytics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: req.user!.uid,
    role: req.user!.role,
    name,
    parameters: sanitizeAnalyticsParameters(req.body.parameters),
    createdAt: new Date().toISOString()
  };
  analyticsEventsStore.unshift(event);
  if (analyticsEventsStore.length > 500) analyticsEventsStore.splice(500);
  return sendSuccess(res, event, 'Analytics event recorded');
});

app.post('/api/rides/:rideId/rating', requireApiAuth(), rateLimit(20), (req: AuthenticatedRequest, res: Response) => {
  const ride = ridesStore.get(req.params.rideId);
  if (!ride) return sendError(res, 404, 'Ride not found', 'RIDE_NOT_FOUND');
  if (!requireRideAccess(req, res, ride)) return;
  if (ride.status !== 'TRIP_COMPLETED') return sendError(res, 409, 'Ratings are allowed only after completed rides', 'RIDE_NOT_COMPLETED');
  const isCustomerRating = req.user!.role === 'CUSTOMER' && (ride.customerId === req.user!.uid || ride.passengerId === req.user!.uid);
  if (!isCustomerRating) return sendError(res, 403, 'Only the customer can rate this ride in the current product scope', 'RATING_SCOPE_FORBIDDEN');
  if (!ride.driverId) return sendError(res, 409, 'Driver is not assigned for this ride', 'RATING_TARGET_UNAVAILABLE');
  const stars = Number(req.body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return sendError(res, 400, 'Rating stars must be between 1 and 5', 'INVALID_RATING');
  const key = `${ride.id}:${req.user!.uid}:DRIVER`;
  const reasons = Array.isArray(req.body.reasons)
    ? req.body.reasons.filter((reason: unknown): reason is string => typeof reason === 'string' && ratingReasons.includes(reason)).slice(0, 5)
    : [];
  const existing = rideRatingsStore.get(key);
  const now = new Date().toISOString();
  const rating: RideRatingRecord = {
    id: existing?.id || `rating_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    rideId: ride.id,
    fromUserId: req.user!.uid,
    toUserId: ride.driverId,
    targetRole: 'DRIVER',
    stars,
    reasons,
    comment: safeText(req.body.comment, 500) || undefined,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  rideRatingsStore.set(key, rating);
  metrics.increment(existing ? 'ride_ratings_updated_total' : 'ride_ratings_created_total');
  return sendSuccess(res, rating, existing ? 'Ride rating updated' : 'Ride rating created');
});

app.post('/api/diagnostics/events', requireApiAuth(), rateLimit(120), (req: AuthenticatedRequest, res: Response) => {
  const { source, level, message, durationMs, rideId, metadata } = req.body;
  if (!source || !level || !message) return sendError(res, 400, 'Diagnostic source, level and message are required', 'INVALID_DIAGNOSTIC_EVENT');
  const event: DiagnosticEvent = {
    id: `diag_${Date.now()}`,
    source,
    level,
    message,
    createdAt: new Date().toISOString(),
    durationMs,
    userId: req.user!.uid,
    rideId,
    metadata
  };
  diagnosticEventsStore.set(event.id, event);
  return sendSuccess(res, event, 'Diagnostic event recorded');
});

app.post('/api/admin/backups', requireApiAuth('SUPER_ADMIN'), rateLimit(5), (_req: AuthenticatedRequest, res: Response) => {
  const snapshot: BackupSnapshot = {
    id: `backup_${Date.now()}`,
    scope: 'FULL_SYSTEM',
    status: 'COMPLETED',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    storagePath: `backups/server/full-${Date.now()}.json`,
    checksum: Buffer.from(`backup:${Date.now()}`).toString('base64url')
  };
  backupSnapshotsStore.set(snapshot.id, snapshot);
  return sendSuccess(res, snapshot, 'Backup snapshot registered');
});

// 7. Pilot Config Endpoint
app.get('/api/admin/pilot-config', requireApiAuth('ADMIN'), (req: Request, res: Response) => {
  return sendSuccess(res, pilotConfig, 'تم جلب إعدادات Pilot بنجاح');
});

app.put('/api/admin/pilot-config', requireApiAuth('ADMIN'), (req: Request, res: Response) => {
  const newConfig = req.body;
  pilotConfig = { ...pilotConfig, ...newConfig };
  return sendSuccess(res, pilotConfig, 'تم تحديث إعدادات وقيود Pilot بنجاح');
});

app.use((error: unknown, req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
  metrics.increment('http_unhandled_errors_total');
  logEvent('error', 'unhandled_request_error', {
    requestId: req.requestId || res.locals.requestId,
    method: req.method,
    route: req.route?.path || req.path,
    errorType: error instanceof Error ? error.name : 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Unhandled error',
    stack: backendConfig.nodeEnv === 'production' ? undefined : error instanceof Error ? error.stack : undefined
  });
  return sendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
});

export default app;

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    logEvent('info', 'backend_started', {
      service: 'mishwar-backend',
      port: PORT,
      mode: backendConfig.mode
    });
  });

  const shutdown = (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logEvent('info', 'backend_shutdown_started', { signal });
    server.close((error?: Error) => {
      if (error) {
        logEvent('error', 'backend_shutdown_failed', { signal, message: error.message });
        process.exit(1);
      }
      logEvent('info', 'backend_shutdown_complete', { signal });
      process.exit(0);
    });
    setTimeout(() => {
      logEvent('error', 'backend_shutdown_forced', { signal });
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
