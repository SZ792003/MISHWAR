# MISHWAR Operations Handbook

Operational pilot readiness foundation. This handbook does not claim public production launch.

## Operating Model

The pilot moves MISHWAR from software-ready to operational-pilot-ready in a limited geography, limited hours, and limited capacity. Pilot scope, hours, support coverage, driver list, and enabled payment methods must be configured before Day 1.

## Roles And Responsibilities

| Role | Responsibilities | Required access | Not required |
| --- | --- | --- | --- |
| Technical Lead | release health, rollback, hotfix, Firebase/backend/mobile troubleshooting | deployment, metrics, logs, config, kill switches | financial approvals |
| Operations | pilot coordination, Day-0/Day-1 checklist, daily review | ride operations view, support summaries, command center | raw KYC documents |
| Dispatcher | active rides, no-driver handling, driver unreachable, stale location follow-up | dispatch/ride operations | financial adjustments |
| Safety Reviewer | SOS, safety incidents, safety reports, outcome notes | safety incidents, ride/location context | payout approval |
| Risk Reviewer | risk signals/cases, evidence review, account actions | risk cases, audit events, limited support context | raw payment credentials |
| Finance Reviewer | refunds, payouts, reconciliation, settlements, adjustments | finance APIs, ledger, settlement reports | KYC docs unless policy allows |
| Support Reviewer | tickets, user responses, account review intake | support tickets, user-visible ride/account context | internal risk notes by default |
| Driver Onboarding | driver signup, profile, KYC readiness, training acknowledgement | driver profile/KYC review workflow | finance adjustment |

Use least privilege. Do not grant broad admin access only to make pilot work faster.

## Driver Onboarding SOP

1. Driver signs up with verified phone/auth.
2. Driver completes profile and vehicle information.
3. Driver uploads required KYC metadata/documents.
4. Driver Onboarding reviews completeness.
5. KYC Reviewer reviews identity/vehicle materials according to final local legal and operational policy.
6. Driver account remains active and approved before rides.
7. Driver completes training acknowledgement.
8. Driver logs in on the real driver app.
9. Driver goes online inside the pilot area and hours.
10. First ride is monitored by Operations/Dispatcher.
11. Driver receives support and safety education.

Requirements are subject to final local legal and operational policy.

## Driver Approval Checklist

- Identity reviewed according to approved policy.
- Phone/auth verified.
- Profile complete.
- Vehicle information present and reviewed.
- Required documents present according to approved policy.
- `accountStatus` is active.
- KYC status is approved when required.
- Training acknowledgement recorded.
- First-login test completed.
- Driver knows online/offline, accept, arrive, start, complete, cash confirmation, SOS, and support flows.

## Dispatch SOP

1. Customer requests ride.
2. Backend validates request, fare, route, payment method, and idempotency.
3. Dispatch targets eligible drivers in configured area.
4. Driver receives offer.
5. Driver accepts or declines.
6. If no driver is available, customer receives clear status.
7. Reassignment must be system-supported or audited if manual.
8. Cancellation is recorded with actor and reason.
9. Stale driver location triggers support/dispatch follow-up.
10. Driver unreachable during active ride escalates to Support/Safety depending on context.

Manual dispatch, if used, must leave an audit trail. Do not silently mutate ride state outside documented tools.

## Support SOP

1. Ticket arrives.
2. Categorize: ride, driver, customer, payment, refund, account, account_review, KYC, safety, technical, other.
3. Prioritize:
   - P1: active safety issue.
   - P2: active ride/payment blocking issue.
   - P3: normal account/history issue.
   - P4: feedback or non-urgent request.
4. Assign owner role.
5. Respond using approved guidance.
6. Escalate safety, finance, risk, or technical issues.
7. Resolve with summary.
8. Close after user-facing follow-up.

## Safety SOP

SOS creates an incident. Dispatcher/Safety Reviewer acknowledges, reviews ride/location context, contacts the user through approved channels, escalates internally if needed, resolves, and documents outcome. MISHWAR must not claim automatic police/ambulance notification unless a real integration and policy exist.

Safety response target is configurable and operational. It is not a final legal SLA until approved.

## Risk SOP

Risk signal -> case -> review -> evidence -> action/no action -> audit -> resolution.

Actions must be manual-review-first. Do not use automatic permanent bans during pilot.

## Finance SOP

- Cash rides: driver confirms only after collecting cash.
- Digital payments: disabled until official provider activation.
- Refunds: support/finance review before approval.
- Payouts: no auto payout unless provider/process is approved.
- Reconciliation: daily review of rides, payments, ledger, refunds, payouts, mismatches.
- Settlement: Finance Reviewer generates, reviews, and sends to Operations for approval.
- Manual adjustment: must use ledger/audit path, not direct balance edits.

## Pilot Payment Policy

If digital provider is not enabled, pilot can be cash-only. Digital payments remain disabled until official provider activation, credentials, reconciliation, and legal/finance approval.

If payout provider is not ready, payouts use a controlled manual process only if legally and operationally allowed, while keeping ledger/audit records inside the system.

## Pilot Geography, Hours, And Capacity

Pilot geography, hours, and capacity are configurable operational controls. Do not expand to all Yemen on Day 1.

Suggested config concepts:
- `PILOT_CITY`
- `PILOT_OPERATING_HOURS`
- `MAX_ACTIVE_DRIVERS`
- `MAX_PILOT_CUSTOMERS`
- `MAX_CONCURRENT_RIDES`

Targets and limits are TBD until operations selects them.

## Day-0 Checklist

- Staging/pilot deployed.
- QA critical gate passed.
- Backup/export plan confirmed.
- Config reviewed.
- Driver list approved.
- Support channel ready.
- Command center open.
- Rollback owner and artifact known.
- Kill switches checked in staging.

## Day-1 Checklist

- `/health`, `/ready`, `/version` checked.
- Firebase/Auth/Firestore/FCM checked.
- Geo test checked.
- Test customer and test driver ready.
- Test ride completed.
- Support channel tested.
- Finance owner available.
- Safety owner available.
- No-Go conditions reviewed.

## Bug Triage

- Blocker: stops pilot or risks safety/data/money.
- Critical: active ride/payment/safety path broken for a subset.
- Major: important flow degraded with workaround.
- Minor: cosmetic or low-risk usability issue.

Blocker can pause pilot.

## Pilot Freeze And Hotfix

During pilot, avoid untested large features. Hotfix process:
reported -> reproduce -> fix branch -> CI -> staging smoke -> approval -> deploy -> monitor.

## Drills

Before real pilot:
- Rollback drill in staging.
- Kill switch drill: disable rides, digital payment, payout, then re-enable.
- Incident drill: backend issue, payment issue, SOS issue using non-real user data.

## Launch Ownership

| Area | Owner role | Backup role | Escalation role |
| --- | --- | --- | --- |
| Release health | Technical Lead | Operations | Incident Owner |
| Active rides | Dispatcher | Operations | Technical Lead |
| Safety | Safety Reviewer | Operations | Incident Owner |
| Risk | Risk Reviewer | Operations | Technical Lead |
| Finance | Finance Reviewer | Operations | Incident Owner |
| Support | Support Reviewer | Operations | Incident Owner |
| Driver onboarding | Driver Onboarding | KYC Reviewer | Operations |

## End-Of-Pilot Review

Capture what worked, what failed, top bugs, safety issues, payment issues, geo issues, driver feedback, customer feedback, and decision: expand, repeat pilot, or pause.

Do not expand to a new area until the current pilot review is complete.
