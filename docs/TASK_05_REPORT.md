# TASK 05 Report - Negotiated Fare & Driver Bidding

## 1. Summary

Implemented the first integrated MISHWAR bidding flow alongside the existing FAST ride flow.

FAST remains the default booking mode. BIDDING now lets the customer create a ride with a proposed fare, lets drivers submit fare bids, lets the customer view bids, and selects exactly one winning bid. The selected bid becomes the backend-trusted final fare and the ride continues through the existing ride lifecycle.

## 2. Reused Existing Systems

- Existing `/api/rides` creation flow, pricing, route calculation, and idempotency.
- Existing dispatch polling `/api/dispatch/incoming`.
- Existing ride lifecycle after assignment: arrived, start, complete, cash confirmation.
- Existing payment and ledger services from TASK 04.
- Existing Firestore Admin SDK and security rules style.
- Existing Flutter customer and driver screens.

## 3. Modified And New Files

- `packages/shared_types/src/index.ts`
- `backend/src/server.ts`
- `backend/package.json`
- `backend/scripts/biddingSmokeTest.ts`
- `apps/mishwar_shared/lib/mishwar_api.dart`
- `apps/customer_app/lib/main.dart`
- `apps/driver_app/lib/main.dart`
- `firebase/firestore.rules`
- `firebase/firestore.indexes.json`
- `docs/TASK_05_REPORT.md`

## 4. Data Model

Added shared types:

- `BookingMode = FAST | BIDDING`
- `BiddingStatus = OPEN | SELECTED | CANCELLED | EXPIRED`
- `RideBidStatus = SUBMITTED | WITHDRAWN | SELECTED | REJECTED | EXPIRED`
- `RideBid`

Added optional ride fields:

- `bookingMode`
- `customerProposedFare`
- `serverEstimatedFare`
- `fareFloor`
- `fareCeiling`
- `finalFare`
- `selectedBidId`
- `biddingStatus`
- `biddingExpiresAt`

Bids are stored as `rideBids/{rideId_driverId}` in persistent mode and in memory only for demo tests.

## 5. REST APIs

Added:

- `GET /api/rides/:id/bids`
- `POST /api/rides/:id/bids`
- `POST /api/rides/:id/bids/:bidId/select`
- `POST /api/rides/:id/bids/:bidId/withdraw`
- `POST /api/rides/:id/bidding/cancel`

Extended:

- `POST /api/rides` now accepts `bookingMode` and `customerProposedFare`.
- `/api/dispatch/incoming` can return open BIDDING rides to drivers without using the FAST accept flow.

## 6. Customer App

Added:

- Booking mode switch: FAST or BIDDING.
- Proposed fare input for BIDDING.
- Bidding ride creation through Backend.
- Bid list refresh.
- Bid display with driver name, ETA, and amount.
- Select bid action.
- Active ride display for proposed fare and server estimate.

## 7. Driver App

Added:

- BIDDING request details showing customer proposed fare and server estimate.
- Bid amount input.
- Submit bid action.
- BIDDING requests no longer show the direct FAST accept button.

FAST ride accept/decline flow remains available for non-bidding rides.

## 8. Dispatch Integration

FAST rides continue using the existing persistent ride offer/lock flow from TASK 03.

BIDDING rides are exposed to drivers from `/api/dispatch/incoming` as open negotiation requests. Drivers submit bids instead of accepting directly. The customer selection assigns the driver and moves the ride to `DRIVER_ARRIVING`.

## 9. Accounting Integration

No new ledger system was created.

When a bid is selected:

- Backend updates `ride.fare.grossFare` to the selected bid amount.
- Backend computes platform commission as 10% of the selected final fare.
- Driver net becomes final fare minus commission.
- Payment and cash commission debt still occur later through the existing TASK 04 payment confirmation flow.
- No commission is created when a bid is submitted or merely selected.

## 10. Test Results

PASS:

- `cd backend && npm.cmd run typecheck`
- `cd backend && npm.cmd run test:bidding`
- `cd backend && npm.cmd run test:dispatch`
- `cd backend && npm.cmd run test:payments`
- `cd backend && npm.cmd run test:ride-auth`
- `cd backend && npm.cmd run scan:secrets`
- `cd backend && npm.cmd run validate:config`
- `git diff --check`

BLOCKED:

- `cd apps/customer_app && flutter analyze` produced no output for about 60 seconds and was stopped.
- `cd apps/driver_app && flutter analyze` produced no output for about 60 seconds and was stopped.
- Flutter tests were not run because the Flutter CLI remains blocked in this environment.

## 11. Tested Bidding Scenarios

Covered by `backend/scripts/biddingSmokeTest.ts`:

- FAST ride creation still works.
- BIDDING ride creation works.
- Driver receives BIDDING request through dispatch polling.
- Three drivers can submit different bids.
- Customer can read submitted bids.
- Concurrent bid selection produces exactly one winner.
- The selected bid becomes `finalFare`.
- 10% commission is calculated from selected final fare.
- Selected bid cannot be withdrawn.

Still deferred to Firebase/emulator:

- Persistent multi-worker concurrent selection.
- Backend restart recovery of `rideBids`.
- Firebase rules enforcement against direct client write attempts.
- Approved/unapproved KYC behavior on real Firebase identities.

## 12. Security And Race Handling

Implemented:

- Customer-proposed fare is never trusted as final fare.
- Driver bid amount must be inside backend fare floor/ceiling.
- Customer must own the ride to list or select bids.
- Driver cannot submit a bid for a closed/non-bidding ride.
- Direct FAST accept endpoint rejects BIDDING rides; assignment must happen by customer bid selection.
- Selected bid cannot be withdrawn.
- Memory demo prevents choosing a second bid after selection.
- Persistent selection uses a Firestore transaction.

Remaining risk:

- Persistent bid rejection of non-winning bids is not fully swept in the Firestore transaction yet; selected bid and ride assignment are atomic, but cleanup/status normalization should be validated with emulator.

## 13. Firebase Requirements

- Review and deploy new `rideBids` Firestore rules manually.
- Review and deploy the new `rideBids` composite index manually.
- Run Firebase Emulator tests for bid submission, selection, withdrawal, and direct client write denial.
- Verify KYC/driver availability checks with real trusted claims and `driverOperational` data.

## 14. Readiness

TASK 05 is ready for backend code review and local/demo testing.

It is not yet certified for production or a real pilot until Flutter analysis succeeds and Firebase Emulator/staging tests validate persistent bidding behavior.

## 15. Impact On TASK 01-04

- TASK 01 Firebase foundation remains unchanged.
- TASK 02 ride lifecycle remains intact.
- TASK 03 FAST dispatch remains intact and tests pass.
- TASK 04 accounting remains intact and payment tests pass.
