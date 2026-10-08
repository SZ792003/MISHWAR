# Pilot Rollout Plan

This plan describes a configurable limited pilot. It does not set final user counts or production commitments.

## Scope

Pilot scope must define:
- city or operating zone
- pilot operating hours
- eligible customer group
- eligible driver group
- support owner
- safety owner
- finance owner
- rollback owner

Use configurable values such as `PILOT_CITY`, `PILOT_OPERATING_HOURS`, `MAX_ACTIVE_DRIVERS`, `MAX_PILOT_CUSTOMERS`, and `MAX_CONCURRENT_RIDES`. Do not expand to nationwide coverage without an end-of-pilot review and a new Go/No-Go decision.

## Entry Gates

Before pilot:
- Operations handbook reviewed
- command center owner assigned
- Go/No-Go checklist passed
- customer Android real-device test passed
- driver Android real-device test passed
- end-to-end ride passed
- GPS foreground/background behavior tested
- FCM foreground/background behavior tested
- driver KYC verified
- SOS tested
- account block/suspend tested
- support contact tested
- cash/payment flow agreed

iPhone testing should be added when Mac/Xcode and iOS store setup are available.

## Payment Policy

If the real digital provider is not fully approved and tested, pilot should use cash or another explicitly approved real-world method.

Do not enable real-money wallet, payouts, or digital payments until compliance, provider credentials, reconciliation, and finance operations are ready.

Digital payments are disabled until official provider activation. Payouts should not run automatically until a provider or controlled manual process is approved and ledger/audit review is operating.

## Geo Policy

If the production geo provider is not ready, do not claim production routing validation. Limit the pilot area and manually validate pickup/dropoff routes.

## End-To-End Scenario

1. Customer signs up.
2. Driver signs up and completes KYC.
3. Driver goes online.
4. Customer chooses pickup and destination.
5. Customer requests ride.
6. Driver receives offer.
7. Driver accepts.
8. Customer sees assigned driver.
9. Driver arrives.
10. Ride starts.
11. Live tracking is monitored.
12. Ride completes.
13. Cash/payment flow is recorded.
14. Driver earning is reviewed.
15. Customer history is checked.
16. SOS is tested separately.
17. Refund is tested separately in a safe environment.
18. Payout is tested only in staging/sandbox or approved pilot finance process.

## Beta Feedback

Use a simple support/contact channel for:
- ride issue
- payment issue
- safety report
- app bug
- driver onboarding issue

Do not build a full CRM in this stage.

## Exit Criteria

Pilot can expand only after:
- no unresolved SEV-1 incidents
- SEV-2 issues have owners and mitigations
- support response flow works
- safety escalation works
- finance reconciliation is reviewed
- real-device GPS and FCM are stable enough for the selected zone
- daily reviews are complete
- end-of-pilot review recommends expand rather than repeat or pause
