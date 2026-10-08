# Geo Real Ride Test Plan

Use this plan after real provider credentials, Firebase project access, and two physical devices are available.

## Devices

- Device A: customer app.
- Device B: driver app.
- Both devices: real network, GPS enabled, current production-like backend URL.

## Preconditions

- Real geocoding/routing provider configured.
- Firebase Auth works on both devices.
- Driver account has approved KYC and trusted `DRIVER` claim.
- Customer account has trusted `CUSTOMER` claim.
- Firestore rules and indexes are deployed.
- Backend `/ready` is healthy.

## Scenarios

1. Grant GPS permission in both apps.
2. Customer taps current location and confirms the pickup pin.
3. Customer searches for a destination and selects a result.
4. Customer moves the pin manually when search result quality is poor.
5. Customer verifies route preview, distance, and ETA.
6. Customer requests a ride.
7. Driver receives the ride and accepts it.
8. Driver app starts live location sharing.
9. Customer app sees driver marker and location freshness status.
10. Customer pans the map; follow mode pauses.
11. Customer taps the follow button; map follows the driver again.
12. Driver starts moving toward pickup; route-to-pickup refreshes only after threshold/stale/off-route conditions.
13. Put driver app in background briefly and confirm no excessive route requests.
14. Simulate weak internet; driver app keeps only the latest relevant queued location.
15. Reconnect internet; latest location is sent and old points do not replay backward.
16. Wait until driver location becomes stale; customer UI shows stale/offline status.
17. Driver reaches pickup and marks arrived.
18. Driver starts trip; route display switches to pickup-to-destination.
19. Driver deviates from route enough to trigger route refresh.
20. Driver completes ride.

## Expected Results

- No production build uses demo/internal geo fallbacks.
- No unrestricted provider key is stored in Flutter source.
- No ride is created with zero route distance.
- Poor GPS accuracy is rejected or held for a better fix.
- Future/stale device timestamps are rejected by backend.
- Impossible jumps are rejected or ignored.
- Map camera does not fight user gestures.
- Metrics increment for route, geocode, provider failure, stale/rejected location, and cache hits.
- Logs do not print precise coordinates for every update.

## Evidence To Capture

- Backend `/metrics` before and after the test.
- Screenshots of customer search, route preview, active tracking, stale location, and completed ride.
- Backend logs for request IDs only, without raw GPS dumps.
- Provider dashboard quota/rate-limit view if available.

Production validation remains incomplete until this plan passes on real devices.
