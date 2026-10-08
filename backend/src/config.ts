import dotenv from 'dotenv';

dotenv.config();

export type BackendMode = 'demo' | 'staging' | 'pilot' | 'production';

const normalizeMode = (value?: string): BackendMode => {
  const normalized = (value || 'demo').toLowerCase();
  if (normalized === 'staging' || normalized === 'pilot' || normalized === 'production') return normalized;
  return 'demo';
};

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

export const backendConfig = {
  mode: normalizeMode(process.env.APP_MODE || process.env.APP_ENV || process.env.DATA_MODE),
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 4000,
  apiToken: process.env.API_TOKEN || '',
  metricsToken: process.env.METRICS_TOKEN || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5101,http://127.0.0.1:5101,http://localhost:5102,http://127.0.0.1:5102')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '',
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET || process.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
  firebasePrivateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  useRealDatabase: toBool(process.env.USE_REAL_DATABASE, false),
  useRealAuth: toBool(process.env.USE_REAL_AUTH, false),
  useRealPayment: toBool(process.env.USE_REAL_PAYMENT, false),
  paymentProvider: process.env.PAYMENT_PROVIDER || '',
  paymentProviderBaseUrl: process.env.PAYMENT_PROVIDER_BASE_URL || '',
  paymentProviderClientId: process.env.PAYMENT_PROVIDER_CLIENT_ID || '',
  paymentProviderClientSecret: process.env.PAYMENT_PROVIDER_CLIENT_SECRET || '',
  paymentProviderWebhookSecret: process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET || '',
  minPayoutAmount: Number(process.env.MIN_PAYOUT_AMOUNT || 1000),
  maxPayoutAmount: Number(process.env.MAX_PAYOUT_AMOUNT || 500000),
  dailyPayoutLimit: Number(process.env.DAILY_PAYOUT_LIMIT || 1000000),
  maxRefundAmount: Number(process.env.MAX_REFUND_AMOUNT || 500000)
  ,
  digitalPaymentsEnabled: toBool(process.env.DIGITAL_PAYMENTS_ENABLED, false),
  payoutsEnabled: toBool(process.env.PAYOUTS_ENABLED, true),
  rideCreationEnabled: toBool(process.env.RIDE_CREATION_ENABLED, true),
  sosEscalationEnabled: toBool(process.env.SOS_ESCALATION_ENABLED, true),
  newDispatchEnabled: toBool(process.env.NEW_DISPATCH_ENABLED, true),
  geoProviderEnabled: toBool(process.env.GEO_PROVIDER_ENABLED, true),
  releaseVersion: process.env.RELEASE_VERSION || '',
  releaseCommit: process.env.RELEASE_COMMIT || '',
  releaseBuildNumber: process.env.RELEASE_BUILD_NUMBER || '',
  mapProvider: process.env.MAP_PROVIDER || process.env.VITE_MAP_PROVIDER || 'osm',
  geocodingProvider: process.env.GEOCODING_PROVIDER || 'internal',
  routingProvider: process.env.ROUTING_PROVIDER || 'internal_fallback',
  mapsApiKey: process.env.MAPS_API_KEY || '',
  geocodingApiKey: process.env.GEOCODING_API_KEY || process.env.MAPS_API_KEY || '',
  routingApiKey: process.env.ROUTING_API_KEY || process.env.MAPS_API_KEY || '',
  osrmBaseUrl: process.env.OSRM_BASE_URL || '',
  nominatimBaseUrl: process.env.NOMINATIM_BASE_URL || '',
  geoCountryBias: process.env.GEO_COUNTRY_BIAS || 'YE',
  geoRequestTimeoutMs: Number(process.env.GEO_REQUEST_TIMEOUT_MS || 3500)
  ,
  supportUrl: process.env.SUPPORT_URL || '',
  supportEmail: process.env.SUPPORT_EMAIL || '',
  privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || '',
  termsUrl: process.env.TERMS_URL || ''
};

export const isDemoBackend = (): boolean => backendConfig.mode === 'demo' || backendConfig.nodeEnv === 'development';
export const isStrictBackend = (): boolean => backendConfig.mode === 'pilot' || backendConfig.mode === 'staging' || backendConfig.mode === 'production';
