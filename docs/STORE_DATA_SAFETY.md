# MISHWAR Store Data Safety Draft

Draft reference for Google Play Data Safety and Apple App Privacy. Final answers must be reviewed before store submission.

## Customer App

Data categories used by current code:

- Personal info: name and phone number for account and ride identity.
- Location: pickup, destination, and live ride map context.
- App activity: ride creation, ride status, payment/refund actions.
- Financial info: payment method/status and refund records. Do not collect card PIN, bank PIN, CVV, or raw credentials in the app.
- Device identifiers: FCM token for notifications.
- Support/privacy requests: support ticket and account/data request metadata.
- Analytics/crash diagnostics: only sanitized app events and crash diagnostics, without phone, name, precise GPS, KYC, bank info, wallet balance, or incident descriptions.

Purpose:

- App functionality.
- Notifications.
- Fraud/security/audit foundation.
- Payments and financial operations where enabled.
- Customer support.

Data sent to backend/Firebase:

- Yes, through backend APIs and Firestore listeners depending on mode.

## Driver App

Data categories used by current code:

- Personal info: driver account/profile data.
- Location: driver live location during active workflows.
- Documents: KYC document metadata/link when submitted.
- App activity: accept/decline, ride status updates, cash confirmation.
- Financial info: earnings, payout requests, ledger records.
- Device identifiers: FCM token for notifications.
- Support/privacy requests: support ticket and account/data request metadata.
- Analytics/crash diagnostics: only sanitized app events and crash diagnostics.

Purpose:

- Ride dispatch and tracking.
- Driver verification.
- Financial operations.
- Safety and audit.
- Notifications.

## Third-party services

- Firebase Auth.
- Firestore.
- Firebase Messaging.
- Map/routing providers configured in the app.
- Payment provider when activated.

## Not currently supported as completed production claims

- Final legal compliance.
- Live payment provider activation.
- App Store / Google Play privacy declarations.
- Real-device notification and location validation.
- Final account deletion/data access operational SLA.
