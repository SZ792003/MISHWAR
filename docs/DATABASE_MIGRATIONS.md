# MISHWAR Database Migrations

Migrations are versioned TypeScript modules under `backend/src/migrations`.
The runner records completed migrations in Firestore collection `systemMigrations`.

## Commands

From `backend/`:

```bash
npm run migrate -- --dry-run
npm run migrate
```

`--dry-run` reads current migration state and prints planned work without writing
application data or `systemMigrations` records.

## Production Guard

When the backend is running in strict production mode, the runner refuses to
execute until this variable is set:

```bash
CONFIRM_PRODUCTION_MIGRATION=RUN_MISHWAR_MIGRATIONS_<firebase-project-id>
```

Take and verify a backup before setting the confirmation variable.

## Migration Rules

- Every migration must have a stable, unique ID such as `001_initialize_persistence_metadata`.
- Migrations must be idempotent and safe to retry.
- Do not delete production data in a migration unless a separate restore plan exists.
- Prefer additive schema changes, metadata backfills, and compatibility windows.
- Record any required Firestore indexes in `firebase/firestore.indexes.json`.
- Keep secrets out of migration logs and documents.

## Current Migrations

`001_initialize_persistence_metadata`

Creates or updates `system/schema` with the managed persistence collections and
schema version used by phase 3B. The completion marker is written to
`systemMigrations/001_initialize_persistence_metadata` after a successful real run.

## Adding A Migration

1. Create `backend/src/migrations/<number>_<name>.ts`.
2. Export a `Migration` object with `id`, `description`, and `run`.
3. Add it to the `migrations` array in `backend/src/migrations/runMigrations.ts`.
4. Run `npm run migrate -- --dry-run`.
5. Run the real migration only after backup verification.

