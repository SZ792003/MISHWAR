# Remaining Tasks to Reach Production

## 1. Production identity and app polish [COMPLETED]
- Finalized a single brand system for Mishwar across customer and driver apps.
- Standardized theme, cards, status surfaces, and app shell styling across both apps.
- Established a reusable brand package with a consistent Arabic-first visual identity.
- Remaining polish: real app icons, splash screens, launch screens, and store metadata for release packaging.
- Continue reviewing Arabic/English typography and production device rendering before launch.

## 2. Real authentication and identity
- [COMPLETED FOUNDATION] Flutter customer and driver apps now use Firebase ID tokens in non-demo mode.
- [COMPLETED FOUNDATION] Added OTP phone sign-in gate for production-mode Flutter apps.
- [COMPLETED FOUNDATION] Added passenger onboarding confirmation and driver KYC document submission surfaces.
- [COMPLETED FOUNDATION] Backend enforces trusted Firebase claims, role validation, blocked/suspended accounts, token revocation, and profile validation.
- Remaining hardening: account recovery UX, full profile edit screens in Flutter, production Firebase app config, and real-device OTP verification.

## 3. Production backend and persistence
- [COMPLETED FOUNDATION] Ride, wallet, dispatch, driver-location, idempotency, and audit paths support Firestore persistence in Firebase/strict modes.
- [COMPLETED FOUNDATION] Transactional ride assignment and driver operational locking are implemented for Firestore.
- [COMPLETED FOUNDATION] Health, readiness, and metrics endpoints are available.
- [COMPLETED FOUNDATION] Firestore rules and indexes cover rides, driver locations, ride offers, wallet transactions, notifications, and device tokens.
- Remaining hardening: deploy production Firebase config, run migrations/backups against a real project, and validate with real users/devices.

## 4. Real-time operations and notifications
- [COMPLETED FOUNDATION] Live driver location updates flow through backend persistence and Firestore driverLocations listeners.
- [COMPLETED FOUNDATION] Driver app has battery-aware location throttling and stale heartbeat behavior.
- [COMPLETED FOUNDATION] Customer and driver apps listen to active ride documents in production mode.
- [COMPLETED FOUNDATION] Flutter apps register FCM tokens and backend sends best-effort notifications for ride status transitions.
- [COMPLETED FOUNDATION] Flutter API client queues offline ride mutations and syncs them when connectivity returns.
- Remaining hardening: ride-offer push fanout to targeted nearby drivers, SOS push escalation, background retry policy, and real-device FCM validation.

## 5. Payments and financial operations
- [COMPLETED FOUNDATION] Payment core uses backend-trusted ride fare, idempotency, Firestore ledger, wallet/cash flows, and digital provider abstraction.
- [COMPLETED FOUNDATION] React legacy no longer falls back to mock payment success in production paths.
- [COMPLETED FOUNDATION] Reconciliation, reconciliation issues, driver finance balances, payout reservations, settlement reports, refunds, partial refunds, financial adjustments, risk flags, metrics, audit events, rules, and indexes are implemented as Task 5B foundations.
- [COMPLETED FOUNDATION] Flutter customer shows payment/refund actions and Flutter driver shows finance summary, payout request, payout history, and recent ledger movements from backend data.
- Remaining production activation: live digital payment provider API documentation, commercial agreement, production credentials, Firebase production deployment, bank/wallet operator review, and legal/regulatory review before launch.

## 6. Native mobile packaging
- [COMPLETED FOUNDATION] Customer Android project exists with applicationId `com.mishwar.customer`, app label, and required network/location/notification permissions.
- [COMPLETED FOUNDATION] Driver Android project exists with applicationId `com.mishwar.driver`, app label, network/location/notification permissions, and foreground location service permissions.
- [COMPLETED FOUNDATION] Customer and driver iOS folders now include Info.plist, bundle IDs, permission descriptions, Podfile, and workspace/project placeholders for macOS/Xcode follow-up.
- [COMPLETED FOUNDATION] Android release signing architecture reads local ignored `key.properties` files and no longer signs release with debug keys by default.
- [COMPLETED FOUNDATION] Store listing, privacy policy, data safety, terms, release checklist, keystore instructions, support placeholders, and signing documentation are in `docs/`.
- [BLOCKED BY LOCAL TOOLCHAIN] Flutter CLI hangs without output in this Windows session, and Gradle debug builds are blocked because Java/JAVA_HOME is missing from PATH.
- Remaining validation before upload: real keystores outside Git, Firebase native files, Android release builds, final launcher icons/splash/screenshots, macOS/Xcode validation, store packaging, and real-device validation.

## 7. Firebase and cloud configuration
- [COMPLETED FOUNDATION] Added root Firebase CLI config that points to Firestore rules, indexes, Storage rules, and local emulators.
- [COMPLETED FOUNDATION] Backend Firebase Admin SDK can initialize with service-account environment values or Application Default Credentials, with optional Storage bucket configuration.
- [COMPLETED FOUNDATION] Stage 7A hardened Firestore rules so trusted roles come from Firebase custom claims, ride participants are scoped, driver locations are limited to assigned/authorized users, and clients cannot write trusted financial ride fields.
- [COMPLETED FOUNDATION] Storage rules are private by default, enforce owner/admin/KYC reviewer access, content types, file-size limits, and deny unmatched paths.
- [COMPLETED FOUNDATION] Android customer and driver Gradle projects are wired for the Google Services plugin and expect separate real `google-services.json` files.
- [COMPLETED FOUNDATION] Flutter production-like modes fail fast when `MISHWAR_API_BASE_URL` is empty, demo, localhost, loopback, or non-HTTPS.
- [COMPLETED FOUNDATION] Added Firebase production setup documentation, secrets workflow, deployment commands, rollback notes, and rules test foundation.
- [PENDING REAL FIREBASE ACCESS] Production Firebase deployment is pending authenticated Firebase project access, real native Firebase files, and Admin SDK credentials/ADC.
- Remaining activation before Stage 7A production deployment: create the real Firebase project, register four native apps, add native config files locally, configure real credentials/ADC, install/login Firebase CLI, deploy rules/indexes/storage after project confirmation, and run emulator/rules validation.
- Remaining Stage 7B work: real-device Firebase Auth/Firestore/FCM validation, App Distribution upload flow, notification delivery operations, Analytics/Crashlytics dashboard validation, and production push-message monitoring.

## 8. Maps, routing, and geo services
- [COMPLETED FOUNDATION] Stage 8A adds a backend Geo Services layer for coordinate validation, place search, reverse geocoding, routing, route distance, ETA, provider normalization, and safe provider configuration.
- [COMPLETED FOUNDATION] Stage 8A now rejects internal geocoding/routing fallbacks in strict backend modes so production cannot silently use demo geo behavior.
- [COMPLETED FOUNDATION] Flutter map rendering no longer calls public OSRM directly; it displays backend-provided route polylines.
- [COMPLETED FOUNDATION] Customer app supports place search, current location, manual pin selection, reverse geocoding fallback, route preview, distance, and ETA.
- [COMPLETED FOUNDATION] Driver app can show ride route polylines and a throttled driver-to-pickup route preview while approaching.
- [COMPLETED FOUNDATION] Ride creation stores trusted route snapshots and fare calculation uses backend route distance/duration instead of client-supplied distance.
- [COMPLETED FOUNDATION] Stage 8B adds route/reverse-geocode caching, provider backoff, geo metrics, backend driver-location timestamp/accuracy/jump validation, bounded offline location queueing, and map follow safety.
- [COMPLETED FOUNDATION] Added Geo Services documentation, real ride validation plan, and backend geo smoke tests.
- [PARTIALLY COMPLETED UNTIL REAL PROVIDER/DEVICES] Stage 8 production completion still requires a real provider, credentials, quota validation, and two-device real ride validation.

## 9. Safety and risk operations
- [COMPLETED FOUNDATION - STAGE 9A] Added internal ride SOS endpoint, SafetyIncident model, incident lifecycle, dispatcher APIs, location/ride snapshots, safety signals, private evidence metadata, privacy controls, metrics, audit event types, Flutter customer/driver SOS buttons, Firestore/Storage rules, safety docs, real-device test plan, and backend safety smoke test.
- [PARTIALLY COMPLETED UNTIL OPS UI/REAL DEVICES - STAGE 9A] Emergency contacts remain a foundation through existing profile/rules support; no SMS/call automation or external emergency authority integration is claimed.
- [COMPLETED FOUNDATION - STAGE 9B] Added RiskSignal and RiskCase foundations, risk review queues, assignment, append-only notes, resolution, safe enforcement actions, financial/geo/safety/KYC/ride-abuse integrations, configurable thresholds, privacy rules, audit event types, metrics, neutral Flutter restriction messaging, risk docs, and backend risk smoke test.
- [PARTIALLY COMPLETED UNTIL OPS UI/REAL POLICIES - STAGE 9B] Risk workflows remain manual-review-first; no automatic permanent ban policy, legal fraud determination, full appeal ticketing system, or production risk dashboard is claimed.
- Finalize SOS dispatcher UI, real safety device notification routing, emergency contact UX, and real-device validation.
- Expand ride safety checks, trip incident reporting UX, and attachment upload UI.
- Build full admin risk dashboard, reviewer SLAs, appeal/support workflow, and production policy approvals for enforcement thresholds.

## 10. QA, release, and deployment readiness
- [COMPLETED FOUNDATION - STAGE 10A] Added unified QA commands, backend critical gate, ride/auth/API smoke tests, config validation, lightweight secret scan, Flutter shared tests, GitHub Actions CI, local PowerShell QA runner, and QA/release gate documentation.
- [PARTIALLY COMPLETED UNTIL STAGE 10B/REAL ENVIRONMENTS] CI does not deploy, does not mutate branch protection, and does not validate Firebase-only revoked-session/suspended-account scenarios without emulator or staging credentials.
- [COMPLETED FOUNDATION - STAGE 10B] Added staging/deployment environment model, production backend build/start path, graceful shutdown, version endpoint, release manifest generation, deployment smoke test, Dockerfile, guarded Firebase deploy script, rollback procedure, incident response, production release checklist, pilot rollout plan, feature-flag kill switches, and deployment runbook.
- [PARTIALLY COMPLETED UNTIL REAL STAGING/DEVICES] Stage 10 is architecturally ready for staging/pilot, but production validation still requires real Firebase projects, real devices, payment/geo provider credentials, store accounts, monitoring setup, and a live staging deployment.
- Expand automated test coverage reporting for auth, rides, payments, safety, and risk.
- Add staging environment and production smoke tests before each release.
- Create deployment runbook, rollback procedure, and incident response checklist.
- Run final beta and pilot release checks with real devices and real users.

## 11. Market launch checklist
- [COMPLETED FOUNDATION - STAGE 11A] Added legal/privacy readiness updates, help center, launch analytics/KPI documentation, legal review checklist, support ticket APIs, SUPPORT_REVIEWER role, account deletion/data access request foundation, public legal/support config, sanitized analytics event endpoint, completed-ride rating foundation, and lightweight customer/driver support/privacy/about UI entries.
- [PARTIALLY BLOCKED FOR PUBLIC LAUNCH] Stage 11A still requires human legal review, final support channels, final app store privacy answers, real production/staging provider configuration, and operations ownership before public launch.
- [COMPLETED FOUNDATION - STAGE 11B] Added operations handbook, role/least-privilege matrix, driver onboarding SOP, dispatch/support/safety/risk/finance SOPs, pilot command center, Go/No-Go checklist, Day-0/Day-1 procedures, daily review template, team training checklist, support scripts, driver/customer education content, launch handoff, capacity config placeholders, drill requirements, and pilot ownership/RACI.
- [MARKET/PILOT LAUNCH READINESS FOUNDATION COMPLETED] The project is architecturally and operationally prepared for a controlled pilot, but it is not a public production launch until external blockers are cleared and real-device/staging gates pass.
- Final legal review for privacy, licensing, and local operating compliance.
- Prepare support, help center, and user onboarding content.
- Confirm allowed payment and operating model for Yemen market launch.
- Prepare launch analytics and conversion tracking.
- Train operations team for dispatch support, escalation, and driver onboarding.

## 12. Sprint priority order
1. Real auth and backend persistence
2. Production Firebase and security rules
3. Real payment and wallet flows
4. Native mobile build and store release setup
5. Push notifications and live dispatch
6. Beta QA and pilot rollout
7. Launch marketing and support readiness

## Current status summary
- UI identity upgrade is completed for the app shell and the brand system is now shared across customer and driver apps.
- Core ride flow, map handling, and driver tracking foundations exist.
- Stage 5 is architecturally completed as a backend-first financial foundation, but live payment provider activation and legal/regulatory approval remain required before real-money production launch.
