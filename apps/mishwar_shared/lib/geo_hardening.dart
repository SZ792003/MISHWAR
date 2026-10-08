import 'package:mishwar_shared/geo_models.dart';
import 'package:mishwar_shared/location_update_policy.dart';

enum LiveLocationFreshness {
  fresh,
  stale,
  offline,
  unknown,
}

class LiveLocationStatus {
  const LiveLocationStatus({
    required this.freshness,
    required this.label,
    this.elapsed,
  });

  final LiveLocationFreshness freshness;
  final String label;
  final Duration? elapsed;
}

class LocationQualityResult {
  const LocationQualityResult({
    required this.accepted,
    required this.reason,
  });

  final bool accepted;
  final String reason;
}

class RouteRefreshDecision {
  const RouteRefreshDecision({
    required this.shouldRefresh,
    required this.reason,
  });

  final bool shouldRefresh;
  final String reason;
}

const maxDisplayLocationAccuracyMeters = 250.0;
const impossibleJumpSpeedMetersPerSecond = 65.0;
const staleDriverLocationAfter = Duration(seconds: 45);
const offlineDriverLocationAfter = Duration(minutes: 3);
const minimumRouteRefreshInterval = Duration(seconds: 45);
const offRouteDistanceThresholdMeters = 180.0;

LiveLocationStatus liveLocationStatus(String? updatedAtIso, {DateTime? now}) {
  if (updatedAtIso == null || updatedAtIso.isEmpty) {
    return const LiveLocationStatus(
      freshness: LiveLocationFreshness.unknown,
      label: 'بانتظار موقع الكابتن',
    );
  }
  final updatedAt = DateTime.tryParse(updatedAtIso)?.toLocal();
  if (updatedAt == null) {
    return const LiveLocationStatus(
      freshness: LiveLocationFreshness.unknown,
      label: 'موقع الكابتن غير متاح',
    );
  }
  final elapsed = (now ?? DateTime.now()).difference(updatedAt);
  if (elapsed >= offlineDriverLocationAfter) {
    return LiveLocationStatus(
      freshness: LiveLocationFreshness.offline,
      label: 'موقع الكابتن غير متصل وقد يكون قديماً',
      elapsed: elapsed,
    );
  }
  if (elapsed >= staleDriverLocationAfter) {
    return LiveLocationStatus(
      freshness: LiveLocationFreshness.stale,
      label: 'آخر تحديث للموقع قبل ${elapsed.inMinutes < 1 ? 'أقل من دقيقة' : '${elapsed.inMinutes} دقيقة'}',
      elapsed: elapsed,
    );
  }
  return LiveLocationStatus(
    freshness: LiveLocationFreshness.fresh,
    label: elapsed.inSeconds < 10 ? 'موقع الكابتن مباشر' : 'آخر تحديث للموقع قبل قليل',
    elapsed: elapsed,
  );
}

LocationQualityResult evaluateDisplayLocation({
  required double latitude,
  required double longitude,
  double? accuracyMeters,
  DateTime? capturedAt,
  DateTime? now,
  double? previousLatitude,
  double? previousLongitude,
  DateTime? previousCapturedAt,
}) {
  if (!latitude.isFinite || !longitude.isFinite || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return const LocationQualityResult(accepted: false, reason: 'invalid_coordinates');
  }
  if (accuracyMeters != null && accuracyMeters > maxDisplayLocationAccuracyMeters) {
    return const LocationQualityResult(accepted: false, reason: 'low_accuracy');
  }
  final currentNow = now ?? DateTime.now();
  if (capturedAt != null && capturedAt.difference(currentNow) > const Duration(minutes: 2)) {
    return const LocationQualityResult(accepted: false, reason: 'future_timestamp');
  }
  if (capturedAt != null && currentNow.difference(capturedAt) > const Duration(minutes: 2)) {
    return const LocationQualityResult(accepted: false, reason: 'stale_timestamp');
  }
  if (previousLatitude != null && previousLongitude != null && previousCapturedAt != null && capturedAt != null) {
    final elapsedSeconds = capturedAt.difference(previousCapturedAt).inMilliseconds / 1000;
    if (elapsedSeconds > 0) {
      final movedMeters = haversineMeters(previousLatitude, previousLongitude, latitude, longitude);
      if (movedMeters / elapsedSeconds > impossibleJumpSpeedMetersPerSecond) {
        return const LocationQualityResult(accepted: false, reason: 'impossible_jump');
      }
    }
  }
  return const LocationQualityResult(accepted: true, reason: 'accepted');
}

RouteRefreshDecision shouldRefreshRoute({
  required DateTime now,
  DateTime? lastRefreshAt,
  GeoPointModel? currentLocation,
  List<GeoPointModel> routePolyline = const [],
  bool destinationChanged = false,
  bool routeModeChanged = false,
}) {
  if (destinationChanged) return const RouteRefreshDecision(shouldRefresh: true, reason: 'destination_changed');
  if (routeModeChanged) return const RouteRefreshDecision(shouldRefresh: true, reason: 'route_mode_changed');
  if (lastRefreshAt != null && now.difference(lastRefreshAt) < minimumRouteRefreshInterval) {
    return const RouteRefreshDecision(shouldRefresh: false, reason: 'minimum_interval');
  }
  if (lastRefreshAt == null || now.difference(lastRefreshAt) >= const Duration(minutes: 3)) {
    return const RouteRefreshDecision(shouldRefresh: true, reason: 'stale_route');
  }
  if (currentLocation != null && routePolyline.length >= 2) {
    final distance = distanceToPolylineMeters(currentLocation, routePolyline);
    if (distance > offRouteDistanceThresholdMeters) {
      return const RouteRefreshDecision(shouldRefresh: true, reason: 'off_route');
    }
  }
  return const RouteRefreshDecision(shouldRefresh: false, reason: 'route_still_valid');
}

double distanceToPolylineMeters(GeoPointModel point, List<GeoPointModel> polyline) {
  if (polyline.isEmpty) return double.infinity;
  var best = double.infinity;
  for (final candidate in polyline) {
    final distance = haversineMeters(point.latitude, point.longitude, candidate.latitude, candidate.longitude);
    if (distance < best) best = distance;
  }
  return best;
}
