# Pilot Command Center

Operational dashboard checklist for pilot monitoring. This can be implemented with existing endpoints, logs, metrics, Firebase console, and manual daily review until a full dashboard exists.

## Monitor Continuously

- Backend `/health`, `/ready`, `/version`.
- Active rides and stuck ride states.
- Ride request failures.
- Driver online count.
- No-driver outcomes.
- Average assignment time.
- Driver location stale events.
- FCM send failures and invalid token cleanup.
- Geo search/route/reverse failures.
- Payment, refund, payout, and ledger failures.
- SOS incidents and safety escalations.
- Risk cases/signals.
- Support tickets by category and priority.
- Crash/diagnostic events.

## Command Center Roles

- Operations owns the room and daily rhythm.
- Technical Lead owns release health and rollback.
- Dispatcher owns active ride coordination.
- Safety Reviewer owns SOS/safety queue.
- Finance Reviewer owns money movement review.
- Support Reviewer owns tickets and user communication.

## Cadence

- Pre-open: run Day-1 checks.
- During hours: monitor active rides and incidents.
- End of day: complete `PILOT_DAILY_REVIEW.md`.
- After any SEV-1/SEV-2: run incident review before reopening or expanding.

## Stop/Pause Signals

Pause or No-Go if there is data exposure, SOS unavailable, duplicate payment/money movement, startup crash, unsafe Firebase rules, unusable location tracking, or unresolved ride assignment race.
