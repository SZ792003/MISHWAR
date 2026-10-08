# QA Testing And Release Gates

Stage 10A defines the automated quality gate for MISHWAR. It does not deploy Firebase, backend services, or store builds.

## Current Test Architecture

Backend tests are smoke/integration scripts under `backend/scripts`. They run in demo/test mode with in-memory data or test doubles, so they are idempotent and do not touch production Firestore.

Flutter checks live in each app/package:

- `apps/customer_app/test`
- `apps/driver_app/test`
- `apps/mishwar_shared/test`

The React app under `src` is legacy/admin/demo. Its TypeScript check remains available through root `npm run lint`.

## Commands

Backend:

- `cd backend && npm run typecheck`
- `cd backend && npm run lint`
- `cd backend && npm run validate:config`
- `cd backend && npm run scan:secrets`
- `cd backend && npm run test:api-smoke`
- `cd backend && npm run test:ride-auth`
- `cd backend && npm run test:payments`
- `cd backend && npm run test:fcm`
- `cd backend && npm run test:geo`
- `cd backend && npm run test:safety`
- `cd backend && npm run test:risk`
- `cd backend && npm run qa:critical`

Root:

- `npm run qa:backend`
- `npm run qa:critical`
- `npm run qa:flutter`
- `npm run qa:all`

Windows local runner:

- `powershell -ExecutionPolicy Bypass -File scripts/run_qa.ps1`
- `powershell -ExecutionPolicy Bypass -File scripts/run_qa.ps1 -BackendOnly`
- `powershell -ExecutionPolicy Bypass -File scripts/run_qa.ps1 -SkipFlutter`

## Critical Backend Suite

`qa:critical` blocks release when any of these fail:

- TypeScript compilation
- backend lint/type gate
- configuration validation
- lightweight secret scan
- `/health` and `/ready` API smoke
- ride lifecycle and authorization smoke
- payments and financial operations regression
- FCM hardening regression
- geo regression
- safety regression
- risk regression

## Flutter Checks

Each Flutter app/package should run:

- `flutter pub get`
- `flutter analyze --no-fatal-infos --no-fatal-warnings`
- `flutter test`

Known legacy analyzer info/warning items may still exist in the customer and driver apps. The CI command allows existing info/warnings but still blocks compile/analyzer errors.

## Config Validation

`backend/scripts/validateConfig.ts` checks:

- JSON syntax for key project and Firebase files
- geo provider configuration
- strict environment policy for staging/pilot/production
- no localhost origins in strict modes
- no internal geo fallback in strict modes
- required Firebase/payment settings when enabled

## Security Regression

`backend/scripts/secretScan.ts` performs a lightweight repository scan for high-risk secret files and obvious private key patterns. It avoids printing secret values. It is not a replacement for a full secret scanning service, but it is a useful release gate foundation.

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`.

Jobs:

- Backend critical gate
- Flutter static and widget tests
- Firebase config validation

The workflow does not contain real secrets and does not deploy.

## Pull Request Gates

Pull requests should require:

- Backend critical gate
- Flutter static and widget tests
- Firebase config validation
- reviewer approval

## Main Branch Gates

The main branch should be protected in GitHub settings:

- require pull request review
- require CI success
- prevent force pushes
- restrict direct pushes where possible

This repository change only documents the settings; it does not mutate GitHub branch protection.

## Release Gate

Do not release if any of these fail:

- `npm run qa:critical`
- Flutter analyze has compile errors
- Flutter tests fail
- `/ready` fails in the intended environment
- production config validation fails
- Firebase config/rules files are missing or invalid
- security scan fails

Manual release checks still required before Stage 10B:

- real device customer and driver smoke test
- Firebase project and credentials verified
- payment provider credentials verified
- map/routing provider quota verified
- incident response and rollback owner confirmed

## Coverage Status

Coverage reporting is a foundation item. The current smoke scripts do not yet emit a formal coverage percentage. Priority areas for future coverage are auth, ride lifecycle, payments, financial operations, safety, and risk.

## Limitations

Demo-mode auth tests cover missing token, invalid token, wrong role, role-only endpoints, ride ownership, and admin endpoint denial. Firebase-only scenarios such as revoked sessions and persisted suspended/blocked account checks require emulator or staging Firebase credentials and are not executed in the default local smoke suite.
