# Production Release Checklist

Use this checklist before staging, pilot, or production release. A checked item means verified in the target environment, not assumed from local development.

## QA

- Stage 10A backend critical gate passed.
- Stage 11A/11B pilot readiness documents reviewed.
- Flutter customer analyze/test passed.
- Flutter driver analyze/test passed.
- Deployment smoke test passed.
- No unresolved SEV-1/SEV-2 blockers.

## Firebase

- Correct Firebase project selected.
- Firestore rules reviewed.
- Storage rules reviewed.
- Indexes reviewed.
- Backup/export strategy confirmed.
- Restore test strategy documented.

## Backend

- Build artifact generated.
- `/health` returns 200.
- `/ready` returns 200.
- `/version` returns expected release version and commit.
- Graceful shutdown tested by platform or local signal.
- Environment variables configured through secret management.

## Maps And Geo

- Geo provider configured.
- Routing quota verified.
- Pilot area routes manually checked.
- No production claim if internal fallback is still active.

## Payments

- Payment mode confirmed.
- Sandbox or real provider approved.
- Cash-only pilot selected if digital provider is not ready.
- Refund/payout policy approved by finance.
- Wallet real-money behavior disabled unless compliance is ready.

## FCM

- Customer device receives notification.
- Driver device receives notification.
- Invalid token cleanup verified.
- Payload sanitization verified.

## Safety And Risk

- SOS tested on real devices.
- Safety dispatcher path verified.
- Account block/suspend/unblock verified.
- Risk review permissions verified.
- Support contact available.

## Privacy And Security

- No secrets in Git.
- Firebase service account stored in secret manager.
- Payment/geo provider secrets stored in secret manager.
- Logs do not expose payment secrets, KYC document content, OTPs, or private keys.

## Mobile Builds

- Customer Android build tested.
- Driver Android build tested.
- iOS plan documented if Mac/Xcode is unavailable.
- Store listing and signing keys verified separately.

## Rollback

- Previous backend artifact known.
- Firebase rollback commit known.
- Mobile rollback/hotfix strategy ready.
- Kill switches documented.
- Rollback drill completed in staging before pilot.
- Kill switch drill completed in staging before pilot.

## Monitoring

- Backend errors monitored.
- Readiness monitored.
- Ride failures monitored.
- Payment failures monitored.
- FCM failures monitored.
- Geo failures monitored.
- SOS incidents monitored.
- Risk spikes monitored.
