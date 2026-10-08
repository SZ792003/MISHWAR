# Geo Services

Stage 8A moves production geo decisions behind the backend while keeping Flutter responsible for map display, user interaction, GPS, and route presentation.
Stage 8B adds GPS quality filtering, stale-location handling, route/geocode caching, provider backoff, offline location safeguards, and map follow safety.

## Current Map Provider

The Flutter apps use `flutter_map` with OpenStreetMap tiles. The previous direct client call to the public OSRM route endpoint was removed from the shared map widget. Route geometry now comes from the Mishwar backend.

## Responsibilities

Flutter:

- Displays the map.
- Handles manual pin selection.
- Requests current GPS location.
- Shows place search results.
- Shows route polyline, distance, and ETA returned by the backend.

Backend:

- Validates coordinates.
- Normalizes place search and reverse geocoding responses.
- Calculates route distance, duration, and polyline through a provider abstraction.
- Recalculates trusted route data during ride creation.
- Feeds trusted route distance into fare calculation.
- Keeps server-side provider credentials out of Flutter.

## Providers

Configured by environment:

- `MAP_PROVIDER`
- `GEOCODING_PROVIDER`
- `ROUTING_PROVIDER`
- `MAPS_API_KEY`
- `GEOCODING_API_KEY`
- `ROUTING_API_KEY`
- `OSRM_BASE_URL`
- `NOMINATIM_BASE_URL`
- `GEO_COUNTRY_BIAS`
- `GEO_REQUEST_TIMEOUT_MS`

Current fallback providers:

- `internal` place search uses a small Yemen-biased local dataset for development.
- `manual` reverse geocoding preserves coordinates when no address is available.
- `internal_fallback` routing uses validated coordinates plus an urban distance factor. It is a development/pilot fallback, not a replacement for a production routing provider.

Strict backend modes reject `internal` geocoding and `internal_fallback` routing for production activation. Configure a real provider before setting `APP_MODE=production`, `APP_MODE=pilot`, or `APP_MODE=staging`.
Provider failures and rate limits trigger short exponential backoff. If no secondary provider is configured in strict mode, the backend fails safely instead of silently using a demo/public fallback.

Optional adapters:

- `nominatim` for search/reverse when `NOMINATIM_BASE_URL` is configured.
- `osrm` for routing when `OSRM_BASE_URL` is configured.

Production provider activation is pending official provider configuration, terms review, quota planning, and restricted keys.

## API Endpoints

- `GET /api/geo/search?q=...&latitude=...&longitude=...`
- `GET /api/geo/reverse?latitude=...&longitude=...`
- `POST /api/geo/route`

All endpoints require auth and rate limiting.
Route and reverse-geocode responses are cached using rounded coordinate grid keys and TTLs to avoid provider spam from tiny GPS changes.

## Ride Creation

Ride creation ignores any client-supplied fake route distance. The backend validates pickup/destination coordinates, calculates a trusted route snapshot, stores:

- `routeDistanceMeters`
- `routeDurationSeconds`
- `routingProvider`
- `routeCalculatedAt`
- `routePolyline`

Fare calculation uses the trusted route distance and duration.

## Flutter UX

Customer app supports:

- Pickup search.
- Destination search.
- Current location.
- Manual pin selection.
- Reverse geocoding fallback.
- Route preview with distance and ETA.

Driver app supports:

- Pickup/destination route display.
- Driver-to-pickup route preview while approaching.
- Throttled route recalculation instead of recalculating on every GPS update.
- GPS quality filtering for low accuracy, stale timestamps, future timestamps, and impossible jumps.
- Bounded offline location behavior: only the latest relevant location update is queued per ride.
- Map follow mode pauses when the user pans and can be resumed with the follow button.

## Driver Location Validation

Backend driver location updates validate:

- authenticated driver role and assigned ride
- numeric latitude/longitude
- accuracy, heading, and speed ranges
- future and stale device timestamps
- impossible jumps compared with the previous trusted driver location
- server `receivedAt` in addition to device timestamp

Firestore `driverLocations/{driverId}` stores the latest live location only in this stage. Unlimited location history is intentionally out of scope.

## Observability

Low-cardinality counters include:

- `geo_route_requests_total`
- `geo_route_failures_total`
- `geo_route_cache_hits_total`
- `geo_geocode_requests_total`
- `geo_geocode_cache_hits_total`
- `geo_provider_failures_total`
- `driver_location_rejected_total`
- `driver_location_stale_total`
- `driver_location_updates_total`

Do not add driver IDs, exact coordinates, home addresses, or route polylines as metric labels.

## Privacy

Do not log precise pickup, destination, or home coordinates in routine logs. Use IDs, statuses, provider names, and coarse diagnostics. Keep API keys in environment/secret management.

## Mobile Key Restrictions

If a mobile SDK key is used later, restrict it:

- Android: package name and signing certificate SHA.
- iOS: Bundle ID.

Do not use unrestricted mobile keys.

## Failure Handling

Geo services must handle:

- Timeout.
- Rate limit.
- Provider unavailable.
- Invalid response.
- No route.
- Offline/network errors.

If search has no result, the user can still use manual pin selection. If reverse geocoding fails, coordinates remain authoritative. If routing fails with no route, do not create a ride with zero distance.

## Real Ride Validation

See `docs/GEO_REAL_RIDE_TEST_PLAN.md`. Stage 8 is not production-complete until the two-device real ride test passes with the selected production provider and credentials.
