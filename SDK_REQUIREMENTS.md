# MISHWAR — SDKs and tools needed to run the project

Versions below are the ones the project is built and tested with (October 2026).
Newer patch versions of the same major version should work.

## 1. Required SDKs

| Tool | Version | Used for | Install |
|---|---|---|---|
| **Flutter SDK** (includes Dart) | 3.47.x stable (Dart 3.13) | Customer and driver apps (`apps/`) | https://docs.flutter.dev/get-started/install — add `flutter/bin` to `PATH` |
| **Java JDK** | 21 (LTS) | Android Gradle build | Microsoft OpenJDK 21: `winget install Microsoft.OpenJDK.21` — set `JAVA_HOME` |
| **Android SDK** | see section 2 | Building/running the Android apps | Android Studio, or the command-line tools |
| **Node.js** | 22 LTS or newer (production image uses Node 22) | Backend API (`backend/`) | https://nodejs.org |
| **npm** | comes with Node | Backend dependencies | — |

## 2. Android SDK components

Install with Android Studio → *SDK Manager*, or `sdkmanager`:

| Component | Version |
|---|---|
| Android SDK Platform | **36** (`compileSdk` / `targetSdk` = 36) |
| Android SDK Build-Tools | 36.0.0 |
| Android SDK Platform-Tools | latest (provides `adb`) |
| Android SDK Command-line Tools | latest |
| NDK (Side by side) | 28.2.13676358 |
| CMake | 3.22.1 |

Gradle and the Android/Kotlin plugins are downloaded automatically by the Gradle wrapper:
Gradle 9.3.1, Android Gradle Plugin 9.1.0, Kotlin 2.4.0, Google Services plugin 4.4.2. Java/Kotlin target: 17.

After installing, accept the licenses and verify:

```bash
flutter doctor --android-licenses
flutter doctor
```

## 3. Optional tools

| Tool | Version | Needed only for |
|---|---|---|
| **Firebase CLI** | 15.x — `npm install -g firebase-tools` | Deploying Firestore rules/indexes, Firebase Hosting (privacy/terms pages), local emulators |
| **Google Cloud CLI** (`gcloud`) | 588+ — `winget install Google.CloudSDK` | Deploying the backend to Cloud Run |
| **Python** + Pillow | 3.11+, `pip install pillow` | Regenerating icons/splash screens: `python scripts/generate_brand_assets.py` |
| **Docker** | any recent | Building the backend image locally (`backend/Dockerfile`) |
| **cloudflared** | any recent | Exposing a local backend to a phone over HTTPS during development |

## 4. Files that are NOT in Git (get them from the project owner)

These are secrets or machine-specific and are git-ignored on purpose. Never commit them.

| File | Purpose | Where to get it |
|---|---|---|
| `apps/customer_app/android/app/google-services.json` | Firebase config for the customer app | Firebase console → project `mishwar-c4b18` → Android app `com.mishwar.customer` |
| `apps/driver_app/android/app/google-services.json` | Firebase config for the driver app | Same, Android app `com.mishwar.driver` |
| `backend/.env` | Local backend settings | Ask the owner; see `docs/CLOUD_BACKEND_SETUP.md` for the variables |
| Firebase service-account JSON | Backend access to Firestore/Auth when running locally | Ask the owner; keep it **outside** the repo and point `GOOGLE_APPLICATION_CREDENTIALS` at it |
| `apps/*/android/key.properties` + `.jks` upload keys | Signing release builds for Google Play | Owner only — see `apps/*/android/key.properties.example` |

To run debug builds on your own machine, add your debug key's SHA-1 to both Android apps in the Firebase console
(get it with `cd apps/customer_app/android && ./gradlew signingReport`), otherwise phone sign-in fails.

## 5. Running the project

**Backend (local):**

```bash
cd backend
npm install
npm run dev          # http://localhost:4000
```

**Apps against the live pilot backend:**

```bash
cd apps/customer_app        # or apps/driver_app
flutter pub get
flutter run --dart-define=MISHWAR_APP_MODE=pilot \
  --dart-define=MISHWAR_API_BASE_URL=https://mishwar-backend-101482614735.me-central1.run.app
```

**Release APK (needs the signing keys):**

```bash
export MISHWAR_RELEASE_APP_MODE=pilot
export MISHWAR_RELEASE_API_URL=https://mishwar-backend-101482614735.me-central1.run.app
flutter build apk --release --split-per-abi --target-platform=android-arm64 \
  --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=$MISHWAR_RELEASE_API_URL
```

For Google Play use `flutter build appbundle` with the same settings.

## 6. Disk space

Plan for **at least 15 GB free**: Flutter + Android SDK (~5 GB), Gradle cache (~6 GB), and each app build (~2 GB while building).
Delete `apps/*/build/` to reclaim space; it is recreated on the next build.
