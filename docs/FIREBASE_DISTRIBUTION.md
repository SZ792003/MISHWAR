# Firebase App Distribution

This document is a readiness workflow. No build has been uploaded yet because production Firebase credentials and verified mobile build artifacts are still pending.

## Requirements

- Firebase CLI installed and logged in.
- Real Firebase project selected.
- Android Firebase app IDs configured for:
  - `com.mishwar.customer`
  - `com.mishwar.driver`
- Native `google-services.json` files present locally.
- Signed APK/AAB artifacts produced from the release keystores.
- Release notes approved for tester visibility.

## Tester Groups

Use Firebase tester groups such as:

- `internal-testers`
- `drivers-pilot`
- `operations`

Do not commit tester emails to the repository.

## Customer Build

Example command after a real APK exists:

```powershell
firebase appdistribution:distribute apps/customer_app/build/app/outputs/flutter-apk/app-release.apk `
  --app <customer-firebase-android-app-id> `
  --groups internal-testers `
  --release-notes-file docs/release-notes/customer-latest.md
```

## Driver Build

Example command after a real APK exists:

```powershell
firebase appdistribution:distribute apps/driver_app/build/app/outputs/flutter-apk/app-release.apk `
  --app <driver-firebase-android-app-id> `
  --groups internal-testers,drivers-pilot `
  --release-notes-file docs/release-notes/driver-latest.md
```

## Release Notes

Release notes should include:

- App name and role
- Version and build number
- Environment
- Firebase project alias
- Major changes
- Known limitations
- Test focus for this build

## Current Status

Prepared only. Upload is pending real Firebase project IDs, real app IDs, signed builds, Firebase CLI, and tester group setup.
