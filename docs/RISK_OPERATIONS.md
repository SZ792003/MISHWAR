# Risk Operations

Stage 9B adds an internal risk review foundation. A risk signal is not a fraud verdict. It is an operational clue that may require manual review.

## Signals

`RiskSignal` records account, ride, payment, geo, safety, and KYC risk indicators with references instead of copying sensitive source data.

Supported signal types include:

- `duplicate_account_behavior`
- `repeated_ride_cancellations`
- `repeated_no_show`
- `rapid_account_switching`
- `suspicious_location_pattern`
- `repeated_failed_payment`
- `duplicate_refund_attempt`
- `rapid_payout_requests`
- `wallet_balance_mismatch`
- `provider_mismatch`
- `repeated_safety_reports`
- `kyc_inconsistency`
- `manual_review`

Severity can be `low`, `medium`, `high`, or `critical`. High severity does not automatically mean permanent block.

## Cases

`RiskCase` groups one or more signals for the same subject. Cases carry:

- subject user and role
- status: `open`, `under_review`, `action_required`, `resolved`, `dismissed`
- priority
- signal, incident, payment, ride, KYC, and financial flag references
- reviewer assignment
- append-only notes
- recorded enforcement actions

## Admin APIs

Risk APIs are internal only:

- `GET /api/admin/risk/signals`
- `POST /api/admin/risk/signals`
- `GET /api/admin/risk/cases`
- `GET /api/admin/risk/cases/:id`
- `POST /api/admin/risk/cases/:id/assign`
- `POST /api/admin/risk/cases/:id/note`
- `POST /api/admin/risk/cases/:id/resolve`
- `POST /api/admin/risk/cases/:id/enforcement`

## Permissions

Risk review is limited to existing trusted operational roles:

- `ADMIN`
- `SUPER_ADMIN`
- `OPS_MANAGER`
- `SUPPORT`
- `FINANCE`
- `KYC_REVIEWER`

Account enforcement is further limited to admin/operations roles. Customer and driver apps must not read risk cases, risk signals, reviewer notes, internal severity, or investigation status.

## Integrations

Financial operations can create risk signals for duplicate refund attempts, rapid payout pressure, wallet mismatch, and provider mismatch references. The risk layer stores references such as `paymentId` and `financialRiskFlagId`.

Geo hardening can create `suspicious_location_pattern` for impossible jumps or spoof-like patterns. The wording intentionally avoids declaring confirmed GPS fraud.

Safety incidents can create review signals for the reported subject. Reporters are not penalized simply because they submit repeated safety reports.

KYC review can create `kyc_inconsistency` signals for rejected or inconsistent submissions. Document contents are not copied into risk cases.

Ride abuse detection currently covers repeated cancellations with configurable thresholds.

## Thresholds

Defaults are development-safe and configurable:

- `RISK_CANCELLATION_WINDOW_HOURS`
- `RISK_MAX_CANCELLATIONS`
- `RISK_MAX_FAILED_PAYMENTS`
- `RISK_MAX_PAYOUT_REQUESTS`

These are operational thresholds, not legal definitions.

## Manual Review

Critical and sensitive cases set `manualReviewRequired = true`. The platform should prefer warning, review, temporary suspension, or financial restriction before full block unless a clear safe rule and reviewer decision justify escalation.

## Enforcement

Risk enforcement reuses the existing account security implementation:

- `temporary_suspension` calls the existing suspend workflow.
- `full_block` calls the existing block workflow.
- `unblock` calls the existing unblock workflow.
- warning, review, and financial restriction are recorded as case actions for manual follow-up.

In Firebase-backed mode, suspend and block revoke sessions through the existing session revocation flow. Demo mode records the action when Firebase Admin is unavailable.

## Audit and Metrics

Risk operations emit audit events:

- `RISK_SIGNAL_CREATED`
- `RISK_CASE_CREATED`
- `RISK_CASE_ASSIGNED`
- `RISK_CASE_NOTE_ADDED`
- `RISK_CASE_RESOLVED`
- `RISK_ACTION_SUSPENDED`
- `RISK_ACTION_BLOCKED`
- `RISK_ACTION_UNBLOCKED`

Metrics include:

- `risk_signals_total`
- `risk_cases_open`
- `risk_cases_resolved_total`
- `risk_actions_total`

No user IDs are used as metric labels.

## Privacy

Risk data is internal and sensitive. Store references to source records, not copied evidence bodies, raw KYC documents, payment secrets, or full location histories. User-facing account restriction messages must stay neutral, for example: "تم تقييد الحساب مؤقتاً، يرجى التواصل مع الدعم."

## Limitations

This is an operational foundation, not full production readiness. Remaining work includes a full admin risk queue UI, verified reviewer workflows, production Firestore-backed audit validation, appeal/support workflows, and legal/ops policy approval for enforcement thresholds.
