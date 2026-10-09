# MISHWAR — TASK 06 Android Stabilization Report

Date: 2026-10-10

Scope: Flutter and Android local readiness for `apps/customer_app` and `apps/driver_app`. No cloud operation, Firebase change, Firestore change, Git commit, or Google Play publishing was performed.

## Summary

| Item | Customer App | Driver App |
| --- | --- | --- |
| Android folder exists | PASS | PASS |
| Independent Application ID | PASS: `com.mishwar.customer` | PASS: `com.mishwar.driver` |
| Flutter analyze | PASS | PASS |
| Flutter test | PASS | PASS |
| Android Debug APK | BLOCKED | BLOCKED |
| Firebase secrets/config changed | NOT CHANGED | NOT CHANGED |

The Flutter/Dart/Android toolchain is installed and usable when the project-local Flutter SDK is invoked directly with analytics/version checks suppressed. Android APK generation is currently blocked because Gradle needs `org.gradle.kotlin.kotlin-dsl:6.4.2` from the Gradle Plugin Portal and network access was denied.

## Toolchain Check

### Flutter SDK

PASS:

```text
Flutter 3.47.6 stable
Dart 3.13.5
DevTools 2.60.0
SDK path: .codex/flutter-sdk
```

Important diagnosis:

- The global `flutter` on PATH points to `C:\development\flutter\bin\flutter`.
- The working SDK for this repository is `.codex\flutter-sdk`.
- Use the repository SDK to avoid hangs and wrong-cache behavior.

Recommended command prefix:

```powershell
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
.\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics <command>
```

### Android SDK

PASS:

```text
Android SDK: C:\Users\MahmoodCenter\AppData\Local\Android\sdk
Android SDK version: 36.0.0
Platform: android-37.0
Build tools: 36.0.0
Android licenses: accepted
```

### JDK

PASS with Android Studio bundled JDK:

```text
Java binary: C:\Program Files\Android\Android Studio\jbr\bin\java
OpenJDK 25.0.3
```

Note:

- `java` is not available globally in PATH.
- Flutter can find Android Studio's JBR.
- Direct Gradle commands need:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
```

## Cause of Previous Flutter Hangs

Confirmed causes:

1. Global Flutter/Dart on PATH points to a different SDK than the project SDK.
2. Normal Flutter commands try network checks against `pub.dev`, `storage.googleapis.com`, `maven.google.com`, `cocoapods.org`, and GitHub.
3. Network is restricted in this environment.
4. Earlier telemetry/log access could also create delays or failures.

Workaround used successfully:

```powershell
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics analyze
```

## Android Project Structure

PASS:

- `apps/customer_app/android` exists.
- `apps/driver_app/android` exists.
- Both apps have:
  - `android/app/build.gradle.kts`
  - `android/settings.gradle.kts`
  - `android/app/src/main/AndroidManifest.xml`
  - Gradle wrapper files
  - Release signing template `key.properties.example`

## Gradle and Application IDs

### Customer

PASS:

```kotlin
namespace = "com.mishwar.customer"
applicationId = "com.mishwar.customer"
```

### Driver

PASS:

```kotlin
namespace = "com.mishwar.driver"
applicationId = "com.mishwar.driver"
```

Both apps apply:

```kotlin
id("com.google.gms.google-services")
```

This is correct for Firebase, but it requires real `google-services.json` before Firebase/Pilot Android builds.

## AndroidManifest Review

### Customer App

PASS:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `POST_NOTIFICATIONS`
- Firebase Messaging notification channel metadata
- MainActivity exported launcher
- Flutter embedding v2

### Driver App

PASS:

- All customer permissions above
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_LOCATION`
- Firebase Messaging notification channel metadata
- MainActivity exported launcher
- Flutter embedding v2

## Firebase Readiness

PASS:

- Firebase Flutter packages exist:
  - `firebase_core`
  - `firebase_auth`
  - `cloud_firestore`
  - `firebase_messaging`
  - `firebase_crashlytics`
  - `firebase_analytics`
- Shared runtime has Firebase initialization, AuthGate, FCM token registration, Crashlytics, Analytics.
- No Firebase or Firestore settings were changed in this task.

MISSING before real Firebase/Pilot:

- `apps/customer_app/android/app/google-services.json`
- `apps/driver_app/android/app/google-services.json`
- iOS `GoogleService-Info.plist` files if iOS is later targeted.
- Optional generated `firebase_options.dart`.

## Backend URL for Android

Do not use `localhost` inside Android builds.

For Android Emulator debug:

```powershell
--dart-define=MISHWAR_API_BASE_URL=http://10.0.2.2:4000
```

For physical Android devices on the same Wi-Fi:

```powershell
--dart-define=MISHWAR_API_BASE_URL=http://<PC_LAN_IP>:4000
```

For Pilot/Production:

```powershell
--dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

Pilot/staging/production modes reject unsafe local/demo API URLs.

## Flutter Analyze Results

### Customer

PASS:

```text
Analyzing customer_app...
No issues found! (ran in 28.5s)
```

### Driver

PASS:

```text
Analyzing driver_app...
No issues found! (ran in 28.0s)
```

## Flutter Test Results

### Customer

PASS:

```text
customer ride booking screen starts
All tests passed!
```

### Driver

PASS:

```text
driver home screen starts
All tests passed!
```

## Debug APK Build Results

### Customer

BLOCKED.

Attempted command:

```powershell
cd apps/customer_app
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics build apk --debug --dart-define=MISHWAR_APP_MODE=demo --dart-define=MISHWAR_API_BASE_URL=http://10.0.2.2:4000
```

Initial failure:

- Gradle wrapper attempted network access and failed with `Permission denied: connect`.
- Network escalation was requested and rejected.

Direct cached Gradle attempt progressed further but failed with:

```text
Plugin [id: 'org.gradle.kotlin.kotlin-dsl', version: '6.4.2'] was not found
Searched in: Gradle Central Plugin Repository
```

Conclusion:

- Android code reached Gradle build.
- APK cannot be created until missing Gradle plugin dependencies are available in cache or network access is allowed.

APK output:

```text
No APK was created.
```

### Driver

BLOCKED.

The driver app uses the same Flutter Gradle build infrastructure and was previously blocked at the Gradle wrapper/network stage. Because the customer build then proved the shared missing dependency is `org.gradle.kotlin.kotlin-dsl:6.4.2`, the driver APK is blocked by the same environment dependency.

APK output:

```text
No APK was created.
```

## Problems Fixed in TASK 06

No source-code logic changes were needed during TASK 06.

Already-stabilized state from the previous Flutter validation remains:

- Customer analyze is clean.
- Driver analyze is clean.
- Flutter tests pass.
- Android folders and Gradle files are present.

## Remaining BLOCKERS

1. Gradle dependency download is blocked by restricted network.
2. Network escalation for Gradle/Flutter build was rejected.
3. `org.gradle.kotlin.kotlin-dsl:6.4.2` is not present in local Gradle cache.
4. Real Firebase Android config files are not present yet.

## Manual Steps to Build APKs

After allowing network once or preloading Gradle caches:

```powershell
cd apps/customer_app
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics build apk --debug --dart-define=MISHWAR_APP_MODE=demo --dart-define=MISHWAR_API_BASE_URL=http://<PC_LAN_IP>:4000
```

```powershell
cd apps/driver_app
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics build apk --debug --dart-define=MISHWAR_APP_MODE=demo --dart-define=MISHWAR_API_BASE_URL=http://<PC_LAN_IP>:4000
```

Expected APK paths after successful build:

```text
apps/customer_app/build/app/outputs/flutter-apk/app-debug.apk
apps/driver_app/build/app/outputs/flutter-apk/app-debug.apk
```

## Manual Steps to Install on Two Android Phones

1. Connect both phones with USB debugging enabled.
2. Confirm devices:

```powershell
adb devices -l
```

3. Install customer app on the customer phone:

```powershell
adb -s <CUSTOMER_DEVICE_ID> install -r apps/customer_app/build/app/outputs/flutter-apk/app-debug.apk
```

4. Install driver app on the driver phone:

```powershell
adb -s <DRIVER_DEVICE_ID> install -r apps/driver_app/build/app/outputs/flutter-apk/app-debug.apk
```

5. For local demo testing, make sure the phones and backend PC are on the same Wi-Fi and the build uses:

```text
http://<PC_LAN_IP>:4000
```

6. For Firebase/Pilot testing, rebuild with HTTPS backend and Firebase config files.

## Final Assessment

- Customer app Android readiness: PASS for structure, IDs, manifests, analyze, and tests. BLOCKED for APK creation by missing Gradle dependency/network.
- Driver app Android readiness: PASS for structure, IDs, manifests, analyze, and tests. BLOCKED for APK creation by the same Gradle dependency/network.
- Ready for Android APK build once Gradle dependency resolution is allowed or preloaded.
- Not ready for Firebase/Pilot Android build until `google-services.json` files are added for both apps.

