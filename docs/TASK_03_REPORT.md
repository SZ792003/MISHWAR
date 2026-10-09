# TASK 03 Report - Persistent Dispatch Implementation

## Scope

TASK 03 strengthened dispatch so production/pilot Firestore mode no longer depends on backend process memory for active ride offers. Demo mode still uses the existing in-memory offer map for local smoke testing only.

## Files Modified

- `backend/src/persistence.ts`
- `backend/src/server.ts`
- `backend/src/config.ts`
- `backend/package.json`
- `backend/scripts/dispatchSmokeTest.ts`
- `firebase/firestore.rules`
- `.env.example`
- `docs/TASK_03_REPORT.md`

## Problems Found

1. Firestore dispatch still used the process-local `rideOffers` map in `server.ts`.
2. A backend restart or a second backend instance could lose/ignore offer state before accept.
3. Offer TTL existed only in memory and was not recoverable.
4. There was no dedicated dispatch smoke test for offer expiry, decline retry, duplicate polling, or concurrent accept.
5. Firestore rules did not explicitly document the new lock collection.

## Changes Implemented

### Persistent Ride Offers

Added Firestore-backed dispatch offer handling in `FirestoreDispatchRepository`:

- `rideOffers/{rideId_driverId}`
- `rideOfferLocks/{rideId}`

The offer document stores:

- `rideId`
- `driverId`
- `status`
- `createdAt`
- `expiresAt`
- `acceptedAt`, `rejectedAt`, or `expiredAt` when applicable

The lock document stores the current active offer for a ride and is read/written inside a Firestore transaction. This protects against multiple backend instances offering the same ride to multiple drivers at the same time.

### Dispatch Flow

In Firestore mode:

1. Driver polls `/api/dispatch/incoming`.
2. Backend first returns any active assigned ride.
3. Backend then recovers an existing non-expired pending offer for that driver.
4. If none exists, it creates a new offer for the next eligible searching ride.
5. Expired offers are marked `EXPIRED`.
6. Rejected offers are marked `REJECTED`.
7. The same driver is not offered the same ride again after expiry/rejection.
8. Another driver can receive the ride after expiry or rejection.

Demo mode remains separated and still uses the process-local offer map.

### Atomic Accept Preserved

The existing Firestore transaction for `acceptRide` remains authoritative. In Firestore mode, accepting a searching ride now also requires an active non-expired pending offer for that driver. On accept:

- ride moves to `DRIVER_ARRIVING`
- driver operational state becomes `IN_RIDE`
- offer becomes `ACCEPTED`
- ride lock becomes `ACCEPTED`

Concurrent accept remains protected by the ride transaction and driver lock checks.

### Offer TTL

Added:

```text
DISPATCH_OFFER_TTL_MS=15000
```

to `.env.example`, surfaced through `backend/src/config.ts`.

### Firestore Rules

Added explicit admin-only rules for:

```text
rideOfferLocks/{rideId}
```

Client apps do not write financial or dispatch lock state directly. Backend Admin SDK bypasses client rules as intended.

### Firestore Indexes

`firebase/firestore.indexes.json` was reviewed. No new index was required for the implemented query shape because the project already has:

- `rideOffers`: `driverId ASC`, `status ASC`, `createdAt DESC`

`rideOfferLocks/{rideId}` is accessed by direct document ID and does not need a composite index.

### Tests Added

Added:

```text
npm.cmd run test:dispatch
```

and included it in `qa:critical`.

The smoke test covers local/demo dispatch behavior:

- active offer is returned to the same driver on duplicate polling
- active offer is not sent to another driver before expiry
- expired offer can be retried for another driver
- rejected offer is not sent again to the same driver
- rejected offer can be retried for another driver
- two drivers accepting concurrently produces exactly one winner
- assigned driver can recover active ride from backend after reconnect

## Test Results

PASS:

- `cd backend && npm.cmd run typecheck`
- `cd backend && npm.cmd run test:dispatch`
- `cd backend && npm.cmd run test:ride-auth`
- `cd backend && npm.cmd run test:payments`
- `cd backend && npm.cmd run scan:secrets`
- `cd backend && npm.cmd run validate:config`

BLOCKED / Deferred:

- Firestore emulator tests for true persistent restart/multi-worker behavior were not run because real Firebase/emulator wiring is not active in this task.
- Flutter analyze/test remains blocked by the known local Flutter CLI hang from TASK 02.

## Firebase Tests Deferred

After Firebase or the emulator is available, run tests for:

1. Two backend instances polling `/api/dispatch/incoming` for different drivers at the same time.
2. Offer persistence after backend restart.
3. Expired Firestore offer becomes `EXPIRED` and another driver receives the ride.
4. Rejected Firestore offer becomes `REJECTED` and another driver receives the ride.
5. Driver without approved KYC cannot receive/accept production offers.
6. Accept without a current offer returns `OFFER_REQUIRED`.
7. Accept after TTL returns `OFFER_EXPIRED`.
8. Firestore indexes satisfy `rideOffers` driver/status/createdAt queries.

## Risks Remaining

- Persistent offer creation is ready in code but still needs emulator or real Firestore validation.
- There is no background sweeper yet; expired offers are marked when drivers poll or accept. This is acceptable for pilot, but production should add scheduled cleanup/dispatch sweeps.
- Nearby driver scoring is still basic and depends on the existing eligible-driver/searching-rides foundations.
- Customer-facing no-driver timeout still needs an operational job if no eligible driver is found for a long period.

## Readiness

TASK 03 is ready for code review and local backend merge testing.

It is not yet fully proven for real pilot until Firebase/Firestore emulator or real Firestore validates persistent offers across backend restarts and multiple backend instances.
