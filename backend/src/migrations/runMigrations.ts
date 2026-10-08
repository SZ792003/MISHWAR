import { backendConfig, isStrictBackend } from '../config';
import { getFirebaseAdmin } from '../auth';
import { migration001InitializePersistenceMetadata } from './001_initialize_persistence_metadata';
import { Migration } from './types';

const migrations: Migration[] = [
  migration001InitializePersistenceMetadata
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const requireProductionConfirmation = () => {
  if (!isStrictBackend()) return;
  const expected = `RUN_MISHWAR_MIGRATIONS_${backendConfig.firebaseProjectId || 'PROJECT'}`;
  if (process.env.CONFIRM_PRODUCTION_MIGRATION !== expected) {
    throw new Error(`Production migration blocked. Set CONFIRM_PRODUCTION_MIGRATION=${expected} only after taking a verified backup.`);
  }
};

const asDb = (db: unknown) => db as {
  doc: (path: string) => {
    get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
    set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<unknown>;
  };
  collection: (path: string) => {
    limit: (count: number) => { get: () => Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }> };
  };
};

const main = async () => {
  requireProductionConfirmation();

  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('Firebase Admin is required for migrations.');

  const db = asDb(firebaseAdmin.admin.firestore(firebaseAdmin.app));
  const log = (message: string) => console.log(`[migrate] ${message}`);

  for (const migration of migrations) {
    const migrationRef = db.doc(`systemMigrations/${migration.id}`);
    const existing = await migrationRef.get();
    if (existing.exists) {
      log(`Skipping ${migration.id}; already recorded.`);
      continue;
    }

    log(`${dryRun ? 'Dry run' : 'Running'} ${migration.id}: ${migration.description}`);
    await migration.run({ db, dryRun, log });

    if (!dryRun) {
      await migrationRef.set({
        id: migration.id,
        description: migration.description,
        executedAt: new Date().toISOString(),
        appMode: backendConfig.mode,
        projectId: backendConfig.firebaseProjectId || null
      });
      log(`Recorded ${migration.id}.`);
    }
  }

  log('Done.');
};

main().catch((error) => {
  console.error(`[migrate] ${error instanceof Error ? error.message : 'Migration failed'}`);
  process.exitCode = 1;
});
