# MISHWAR Privacy Policy Draft

Draft pending professional/legal review before public launch. This is not a final legal opinion or regulatory approval.

## Data We Collect

- Account data: name, phone number, role, profile details, account status.
- Location data: pickup, destination, and live trip location where enabled.
- Driver live location: sent during active driver workflows to support dispatch and customer tracking.
- KYC data: driver identity/vehicle document metadata and links when submitted.
- Device data: FCM device tokens and platform information for notifications.
- Ride history: ride status, timestamps, fare data, vehicle type, customer and driver IDs.
- Payment records: method, status, ledger records, refunds, payouts, settlements, and audit references.
- Security/audit data: request IDs, actor IDs, role, action type, timestamps, and sanitized metadata.
- Support/privacy request data: support ticket category, subject, message, status, and account deletion or data access request status.
- Analytics and crash reports: app events and diagnostics after sensitive fields are removed.

## Why We Use Data

- Create and manage accounts.
- Request, assign, track, cancel, and complete rides.
- Send ride, safety, account, and payment notifications.
- Process enabled payment, refund, wallet, payout, and settlement operations.
- Review driver onboarding and KYC.
- Protect the service from misuse and support auditability.
- Provide customer support and incident review.

## Location Disclosure

Customer location is used to set pickup and destination points and show trip context.

Driver location is used to assign rides, update the customer during a trip, and support operational safety. The current implementation does not add Android background location permission. If background location is enabled later, the store disclosure and permissions must be updated before release.

## Third Parties

MISHWAR uses Firebase services for authentication, Firestore persistence, and messaging foundations. Payment providers may be used when live digital payments are activated. Provider activation requires official API documentation, commercial agreement, credentials, and legal review.

Provider categories that must be finalized before launch: Firebase, map/routing provider, payment provider, crash reporting, and analytics. If a final provider is not selected, store and privacy documentation must keep a category placeholder rather than naming a company.

## KYC Privacy

Driver identity and vehicle documents are collected for operational and safety verification. They are not public and should be accessible only to authorized KYC, support, safety, or operations reviewers. No fixed retention period is promised until the retention policy is approved.

## Financial Data

The system stores ride payment, wallet ledger, refund, payout, commission, settlement, and reconciliation records. It must not store CVV, bank PIN, bank OTP, or raw card credentials.

## Account Deletion And Data Access

Users can submit account deletion, data access, or correction requests. These requests enter manual review rather than immediate hard delete because finance, fraud, safety, audit, and legal records may require retention.

## Retention

Retention periods must be finalized before launch. Financial, audit, ride, and safety records may need longer retention for operational, security, accounting, or legal reasons.

## User Rights

Users should be able to request access, correction, support review, or account status review through SUPPORT_URL or CONTACT_EMAIL once production support channels are finalized.

## Security

Secrets, Firebase service accounts, keystores, payment credentials, CVV, PINs, OTPs, and raw provider credentials must not be stored in Firestore or source code. Production systems must use secure environment variables or a secret manager.

## Contact

- Support: SUPPORT_URL
- Email: CONTACT_EMAIL
- Privacy Policy URL: PRIVACY_POLICY_URL
