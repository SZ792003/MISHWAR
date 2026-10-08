# Incident Response

## Severity

SEV-1:
- rides broadly unavailable
- payment duplication or incorrect money movement
- data exposure
- SOS/safety workflow unavailable during active rides

SEV-2:
- partial ride disruption
- FCM notifications failing
- geo/routing outage affecting a pilot area
- payout/refund workflow blocked

SEV-3:
- degraded non-critical admin workflow
- isolated device issue
- delayed reports or dashboards

## Roles

Incident owner:
- coordinates response
- sets severity
- records timeline
- approves rollback or containment

Engineering:
- diagnoses backend, Firebase, mobile, payment, geo, FCM
- prepares rollback or fix

Operations/Safety:
- monitors active rides and SOS
- handles manual intervention

Finance:
- reviews payment, refund, wallet, payout impact

Support:
- user communication and issue intake

## Response Flow

1. Detect through alert, support report, metric spike, or manual monitoring.
2. Assign incident owner.
3. Declare severity.
4. Contain:
   - disable digital payments
   - disable payouts
   - disable new ride creation
   - switch pilot to cash/manual operations
   - rollback backend or Firebase rules
5. Diagnose logs and metrics.
6. Communicate status to stakeholders.
7. Resolve or rollback.
8. Verify with smoke tests.
9. Write postmortem.

## Logs And Metrics

Monitor:
- backend errors
- `/ready` failures
- ride creation/assignment failures
- payment/refund/payout failures
- FCM send failures
- geo provider failures
- SOS incidents
- safety escalations
- risk signal spikes

Alert thresholds should be configurable after a staging baseline exists. Do not treat placeholder thresholds as final production policy.

## Postmortem

Postmortem should include:
- timeline
- affected users/rides/payments
- root cause
- mitigation
- rollback or fix details
- follow-up owners
- prevention work
