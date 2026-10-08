# Safety Real Device Test Plan - Stage 9A

## Devices
- Customer device signed in as a customer.
- Driver device signed in as an approved driver.
- Optional dispatcher/admin account with `DISPATCHER`, `OPS_MANAGER`, or `SUPPORT`.

## Setup
1. Start the backend API.
2. Start customer and driver Flutter apps with the same API base URL.
3. Register device tokens if FCM is configured.
4. Create a real test ride and accept it from the driver app.

## Scenarios
1. Customer SOS: press `السلامة / SOS`, confirm, verify incident ID appears and dispatcher can see it.
2. Driver SOS: press `السلامة / SOS`, confirm, verify a separate driver incident is created.
3. Duplicate tap: press SOS repeatedly within seconds and verify the same open incident is returned.
4. Poor network: disconnect the app briefly and verify the user receives a safe failure message; do not silently claim emergency dispatch.
5. Acknowledge: dispatcher acknowledges the incident and the status becomes `acknowledged`.
6. Escalate: dispatcher escalates internally and the status becomes `escalated`.
7. Resolve: dispatcher adds resolution text and marks the incident `resolved`.
8. Attachment: upload a JPEG/PNG/PDF under `ride-incidents/{rideId}/{incidentId}/{userId}/...` and verify private access.
9. Sensitive report: create a `harassment` or unsafe-party incident and verify the opposite party cannot read sensitive details.
10. Location snapshot: verify pickup, destination, driver location when available, and receive timestamp are recorded.
11. Safety signal: send `significant_route_deviation` and verify it creates a signal, not an automatic SOS.
12. Background notification: with FCM enabled, verify internal safety notification delivery to dispatcher infrastructure.

## Pass Criteria
- No external emergency authority claim is shown.
- SOS works for active ride participants only.
- Unrelated users cannot create or view incidents for someone else's ride.
- Admin lifecycle actions are limited to safety reviewer roles.
- Evidence files remain private and content-limited.
