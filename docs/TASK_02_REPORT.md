# TASK 02 Report - Customer & Driver Real Ride Flow Preparation

## Scope

TASK 02 prepared the customer and driver Flutter apps and the backend ride flow for a real pilot ride without connecting real Firebase and without changing Firebase secrets or native Firebase config files.

## Files Reviewed

- `backend/src/server.ts`
- `backend/src/persistence.ts`
- `backend/src/payments/paymentService.ts`
- `backend/src/payments/financialOperationsService.ts`
- `backend/src/profileService.ts`
- `apps/customer_app/lib/main.dart`
- `apps/driver_app/lib/main.dart`
- `apps/mishwar_shared/lib/mishwar_api.dart`
- `firebase/firestore.rules`
- `firebase/firestore.indexes.json`

## Files Modified

- `apps/mishwar_shared/lib/mishwar_api.dart`
- `backend/scripts/rideAuthSmokeTest.ts`
- `docs/TASK_02_REPORT.md`

## Problems Found And Fixed

### 1. Critical ride and finance actions could be queued offline

`MishwarApi` previously allowed the generic offline queue path to cover critical POST operations. This could cause stale actions such as accept, cancel, complete, cash confirmation, payout, refund, or rating to replay later after network recovery.

Fix:

- Added `_postCritical`.
- Critical ride, finance, KYC, support, privacy, rating, and analytics mutations now use `queueWhenOffline: false`.
- Existing queued critical operations from older app versions are skipped during `syncOfflineQueue`.
- Offline replay is now limited to driver location updates and device token registration.

### 2. Ride state regression needed explicit test coverage

The backend already rejected invalid transitions, but the smoke test did not assert that a completed ride cannot move backward.

Fix:

- Added a smoke test assertion that `/api/rides/:id/arrived` returns `409` after `TRIP_COMPLETED`.

## Flow Status

### Customer App

Covered and prepared:

- App launch.
- Auth gate through Firebase runtime in non-demo modes.
- Pickup selection by text/search/map/current location.
- Destination selection.
- Vehicle selection including car and motorcycle.
- Route preview and server route calculation.
- Ride request through backend.
- Active ride polling through backend.
- Firestore listener support after Firebase is connected.
- Driver location display.
- Completed ride payment state.
- Cash payment waits for driver confirmation.
- Wallet/digital payment path remains backend-driven.
- Offline/GPS errors show user-facing messages.

### Driver App

Covered and prepared:

- Online/offline UI state.
- Incoming ride polling through backend.
- Accept/decline through backend.
- Arrived/start/complete through backend.
- Driver GPS permission handling.
- Driver location publishing through backend.
- Cash confirmation through backend.
- Finance summary display.
- Payout request remains backend-driven.
- Offline/GPS errors show user-facing messages.

## Backend Enforcement

Already present and verified by inspection/tests:

- Driver endpoints use `requireApiAuth('DRIVER')`.
- In Firebase-backed pilot mode, driver operations require approved KYC through `requireApprovedDriverAccount`.
- Persistent ride assignment uses Firestore transactions in `FirestoreDispatchRepository.acceptRide`.
- Memory/demo assignment keeps process-local race protection for smoke tests only.
- Ride transitions reject invalid state jumps.
- Cash payment confirmation requires the assigned driver and completed ride.
- Duplicate payment and duplicate cash confirmation are guarded by payment service idempotency and existing-payment checks.

## Firebase Later

The Firebase engineer still needs to:

- Add real `google-services.json` for customer and driver Android apps.
- Add real `GoogleService-Info.plist` for iOS targets if iOS is tested.
- Configure backend Firebase Admin credentials outside Git.
- Deploy reviewed Firestore rules and indexes.
- Verify real Firebase Auth custom claims.
- Approve a real driver KYC record.
- Test Firestore listeners for ride and driver location on two real devices.

## Android Run Commands

Customer:

```powershell
cd apps\customer_app
flutter pub get
flutter run --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://your-pilot-api.example.com
```

Driver:

```powershell
cd apps\driver_app
flutter pub get
flutter run --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://your-pilot-api.example.com
```

Strict mobile modes require an HTTPS API URL. Localhost is allowed only in demo/local development.

## Test Results

Passed:

- `cd backend && npm.cmd run typecheck`
- `cd backend && npm.cmd run test:ride-auth`
- `cd backend && npm.cmd run test:payments`
- `cd backend && npm.cmd run scan:secrets`

Flutter blocked in this local environment:

- `flutter analyze` in `apps/mishwar_shared` produced no output for more than 60 seconds and was stopped.
- `flutter test` in `apps/mishwar_shared` produced no output for more than 60 seconds and was stopped.

This is recorded as an environment/tooling blocker, not a successful Flutter verification.

## PASS / FAIL

- Customer end-to-end flow review: PASS
- Driver end-to-end flow review: PASS
- Backend-only pilot routing for ride operations: PASS
- Demo data blocked in pilot by strict mobile/backend config: PASS
- Unapproved Firebase driver blocked from driver operations: PASS by existing backend enforcement
- Offline critical operation replay prevented: PASS
- Duplicate financial operation guard: PASS by existing payment tests
- Firebase real connection: NOT DONE by task instruction
- Flutter CLI verification: BLOCKED by local Flutter hang

## Remaining Before Real Two-Device Ride

- Complete Firebase setup from `docs/FIREBASE_SETUP.md`.
- Run Flutter analyze/test after fixing the local Flutter CLI hang.
- Install both apps on real Android devices.
- Sign in customer and driver with Firebase Phone Auth.
- Approve driver KYC/custom claim.
- Run one cash ride from request to cash confirmation.
- Verify `/ready`, Firestore ride document, driver location document, payment record, and financial ledger after completion.
