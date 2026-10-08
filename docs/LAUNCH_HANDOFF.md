# Pilot Launch Handoff

This handoff marks pilot readiness foundation, not public production launch.

## Code Complete

- Backend health/readiness/version endpoints exist.
- Feature flags and kill switches exist.
- Support, privacy request, analytics, and rating foundations exist.
- QA critical backend gate exists.
- Deployment, rollback, incident, and release documents exist.

## Operationally Ready When

- Operations roles are staffed.
- Pilot area, hours, and capacity are selected.
- Driver list is approved.
- Support channel is real and tested.
- Safety and finance owners are available.
- Day-0 and Day-1 checklists pass.
- Real-device Android customer and driver E2E tests pass.

## External Dependencies

- Firebase credentials and real project.
- Payment provider or approved cash-only pilot policy.
- Map/routing provider or approved limited fallback policy.
- Google Play Console access.
- Apple Developer/Xcode/iPhone validation before iOS release.
- Legal/privacy/transport/payment review.
- Real drivers.
- Support team coverage.

## End-Of-Pilot Decision

Use `PILOT_DAILY_REVIEW.md` data and incident records to decide:
- expand,
- repeat pilot,
- pause.
