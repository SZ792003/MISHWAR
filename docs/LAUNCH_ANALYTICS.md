# MISHWAR Launch Analytics Draft

Draft pending analytics, privacy, and operations review before public launch.

## Customer Funnel

- `app_open`
- `signup_started`
- `signup_completed`
- `location_permission_result`
- `ride_request_started`
- `route_selected`
- `ride_requested`
- `driver_assigned`
- `ride_started`
- `ride_completed`
- `payment_completed`

## Driver Funnel

- `driver_signup_completed`
- `kyc_submitted`
- `kyc_approved`
- `driver_online`
- `ride_offer_received`
- `ride_offer_accepted`
- `ride_started`
- `ride_completed`
- `payout_requested`

## KPIs

- Signup completion rate.
- Ride request conversion.
- Driver acceptance rate.
- Ride completion rate.
- Cancellation rate.
- Payment success rate.
- Support ticket rate.
- SOS rate.

No final target numbers should be published until a real pilot baseline exists.

## Analytics Privacy Rules

Do not send phone numbers, names, precise GPS, KYC documents, bank information, wallet balance, incident descriptions, private comments, OTPs, tokens, or raw payment credentials to analytics.

The backend `/api/analytics/events` endpoint strips sensitive keys from client parameters. Flutter-side analytics filtering also avoids common sensitive keys before sending Firebase events.

## Feedback And Rating

The initial foundation allows one customer rating per completed ride, with controlled update behavior. Private comments are for internal review and must not be displayed publicly. Aggregate ratings may be used later after product and privacy review.
