# Pilot Go / No-Go Checklist

Use before starting a real pilot. A checked item means verified in the target environment, not assumed locally.

## Technical Go Criteria

- Backend healthy.
- `/ready` passes.
- `/version` matches expected release.
- Firebase project configured.
- Customer Android tested on real device.
- Driver Android tested on real device.
- OTP works.
- FCM works.
- GPS works.
- Route/search/reverse geo works in pilot area.
- Customer-to-driver ride E2E works.
- Ride completion works.
- Cash payment confirmation works.
- SOS works.
- Support ticket works.
- Kill switches tested.
- Rollback understood.

## Operational Go Criteria

- Driver onboarding team ready.
- Support contact/channel ready.
- Safety reviewer available during pilot hours.
- Finance reconciliation owner ready.
- Pilot drivers approved.
- Pilot area defined.
- Operating hours defined.
- Capacity limits defined.
- Day-0 checklist complete.
- Day-1 command center staffed.

## Real-Device Gate

No Go unless verified on at least:
- Customer Android real device.
- Driver Android real device.
- Login.
- Ride request.
- Dispatch/accept.
- Live GPS.
- Ride completion.
- Cash payment.
- FCM.
- SOS.

## Android / iOS Policy

Android-only pilot may proceed if operations approves and Android real-device gates pass.

Do not publish iOS until Xcode/iPhone validation is complete. Lack of Mac/iPhone validation must be documented as an iOS blocker.

## No-Go Conditions

- Duplicate payments or incorrect money movement.
- Ride assignment race causing unsafe assignment.
- SOS not working.
- Major data exposure.
- Firebase rules unsafe.
- Location tracking unusable.
- App crashes on startup.
- Backend readiness failing.
- No support/safety owner available.
- Rollback path unknown.

## Decision

- Go: all required gates passed for the selected pilot scope.
- Conditional Go: minor issues accepted by Operations and Technical Lead with documented workaround.
- No-Go: any No-Go condition is active.
