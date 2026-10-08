# MISHWAR Backup And Restore

This document covers Firestore, Firebase Storage, and operational verification
for production persistence.

## Backup Scope

Firestore collections currently included by `npm run backup:plan`:

- `users`
- `passengers`
- `drivers`
- `driverKyc`
- `rides`
- `driverOperational`
- `driverLocations`
- `wallets`
- `walletTransactions`
- `payments`
- `idempotencyKeys`
- `auditLogs`
- `systemMigrations`
- `system`
- `rideOffers`
- `driver_documents`
- `safetyReports`
- `userBlocks`

Firebase Storage must also be backed up, especially profile photos and KYC
documents. Do not store backup credentials in the repository.

## Backup Planning

From `backend/`:

```bash
npm run backup:plan
```

The script prints the Firestore export and Storage copy commands. It does not
execute destructive or cloud-mutating work.

For strict production mode, confirm intentionally before executing the printed
cloud commands:

```bash
CONFIRM_BACKUP_PLAN=BACKUP_<firebase-project-id>
```

## Recommended Frequency

- Firestore: daily scheduled export, plus manual export before migrations.
- Firebase Storage: daily object copy or bucket replication.
- Audit logs and wallet/payment collections: retain according to finance and
  compliance policy; do not prune without legal approval.

## Restore Flow

1. Restore into a staging Firebase project first.
2. Verify collection counts for rides, wallets, payments, audit logs, users, and
   driver KYC records.
3. Verify sample ride lifecycle records and wallet transaction chains.
4. Verify KYC documents and profile photo objects are readable from Storage.
5. Run backend smoke checks against staging.
6. Schedule production restore only after stakeholder approval and downtime plan.

## Restore Safety

- Never import an unverified backup directly over production.
- Prefer a new Firebase project for full disaster recovery tests.
- Keep the source export path immutable.
- Save restore command output and operator identity in the incident record.
- Rotate any credentials suspected to be exposed during incident response.

## Verification Checklist

- Firestore export completed without failed collections.
- Storage copy completed without skipped protected objects.
- Backup path contains a timestamp and environment name.
- `auditLogs` and `systemMigrations` are present.
- A staging restore can read representative documents and Storage objects.

