import { backendConfig, isStrictBackend } from '../src/config';

const backupCollections = [
  'users',
  'passengers',
  'drivers',
  'driverKyc',
  'rides',
  'driverOperational',
  'driverLocations',
  'wallets',
  'walletTransactions',
  'payments',
  'idempotencyKeys',
  'auditLogs',
  'systemMigrations',
  'system',
  'rideOffers',
  'driver_documents',
  'safetyReports',
  'userBlocks'
];

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || backendConfig.firebaseProjectId;
const projectPlaceholder = projectId || '<firebase-project-id>';
const bucket = process.env.BACKUP_BUCKET || `gs://${projectPlaceholder}-mishwar-backups`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${bucket}/firestore/${backendConfig.mode}/${stamp}`;
const storagePath = `${bucket}/storage/${backendConfig.mode}/${stamp}`;

console.log('MISHWAR backup plan');
console.log(`Mode: ${backendConfig.mode}`);
console.log(`Project: ${projectPlaceholder}`);
console.log(`Firestore backup target: ${backupPath}`);
console.log(`Storage backup target: ${storagePath}`);
console.log(`Collections: ${backupCollections.join(',')}`);

if (isStrictBackend() && process.env.CONFIRM_BACKUP_PLAN !== `BACKUP_${projectId}`) {
  console.log('');
  console.log(`Production guard: set CONFIRM_BACKUP_PLAN=BACKUP_${projectId} before executing the generated commands.`);
}

console.log('');
console.log('Firestore export command:');
console.log(`gcloud firestore export ${backupPath} --project=${projectPlaceholder} --collection-ids=${backupCollections.join(',')}`);
console.log('');
console.log('Firebase Storage copy command:');
console.log(`gcloud storage cp -r gs://${projectPlaceholder}.appspot.com ${storagePath}`);
console.log('');
console.log('Restore commands are intentionally not executed by this script. Follow docs/BACKUP_RESTORE.md and use staging first.');
