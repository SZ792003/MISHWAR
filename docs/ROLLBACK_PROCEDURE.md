# Rollback Procedure

Rollback is allowed only to a known-good, tracked version. Avoid manual hot edits that cannot be audited.

## Backend Rollback

1. Identify the last healthy artifact/container version.
2. Confirm it is compatible with current environment variables and database schema.
3. Route traffic back to the previous artifact.
4. Verify:
   - `/health`
   - `/ready`
   - `/version`
   - auth-protected endpoint behavior
   - payment, geo, FCM, safety, and risk smoke checks where safe
5. Keep incident notes with release version, commit, owner, and timestamp.

## Firebase Rules Rollback

Firestore and Storage rules are stored in Git. Roll back by deploying rules/indexes from a known-good commit:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/firebase_deploy.ps1 -Environment staging -ProjectId "<project>" -Rules -Indexes -Storage
```

Production requires:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/firebase_deploy.ps1 -Environment production -ProjectId "<project>" -Rules -Indexes -Storage -ConfirmProduction DEPLOY_PRODUCTION
```

Do not patch Firebase Console rules manually without committing the same change back to Git.

## Bad Config Rollback

1. Revert the environment variable change in the hosting platform.
2. Restart/redeploy the service if the platform does not hot-reload env vars.
3. Confirm `/ready` and `/version`.
4. Record the old and new config names, not secret values.

## Mobile Rollback Reality

Mobile rollback is not instant like backend rollback.

Available actions:
- halt staged rollout
- reduce rollout percentage if store platform allows
- publish a hotfix build
- disable risky functionality through backend-enforced feature flags
- communicate with support and pilot users

Do not rely on client-only flags for safety or money movement decisions.

## Database Migration Caveats

Destructive migrations require backup/export first. If rollback is not possible, define a compensating migration and validation plan before release.

Never run a production migration from a developer machine unless the release owner explicitly approves and backup verification is complete.
