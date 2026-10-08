"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("../config");
const auth_1 = require("../auth");
const _001_initialize_persistence_metadata_1 = require("./001_initialize_persistence_metadata");
const migrations = [
    _001_initialize_persistence_metadata_1.migration001InitializePersistenceMetadata
];
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const requireProductionConfirmation = () => {
    if (!(0, config_1.isStrictBackend)())
        return;
    const expected = `RUN_MISHWAR_MIGRATIONS_${config_1.backendConfig.firebaseProjectId || 'PROJECT'}`;
    if (process.env.CONFIRM_PRODUCTION_MIGRATION !== expected) {
        throw new Error(`Production migration blocked. Set CONFIRM_PRODUCTION_MIGRATION=${expected} only after taking a verified backup.`);
    }
};
const asDb = (db) => db;
const main = async () => {
    requireProductionConfirmation();
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('Firebase Admin is required for migrations.');
    const db = asDb(firebaseAdmin.admin.firestore(firebaseAdmin.app));
    const log = (message) => console.log(`[migrate] ${message}`);
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
                appMode: config_1.backendConfig.mode,
                projectId: config_1.backendConfig.firebaseProjectId || null
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
