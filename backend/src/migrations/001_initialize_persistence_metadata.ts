import { Migration } from './types';

export const migration001InitializePersistenceMetadata: Migration = {
  id: '001_initialize_persistence_metadata',
  description: 'Initialize non-destructive persistence metadata for rides, wallets, driver operational state, and audit logs.',
  async run({ db, dryRun, log }) {
    const collections = [
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
      'system'
    ];

    log(`Checking ${collections.length} production collections for migration metadata.`);
    if (dryRun) {
      log('Dry run: no metadata document will be written.');
      return;
    }

    await db.doc('system/schema').set({
      schemaVersion: 1,
      persistencePhase: '3B',
      managedCollections: collections,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  }
};
