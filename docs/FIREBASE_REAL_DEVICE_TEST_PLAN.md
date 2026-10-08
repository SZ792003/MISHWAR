# Firebase Real Device Test Plan

Stage 7B prepares the scenarios. Execution requires a real Firebase project, native Firebase files, Firebase Authentication phone setup, Android devices, and later macOS/Xcode for iOS.

## Android Two-Device Pilot

- Device A: Customer app installed with `com.mishwar.customer`
- Device B: Driver app installed with `com.mishwar.driver`
- Backend mode: `production` or `pilot`
- Demo auth/payment disabled
- Firebase native config files present in both apps

## Android Scenarios

1. Customer completes OTP login.
2. Driver completes OTP login and approved KYC account state.
3. Driver goes online.
4. Customer requests a ride.
5. Eligible driver receives `new_ride_offer` push only on the driver app.
6. Driver opens the notification and sees the incoming ride.
7. Driver accepts the ride.
8. Customer receives `ride_accepted`.
9. Driver location updates start.
10. Customer sees live driver movement.
11. Driver marks arrived.
12. Customer receives driver-arrived status.
13. Driver starts the ride.
14. Customer receives ride-started status.
15. Driver completes the ride.
16. Customer receives ride-completed status.
17. Customer or driver completes the payment flow.
18. Both apps receive payment-status updates where applicable.
19. Put both apps in background and repeat status transitions.
20. Kill and restart both apps, then validate token refresh and notification tap behavior.
21. Logout and login again, then verify old device token is disabled or replaced.
22. Confirm Analytics events appear in Firebase DebugView only when debug mode is enabled locally.
23. Trigger a controlled debug-only non-fatal error and verify Crashlytics receives it.

## iOS Follow-Up

Run later on macOS/Xcode with a real iPhone:

- Firebase initialization
- OTP login
- APNs capability and Firebase Cloud Messaging delivery
- Foreground/background notification behavior
- Notification tap routing
- Location permission and live tracking
- Crashlytics non-fatal verification
- Analytics DebugView verification

Do not claim iOS push success from Windows-only validation.

## Pass Criteria

- No notification payload contains phone numbers, KYC data, precise coordinates, wallet balances, payment secrets, or tokens.
- Driver offer push targets eligible drivers only.
- Invalid tokens stop receiving repeated sends after FCM rejection.
- Demo auth/payment are disabled in production mode.
- No localhost API URL is used in production builds.
