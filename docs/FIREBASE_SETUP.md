# MISHWAR Firebase Setup

This document describes the manual Firebase work required before running a real pilot. Do not commit secrets, service account JSON files, `google-services.json`, or `GoogleService-Info.plist` unless the project owner explicitly decides they are acceptable for the repository policy.

## Current Project State

- Backend Firebase Admin SDK dependency exists in `backend/package.json`.
- Backend initializes Firebase Admin from Application Default Credentials or service account environment values in `backend/src/auth.ts`.
- Backend verifies Firebase ID tokens and trusted roles in `backend/src/auth.ts`.
- Firestore persistence repositories exist in `backend/src/persistence.ts`.
- Readiness is exposed at `GET /ready` and probes Firestore with `system/schema` when strict Firebase is required.
- Flutter Firebase SDK dependencies exist in `apps/customer_app`, `apps/driver_app`, and `apps/mishwar_shared`.
- Android package IDs are separate:
  - Customer: `com.mishwar.customer`
  - Driver: `com.mishwar.driver`
- Native Firebase config files are not included in this repository by default.

## Manual Firebase Console Steps

1. Create or select one Firebase project for the pilot environment.
2. Enable Authentication.
3. Enable Phone sign-in.
4. Add Firebase test phone numbers for local testing if needed.
5. Enable Cloud Firestore.
6. Create Firestore in the intended region.
7. Enable Cloud Storage only if KYC/safety attachments will be tested.
8. Do not enable paid external services or payment providers from Firebase setup alone.

## Register Mobile Apps

Register the customer and driver as separate apps in the same Firebase project.

### Customer Android

- Package name: `com.mishwar.customer`
- App nickname: `MISHWAR Customer`
- Download `google-services.json`.
- Place it at:

```text
apps/customer_app/android/app/google-services.json
```

### Driver Android

- Package name: `com.mishwar.driver`
- App nickname: `MISHWAR Driver`
- Download `google-services.json`.
- Place it at:

```text
apps/driver_app/android/app/google-services.json
```

### Customer iOS

- Bundle ID should match the iOS Runner bundle ID configured in Xcode for the customer app.
- Download `GoogleService-Info.plist`.
- Add it to the customer Runner target in Xcode.

### Driver iOS

- Bundle ID should match the iOS Runner bundle ID configured in Xcode for the driver app.
- Download `GoogleService-Info.plist`.
- Add it to the driver Runner target in Xcode.

## Backend Credentials

Use Application Default Credentials whenever possible.

### Local Development / Pilot Machine

1. Create a Firebase Admin service account key only for local backend testing.
2. Store the JSON outside the repository, for example:

```text
C:\secure\mishwar\firebase-service-account.json
```

3. Set:

```text
GOOGLE_APPLICATION_CREDENTIALS=C:\secure\mishwar\firebase-service-account.json
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
APP_MODE=pilot
USE_REAL_AUTH=true
USE_REAL_DATABASE=true
USE_REAL_PAYMENT=false
DIGITAL_PAYMENTS_ENABLED=false
PAYOUTS_ENABLED=false
```

### Cloud Runtime

Attach a least-privilege service account to the runtime and set:

```text
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
APP_MODE=pilot
USE_REAL_AUTH=true
USE_REAL_DATABASE=true
USE_REAL_PAYMENT=false
DIGITAL_PAYMENTS_ENABLED=false
PAYOUTS_ENABLED=false
```

Leave `GOOGLE_APPLICATION_CREDENTIALS` empty in managed cloud runtimes that provide ADC automatically.

## Firestore Rules And Indexes

Review before deployment:

```powershell
Get-Content firebase\firestore.rules
Get-Content firebase\firestore.indexes.json
```

Deploy only after review:

```powershell
firebase deploy --only firestore:rules,firestore:indexes --project your-project-id
```

Storage rules, if Storage is enabled:

```powershell
firebase deploy --only storage --project your-project-id
```

## Backend Verification Commands

Run commands from the repository root unless noted.

```powershell
cd backend
npm install
npm run typecheck
npm run validate:config
npm run scan:secrets
npm run test:api-smoke
```

Start the backend:

```powershell
cd backend
npm run start
```

Check readiness:

```powershell
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:4000/ready
```

Expected pilot readiness:

- `status` is `ready`.
- `checks.firebaseAdmin` is `true`.
- `checks.firestore` is `true`.
- `checks.realAuthEnabled` is `true`.
- `checks.realDatabaseEnabled` is `true`.
- `persistence.requested` is `firestore`.

## Flutter Verification Commands

Customer:

```powershell
cd apps\customer_app
flutter pub get
flutter analyze
flutter test
flutter run --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://your-pilot-api.example.com
```

Driver:

```powershell
cd apps\driver_app
flutter pub get
flutter analyze
flutter test
flutter run --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://your-pilot-api.example.com
```

Strict mobile modes reject unsafe API URLs. `pilot`, `staging`, and `production` require a real HTTPS backend URL.

## Trusted Roles

Do not give mobile apps admin credentials. Admin, finance, KYC, and operations privileges must be Firebase custom claims set by a trusted backend or local admin script.

Set the first admin only after signing in with a real Firebase user:

```powershell
cd backend
npm run set-admin -- FIREBASE_UID
```

Driver approval should flow through the backend KYC/admin endpoints so the server writes trusted custom claims.

## Pilot Separation Rules

- `APP_MODE=demo`: may use demo headers and memory stores.
- `APP_MODE=pilot`: must use Firebase Auth and Firestore.
- `APP_MODE=production`: must use Firebase Auth, Firestore, approved geo providers, and production monitoring.
- Do not use demo users, demo tokens, local memory rides, or mock financial balances for a pilot ride.
- Do not enable real digital payments until provider contracts, credentials, webhook validation, and finance reconciliation are approved.

## Files That Must Remain Local Or Secret

- `.env`
- `.env.production`
- service account JSON files
- Android signing `key.properties`
- keystore files
- payment provider secrets
- webhook secrets

## Minimum Real Pilot Smoke Test

1. Customer signs in with Firebase Phone Auth on a real device.
2. Driver signs in with Firebase Phone Auth on a real device.
3. Driver KYC is approved by a trusted role.
4. Customer creates a cash ride.
5. Driver receives or polls the ride.
6. Driver accepts the ride.
7. Backend keeps the ride in Firestore.
8. Driver location updates appear for the active ride.
9. Driver completes the ride.
10. Driver confirms cash payment.
11. Financial ledger records gross fare, platform commission, and driver earning.
12. `/ready` still returns ready after the flow.
