# Firebase Production Foundation

Stage 7A prepares Mishwar for a real production Firebase project. It does not create a Firebase project, invent project IDs, commit native Firebase files, commit service accounts, or deploy to an unconfirmed project.

## Current Repository State

- Customer Flutter app: `apps/customer_app`
- Driver Flutter app: `apps/driver_app`
- Shared Flutter package: `apps/mishwar_shared`
- Backend: `backend`
- Firebase rules and indexes: `firebase/`
- Legacy/admin/demo React app: `src/`

The React app is not the official customer or driver mobile app.

## Firebase Project Architecture

Use separate runtime environments:

- `development`: local/demo work, emulator use, mock/demo switches allowed only here.
- `production`: real Firebase project, real backend URL, Phone Auth, Firestore, Storage, FCM, and Admin SDK credentials.

No production build may use demo credentials, emulator-only configuration, mock authentication, mock payments, `localhost`, or `127.0.0.1`.

A production project display name such as `Mishwar Production` is acceptable, but the real Firebase project ID must come from Firebase Console. Do not create a placeholder project ID in source.

## Registered Firebase Apps

The production Firebase project must register four separate native apps:

- Android customer: `com.mishwar.customer`
- Android driver: `com.mishwar.driver`
- iOS customer: `com.mishwar.customer`
- iOS driver: `com.mishwar.driver`

Do not reuse one Android Firebase app registration for both Flutter apps.

## Native Firebase Files

Download these files from Firebase Console and place them locally only:

- Customer Android: `apps/customer_app/android/app/google-services.json`
- Driver Android: `apps/driver_app/android/app/google-services.json`
- Customer iOS: `apps/customer_app/ios/Runner/GoogleService-Info.plist`
- Driver iOS: `apps/driver_app/ios/Runner/GoogleService-Info.plist`

These files are ignored by Git. They are not present in this repository and were not generated with fake values.

Android Gradle is wired for the Google Services plugin in both Flutter apps. Builds that need Firebase services must provide the matching `google-services.json` for that app. Final iOS file attachment and capability validation must be completed on macOS with Xcode.

## Flutter Runtime Configuration

Shared mobile runtime config lives in `apps/mishwar_shared/lib/mishwar_api.dart`.

Production-like mobile modes are:

- `staging`
- `pilot`
- `production`

In these modes, `MISHWAR_API_BASE_URL` must be a real HTTPS API URL. The app fails fast if it is empty, contains `localhost`, contains `127.0.0.1`, contains `demo`, or is not HTTPS.

Expected release defines:

```powershell
flutter build apk --release --dart-define=MISHWAR_APP_MODE=production --dart-define=MISHWAR_API_BASE_URL=https://api.example.com
```

Replace the API URL with the real Mishwar backend URL. Do not commit it as a secret if the deployment process supplies it.

## Backend Admin SDK

Backend Firebase Admin initialization is in `backend/src/auth.ts`.

Preferred production credential mode:

- Application Default Credentials in the hosted environment.
- `FIREBASE_PROJECT_ID`
- Optional `FIREBASE_STORAGE_BUCKET`

Local/private fallback for controlled operations:

- `GOOGLE_APPLICATION_CREDENTIALS` pointing to a service account JSON outside Git.
- Or service account env vars `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`.

Production strict modes do not fall back to demo authentication. If Firebase Admin cannot initialize or the request has no valid Firebase ID token, protected backend endpoints fail with authentication errors.

## Firestore Rules

Rules file: `firebase/firestore.rules`

Important production protections:

- Trusted roles are read from Firebase custom claims only.
- Users can read/update only their own editable profile fields unless an admin claim is present.
- Driver profile and vehicle reads are restricted to owner/admin paths.
- Client ride creation cannot write trusted financial fields or assign a driver.
- Client ride updates cannot alter payment status, provider IDs, wallet transaction IDs, driver earnings, platform commission, refunds, or settlements.
- Rides are readable only by the customer/passenger, assigned driver, or admin.
- Ride events and ratings are limited to ride participants/admins.
- Driver locations are readable only by the driver, admin, or the assigned customer/passenger while the ride is in a trackable status.
- KYC records are limited to the driver owner and KYC reviewer/admin claims.
- Wallets, payments, financial transactions, payouts, refunds, settlements, reconciliation, adjustments, risk flags, and audit logs are backend/admin-owned.

Admin SDK writes bypass client rules, so backend authorization remains mandatory.

## Storage Rules

Rules file: `firebase/storage.rules`

Storage is private by default. Allowed paths:

- `users/{userId}/profile/{fileName}` for owner profile images, max 5 MB.
- `avatars/{userId}/{fileName}` for owner avatar images, max 5 MB.
- `vehicles/{driverId}/{fileName}` for driver/vehicle media, owner upload and KYC reviewer/admin read.
- `drivers/{driverId}/{path=**}`, `driver_documents/{driverId}/{fileName}`, and `driver-kyc/{driverId}/{path=**}` for KYC images/PDFs, max 10 MB.
- `ride-incidents/{rideId}/{userId}/{fileName}` for reporting user incident images, max 10 MB.

Unmatched paths are denied. KYC files must not be exposed via public unauthenticated URLs.

## Firestore Indexes

Indexes file: `firebase/firestore.indexes.json`

Current indexes cover actual repository queries for:

- `rides` by customer, driver, status, and created time.
- `driverOperational` by accepting/online state.
- `driverLocations` by status/update time.
- `rideOffers` by driver/status/created time.
- `walletTransactions`, `payments`, `financialTransactions`.
- `driverPayouts`, `refunds`, `settlements`, `reconciliationIssues`.
- `deviceTokens` and `notifications`.

Validate indexes against emulator or a confirmed Firebase project before deployment.

## Firebase CLI Configuration

Root config:

- `firebase.json`

Firebase folder config:

- `firebase/firebase.json`

No `.firebaserc` project ID is committed because the real production project ID is not confirmed.

Select a real project locally after Firebase CLI login:

```powershell
firebase use --add
firebase use <confirmed-production-project-id>
```

Deploy only after confirming the selected project:

```powershell
firebase deploy --only firestore:rules,firestore:indexes,storage
```

Do not run `firebase deploy` against an unknown or guessed project.

## Rules Tests

Rules test plan: `firebase/rules-tests/README.md`

The repository includes the required test cases for unauthenticated access, own-profile access, ride participant access, financial collection protection, audit log protection, KYC restrictions, device tokens, and Storage ownership/content-type rules.

Executable emulator tests still require Firebase CLI and test packages to be installed in the selected environment.

## Environment Variables

Template file: `.env.example`

Relevant variables:

- `APP_MODE`
- `VITE_APP_MODE`
- `MISHWAR_APP_MODE`
- `MISHWAR_API_BASE_URL`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `USE_REAL_AUTH`
- `USE_REAL_DATABASE`
- `USE_REAL_PAYMENT`

Production secrets must be stored in the hosting platform secret store or an equivalent secret manager. Do not commit `.env.production`, service account JSON, private keys, keystores, or native Firebase config files.

## Backup, Restore, And Migration

Before production launch:

- Test Firestore export/backup procedures against the confirmed project.
- Test restore into a non-production project.
- Run migrations only after dry-run review and project confirmation.
- Keep destructive operations out of local scripts unless explicitly approved and targeted at the confirmed environment.

## Rollback Considerations

For Firebase rules/index deployments:

- Keep the previous deployed rules file available before deployment.
- Deploy rules and indexes separately when risk is high.
- If client access breaks, roll back rules first.
- Index rollback may require deleting unused indexes from Firebase Console after confirming no live query depends on them.

## Pending Real Firebase Inputs

Stage 7A is architecturally prepared, but these production activation inputs remain external:

- Real Firebase production project ID.
- Four registered Firebase native apps.
- Real `google-services.json` files for customer and driver Android apps.
- Real `GoogleService-Info.plist` files for customer and driver iOS apps.
- Firebase CLI authentication and project access.
- Production Admin SDK credentials or hosted ADC.
- Phone Auth enabled and tested.
- Custom claims assigned for `CUSTOMER`, `DRIVER`, `ADMIN`, `SUPER_ADMIN`, `KYC_REVIEWER`, and finance/admin roles as needed.
- Emulator/rules tests executed.
- Real-device Android validation and later iOS validation on macOS/Xcode.

Production Firebase deployment is pending authenticated Firebase project access.
