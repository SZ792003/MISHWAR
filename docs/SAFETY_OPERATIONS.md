# Safety Operations - Stage 9A

## Scope
Stage 9A adds an internal MISHWAR safety escalation foundation. It does not integrate with police, ambulance, civil defense, or any external emergency authority. Any external responder integration requires legal approval, operating procedures, and technical agreements before launch.

## SOS Lifecycle
1. A customer or driver presses the in-ride `السلامة / SOS` control.
2. The app asks for a short confirmation to reduce accidental taps.
3. `POST /api/rides/:rideId/sos` verifies authentication, ride participation, active ride state, and duplicate active SOS incidents.
4. The backend creates or returns the active `sos` incident for the same reporter and ride.
5. The incident stores ride and location snapshots, writes safety metrics, attempts audit logging, and sends an internal safety notification event.
6. Dispatch/safety staff can acknowledge, escalate, and resolve the incident from protected admin APIs.

## Incident Lifecycle
Safety incidents use these statuses:

- `open`
- `acknowledged`
- `in_review`
- `escalated`
- `resolved`
- `closed`
- `cancelled`

Implemented admin endpoints:

- `GET /api/admin/safety/incidents`
- `GET /api/admin/safety/incidents/:id`
- `POST /api/admin/safety/incidents/:id/acknowledge`
- `POST /api/admin/safety/incidents/:id/escalate`
- `POST /api/admin/safety/incidents/:id/resolve`

Safety reviewer roles are `ADMIN`, `SUPER_ADMIN`, `OPS_MANAGER`, `DISPATCHER`, and `SUPPORT`.

## Incident Types
Supported incident types:

- `sos`
- `unsafe_driver`
- `unsafe_passenger`
- `accident`
- `harassment`
- `vehicle_issue`
- `medical_concern`
- `route_concern`
- `lost_item`
- `other`

SOS is reserved for urgent cases. Non-urgent reports should use `POST /api/rides/:rideId/safety/incidents`.

## Snapshots
Every safety incident stores:

- Ride snapshot: ride ID, ride status, customer ID, driver ID, vehicle type, vehicle details, pickup, destination, payment method, and assignment timestamps.
- Location snapshot: backend trusted driver location when available, optional client-provided location, pickup, destination, route distance, route duration, provider, and receive time.

Snapshots are intentionally limited to operational context and avoid copying unnecessary sensitive profile data.

## Safety Signals
`POST /api/rides/:rideId/safety/signals` records review signals such as:

- `long_stop`
- `significant_route_deviation`
- `repeated_location_loss`
- `manual_concern`
- `sos_pressed`

Signals do not automatically create SOS incidents. They are review inputs for safety prompts and dispatcher workflows.

## Evidence
Incident attachment metadata is created through `POST /api/safety/incidents/:id/attachments`. Storage rules allow private uploads under:

`ride-incidents/{rideId}/{incidentId}/{userId}/{fileName}`

Allowed content types are JPEG, PNG, WEBP, and PDF with a 10 MB limit. Files are not public.

## Privacy
Sensitive incidents such as `harassment`, `unsafe_driver`, and `unsafe_passenger` hide description, attachments, and fine location details from the opposite party. Safety reviewers and the reporter can see full details.

## Notifications
SOS creates an internal `sos` notification event for safety/dispatcher infrastructure. The current foundation does not claim delivery to external authorities. Opposite-party notifications must be governed by incident type policy to avoid exposing a reporter to risk.

## Audit And Metrics
Audit event types include:

- `SAFETY_INCIDENT_CREATED`
- `SAFETY_SOS_TRIGGERED`
- `SAFETY_INCIDENT_ACKNOWLEDGED`
- `SAFETY_INCIDENT_ESCALATED`
- `SAFETY_INCIDENT_RESOLVED`
- `SAFETY_ATTACHMENT_ADDED`
- `SAFETY_SIGNAL_CREATED`

Metrics include:

- `safety_incidents_total`
- `sos_events_total`
- `safety_incidents_open`
- `safety_incidents_resolved_total`
- `safety_escalations_total`

Metrics do not use user IDs or ride IDs as labels.

## Abuse Protection
SOS is rate-limited and deduplicated per active ride, reporter, and unresolved SOS incident. A new SOS can be created after the previous one is resolved, closed, or cancelled.

## Limitations
This is Stage 9A foundation. Remaining work includes full dispatcher UI, richer emergency-contact UX, real notification routing to safety staff devices, attachment upload UI, operational runbooks, and real-device validation.
