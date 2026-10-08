# MISHWAR Mobile Release Checklist

## Code Checks

- Flutter pub get: pending in this Windows session because Flutter CLI hangs without output.
- Flutter analyze customer: pending.
- Flutter analyze driver: pending.
- Flutter analyze shared: pending.
- Backend typecheck: required before release.
- Payment tests: required before release.
- Financial operations tests: required before release.

## Native Identity

- Customer Android applicationId: `com.mishwar.customer`.
- Driver Android applicationId: `com.mishwar.driver`.
- Customer iOS bundleId: `com.mishwar.customer`.
- Driver iOS bundleId: `com.mishwar.driver`.

## Signing

- Customer upload keystore created outside Git.
- Driver upload keystore created outside Git.
- `android/key.properties` created locally for each app.
- Play App Signing reviewed.
- Apple Developer team selected.
- iOS provisioning profiles created.
- Push notification capability configured.

## Firebase

- Customer Android `google-services.json`.
- Driver Android `google-services.json`.
- Customer iOS `GoogleService-Info.plist`.
- Driver iOS `GoogleService-Info.plist`.
- Firebase Auth phone sign-in enabled.
- FCM configured and tested.

## Runtime Config

- Production HTTPS API URL.
- `MISHWAR_APP_MODE=production`.
- No localhost API in release.
- No demo auth in release.
- No mock payment success in release.
- Payment provider credentials configured only through secure environment/secret management.

## Permissions

- Location permission text reviewed.
- Notification permission flow tested.
- Driver foreground location behavior tested.
- Background location not enabled unless store disclosure and architecture require it.

## Store Assets

- Final customer icon.
- Final driver icon.
- Final splash screens.
- Customer screenshots.
- Driver screenshots.
- Release notes.
- Privacy policy URL.
- Terms URL.
- Support URL and email.

## Device Tests

- Customer launch on real Android.
- Driver launch on real Android.
- Customer launch on real iPhone.
- Driver launch on real iPhone.
- OTP login.
- Ride request/accept/start/complete.
- Driver live location.
- Notifications.
- Payment/cash confirmation.
- Refund request.
- Driver finance/payout request.
- Crash smoke testing.
