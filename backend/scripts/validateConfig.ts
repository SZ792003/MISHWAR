import fs from 'node:fs';
import path from 'node:path';
import { backendConfig, isStrictBackend } from '../src/config';
import { validateGeoProviderConfig } from '../src/geoService';

const repoRoot = path.resolve(process.cwd(), '..');

const failures: string[] = [];

const fail = (message: string): void => {
  failures.push(message);
};

const parseJsonFile = (relativePath: string): void => {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

[
  'package.json',
  'backend/package.json',
  'firebase/firebase.json',
  'firebase/firestore.indexes.json',
  'apps/customer_app/pubspec.json',
  'apps/driver_app/pubspec.json'
].forEach((relativePath) => {
  if (relativePath.endsWith('.json') && fs.existsSync(path.join(repoRoot, relativePath))) {
    parseJsonFile(relativePath);
  }
});

parseJsonFile('package.json');
parseJsonFile('backend/package.json');
parseJsonFile('firebase/firebase.json');
parseJsonFile('firebase/firestore.indexes.json');

const mode = backendConfig.mode;
const strict = isStrictBackend();
const geo = validateGeoProviderConfig();

if (strict) {
  if (!backendConfig.firebaseProjectId) fail(`${mode} requires FIREBASE_PROJECT_ID`);
  if (!backendConfig.useRealAuth) fail(`${mode} requires USE_REAL_AUTH=true so Firebase ID tokens are mandatory`);
  if (!backendConfig.useRealDatabase) fail(`${mode} requires USE_REAL_DATABASE=true so rides, dispatch, and finance never use memory persistence`);
  if (backendConfig.useRealAuth && !backendConfig.firebaseProjectId) fail(`${mode} real auth requires Firebase project configuration`);
  if (backendConfig.useRealDatabase && !backendConfig.firebaseProjectId) fail(`${mode} real database requires Firebase project configuration`);
  if (backendConfig.useRealPayment && !backendConfig.paymentProvider) fail(`${mode} real payment requires PAYMENT_PROVIDER`);
  if (backendConfig.useRealPayment && backendConfig.paymentProvider === 'mock') fail(`${mode} cannot use mock payment provider`);
  if (backendConfig.allowedOrigins.some((origin) => origin.includes('localhost') || origin.includes('127.0.0.1'))) {
    fail(`${mode} ALLOWED_ORIGINS must not include localhost`);
  }
  if (backendConfig.routingProvider === 'internal_fallback' || backendConfig.geocodingProvider === 'internal') {
    fail(`${mode} must not rely on internal geo providers`);
  }
}

if (!geo.valid) {
  fail(`Geo provider config invalid: ${geo.missing.join(', ')}`);
}

if (failures.length > 0) {
  console.error('Configuration validation failed:');
  failures.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}

console.log('Configuration validation passed');
