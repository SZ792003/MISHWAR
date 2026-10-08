# MISHWAR Mobile Packaging

Stage 6 prepares the official Flutter apps for native packaging. React is legacy/admin/demo and is not packaged as a customer or driver mobile app.

## Official Flutter Apps

- Customer app: `apps/customer_app`
- Driver app: `apps/driver_app`
- Shared package: `apps/mishwar_shared`

`apps/mishwar_shared` is a package, not a standalone launcher app.

## Android Identity

Customer:

- Project path: `apps/customer_app/android`
- Application ID: `com.mishwar.customer`
- App label: `مشوار`
- Manifest: `apps/customer_app/android/app/src/main/AndroidManifest.xml`

Driver:

- Project path: `apps/driver_app/android`
- Application ID: `com.mishwar.driver`
- App label: `مشوار كابتن`
- Manifest: `apps/driver_app/android/app/src/main/AndroidManifest.xml`

## Android Permissions

Customer:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `POST_NOTIFICATIONS`

Driver:

- Customer permissions
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_LOCATION`

`ACCESS_BACKGROUND_LOCATION` is not enabled. Add it only if true background tracking is implemented and the store disclosure is updated.

## Android Release Signing

Release builds read signing values from `android/key.properties` in each app. The real file must stay outside Git.

Customer template:

- `apps/customer_app/android/key.properties.example`
- recommended alias: `mishwar-customer-upload`

Driver template:

- `apps/driver_app/android/key.properties.example`
- recommended alias: `mishwar-driver-upload`

Expected keys:

```properties
storePassword=...
keyPassword=...
keyAlias=...
storeFile=../release-keystores/app-upload-key.jks
```

Suggested keystore commands, run outside Git-tracked folders or under ignored `release-keystores/`:

```powershell
keytool -genkeypair -v -keystore release-keystores/mishwar-customer-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias mishwar-customer-upload
keytool -genkeypair -v -keystore release-keystores/mishwar-driver-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias mishwar-driver-upload
```

Do not commit `key.properties`, `.jks`, `.keystore`, `.p12`, provisioning profiles, or private keys.

## iOS Identity

Customer:

- Project path: `apps/customer_app/ios`
- Bundle ID: `com.mishwar.customer`
- App name: `مشوار`
- Info.plist: `apps/customer_app/ios/Runner/Info.plist`

Driver:

- Project path: `apps/driver_app/ios`
- Bundle ID: `com.mishwar.driver`
- App name: `مشوار كابتن`
- Info.plist: `apps/driver_app/ios/Runner/Info.plist`

iOS projects are prepared structurally on Windows. Final Xcode project regeneration, CocoaPods installation, capabilities, signing, archive, TestFlight, and App Store validation require macOS + Xcode.

## iOS Signing Preparation

Required later on macOS:

- Apple Developer Team.
- App IDs for `com.mishwar.customer` and `com.mishwar.driver`.
- Signing certificates.
- Provisioning profiles.
- Push Notifications capability.
- Remote Notifications background mode if FCM/APNs is used.
- Location capability/disclosures matching actual behavior.

No Team ID, certificate, or provisioning profile is invented in source.

## Firebase Native Files

Do not commit real Firebase files to source control.

Android:

- Customer: `apps/customer_app/android/app/google-services.json`
- Driver: `apps/driver_app/android/app/google-services.json`

iOS:

- Customer: `apps/customer_app/ios/Runner/GoogleService-Info.plist`
- Driver: `apps/driver_app/ios/Runner/GoogleService-Info.plist`

Use separate Firebase apps if customer and driver apps use separate bundle IDs.

## API Configuration

Flutter apps use Dart defines from `apps/mishwar_shared/lib/mishwar_api.dart`:

- `MISHWAR_API_BASE_URL`
- `MISHWAR_APP_MODE`
- `MISHWAR_FIREBASE_ID_TOKEN` for temporary local testing only
- `MISHWAR_ENABLE_DIGITAL_PAYMENT`

Production builds must pass a real HTTPS API URL and must not use localhost, demo auth, or mock payment paths.

Example:

```powershell
flutter build apk --release --dart-define=MISHWAR_API_BASE_URL=PRODUCTION_API_URL --dart-define=MISHWAR_APP_MODE=production
```

## Build Commands

Customer:

```powershell
cd apps/customer_app
flutter pub get
flutter analyze
flutter build apk --release
flutter build appbundle --release
```

Driver:

```powershell
cd apps/driver_app
flutter pub get
flutter analyze
flutter build apk --release
flutter build appbundle --release
```

iOS on macOS:

```bash
cd apps/customer_app
flutter pub get
cd ios
pod install
open Runner.xcworkspace
```

Repeat for `apps/driver_app`.

## Store Readiness Docs

- Store listing draft: `docs/STORE_LISTING.md`
- Privacy policy draft: `docs/PRIVACY_POLICY.md`
- Data safety draft: `docs/STORE_DATA_SAFETY.md`
- Terms draft: `docs/TERMS_OF_SERVICE.md`
- Release checklist: `docs/MOBILE_RELEASE_CHECKLIST.md`

## Sensitive Files

The repo ignores:

- `google-services.json`
- `GoogleService-Info.plist`
- `*.jks`
- `*.keystore`
- `*.p12`
- `*.mobileprovision`
- `key.properties`
- `release-keystores/`
- `.env*` except `.env.example`
- private keys and service account files

## Current Validation Limits

In this Windows session, Flutter CLI hangs without output even for `flutter --version`. Direct Gradle debug build reaches a local toolchain blocker: `JAVA_HOME is not set and no java command could be found in PATH`.

Stage 6 implementation is configured architecturally, but real-device/store validation remains pending.
