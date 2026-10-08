# MISHWAR Live Location Apps

This phase connects live driver location for the Flutter driver and customer
apps only.

## Flow

Driver app GPS -> throttling policy -> backend `/api/rides/:id/location` ->
Firestore `driverLocations/{driverId}` -> customer app Firestore listener ->
driver marker on the ride map.

## Running The Apps

The Flutter apps live under `apps/`:

- `apps/customer_app`
- `apps/driver_app`

After installing Flutter, run both web app pages from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File apps/run_mobile_apps.ps1
```

Default pages:

- Customer app: `http://localhost:5101`
- Driver app: `http://localhost:5102`
- Backend API: `http://localhost:4000`

## Firestore Document

Canonical collection:

```text
driverLocations/{driverId}
```

Fields:

- `driverId`
- `rideId`
- `latitude`
- `longitude`
- `accuracy`
- `heading`
- `speed`
- `status`
- `clientUpdatedAt`
- `updatedAt`
- `serverUpdatedAt`

The backend uses the authenticated Firebase UID as `driverId`; the driver app
does not decide which driver document to write.

## Throttling

The shared Flutter policy is in:

```text
apps/mishwar_shared/lib/location_update_policy.dart
```

Intervals:

- active trip: faster updates
- arriving: medium updates
- online idle: slower updates
- offline: no periodic updates

Uploads are skipped when the minimum interval has not passed, the movement is
too small, or GPS accuracy is very poor. A heartbeat upload is still allowed
after the maximum stale interval.

## Customer Listener

The customer app listens only to the assigned driver's document while the ride
is active and trackable. It stops the listener on completion, cancellation,
unmount, or reassignment.

Demo mode keeps the existing simulated/polled behavior. Production mode uses
Firestore `driverLocations`.

