# Deployment Runbook

This runbook prepares MISHWAR for staging and pilot deployment. It does not claim production launch readiness until real Firebase, real devices, payment provider, store accounts, monitoring, and operations owners are verified.

## Environments

Development:
- API URL: local backend, normally `http://localhost:4000`
- Firebase: demo/local/test project only
- Payments: cash/mock/test mode
- Geo: internal or local-safe providers
- Logging: developer logs
- Feature flags: permissive for local testing

Staging:
- API URL: staging backend URL
- Firebase: dedicated staging Firebase project
- Payments: sandbox provider or cash-only pilot mode
- Geo: provider configuration matching production architecture
- Logging: structured logs retained for QA
- Feature flags: production-like defaults with kill switches available

Production:
- API URL: production backend URL
- Firebase: production Firebase project
- Payments: approved real provider only
- Geo: production provider and quota validated
- Logging: production retention and incident access
- Feature flags: conservative defaults, backend-enforced kill switches

## Backend Prepare

1. Confirm Stage 10A quality gate passes:
   - `npm run qa:critical` from `backend`
   - Flutter analyze/test for official apps
2. Set environment variables outside Git.
3. Generate a release manifest:
   - `cd backend`
   - `npm run release:manifest`
4. Build backend:
   - `npm run build`
5. Run production artifact locally on a non-conflicting port:
   - `PORT=4100 APP_MODE=demo npm run start:prod`
6. Verify:
   - `/health`
   - `/ready`
   - `/version`

## Backend Deploy

The backend is deployment-neutral. It can run on a container platform or managed Node runtime if the platform supplies:

- Node 22
- `PORT`
- environment variables
- network egress to Firebase/payment/geo providers
- health checks against `/health`
- readiness checks against `/ready`

Do not bake secrets into images or source. Use platform secret management.

## Firebase Deploy

Firebase deploys must be explicit:

Dry-run example:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/firebase_deploy.ps1 -Environment staging -ProjectId "<staging-project>" -DryRun
```

Staging deploy example:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/firebase_deploy.ps1 -Environment staging -ProjectId "<staging-project>"
```

Production requires an explicit confirmation string:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/firebase_deploy.ps1 -Environment production -ProjectId "<production-project>" -ConfirmProduction DEPLOY_PRODUCTION
```

## Migration Procedure

1. Confirm backup/export strategy exists.
2. Run `npm run qa:critical`.
3. Confirm `/ready` on target environment.
4. Run migration dry-run if the migration supports it.
5. Run migration during a low-risk window.
6. Validate data counts, critical reads, auth, rides, payments, safety, and risk.
7. If validation fails, stop writes where possible and follow rollback/compensating action plan.

## Smoke Test

For deployed staging:

```powershell
$env:SMOKE_BASE_URL="https://staging-api.example"
cd backend
npm run test:deploy-smoke
```

Production smoke must be read-only or low impact. Do not trigger money movement, SOS, or dispatch in production smoke tests.

## Rollback

Rollback requires a known-good backend artifact/container tag, Git-tracked Firebase rules/indexes, and a database migration rollback or compensating action. See `docs/ROLLBACK_PROCEDURE.md`.
