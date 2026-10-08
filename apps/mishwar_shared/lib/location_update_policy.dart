import 'dart:math' as math;

enum LocationSharingPhase {
  offline,
  onlineIdle,
  arriving,
  activeTrip,
}

class LocationUploadDecision {
  const LocationUploadDecision({
    required this.shouldUpload,
    required this.reason,
  });

  final bool shouldUpload;
  final String reason;
}

class DriverLocationThrottlePolicy {
  const DriverLocationThrottlePolicy();

  Duration minimumInterval(LocationSharingPhase phase) => switch (phase) {
        LocationSharingPhase.activeTrip => const Duration(seconds: 4),
        LocationSharingPhase.arriving => const Duration(seconds: 8),
        LocationSharingPhase.onlineIdle => const Duration(seconds: 45),
        LocationSharingPhase.offline => const Duration(days: 1),
      };

  Duration maximumStaleInterval(LocationSharingPhase phase) => switch (phase) {
        LocationSharingPhase.activeTrip => const Duration(seconds: 20),
        LocationSharingPhase.arriving => const Duration(seconds: 35),
        LocationSharingPhase.onlineIdle => const Duration(minutes: 4),
        LocationSharingPhase.offline => const Duration(days: 1),
      };

  int distanceFilterMeters(LocationSharingPhase phase) => switch (phase) {
        LocationSharingPhase.activeTrip => 10,
        LocationSharingPhase.arriving => 15,
        LocationSharingPhase.onlineIdle => 60,
        LocationSharingPhase.offline => 9999,
      };

  double meaningfulDistanceMeters(LocationSharingPhase phase) => switch (phase) {
        LocationSharingPhase.activeTrip => 12,
        LocationSharingPhase.arriving => 18,
        LocationSharingPhase.onlineIdle => 75,
        LocationSharingPhase.offline => double.infinity,
      };

  double maximumAcceptedAccuracyMeters(LocationSharingPhase phase) => switch (phase) {
        LocationSharingPhase.activeTrip => 120,
        LocationSharingPhase.arriving => 150,
        LocationSharingPhase.onlineIdle => 250,
        LocationSharingPhase.offline => 0,
      };

  LocationUploadDecision shouldUpload({
    required LocationSharingPhase phase,
    required DateTime now,
    required double latitude,
    required double longitude,
    double? accuracyMeters,
    DateTime? capturedAt,
    DateTime? lastUploadedAt,
    double? lastLatitude,
    double? lastLongitude,
    bool appInForeground = true,
  }) {
    if (phase == LocationSharingPhase.offline) {
      return const LocationUploadDecision(shouldUpload: false, reason: 'driver_offline');
    }

    if (!appInForeground && phase == LocationSharingPhase.onlineIdle) {
      return const LocationUploadDecision(shouldUpload: false, reason: 'idle_background');
    }

    if (capturedAt != null && lastUploadedAt != null && capturedAt.isBefore(lastUploadedAt)) {
      return const LocationUploadDecision(shouldUpload: false, reason: 'out_of_order');
    }

    final staleInterval = maximumStaleInterval(phase);
    final timeSinceLast = lastUploadedAt == null ? null : now.difference(lastUploadedAt);
    final forceHeartbeat = timeSinceLast == null || timeSinceLast >= staleInterval;

    if (accuracyMeters != null &&
        accuracyMeters > maximumAcceptedAccuracyMeters(phase) &&
        !forceHeartbeat) {
      return const LocationUploadDecision(shouldUpload: false, reason: 'low_accuracy');
    }

    if (lastUploadedAt != null && timeSinceLast != null && timeSinceLast < minimumInterval(phase)) {
      return const LocationUploadDecision(shouldUpload: false, reason: 'minimum_interval');
    }

    if (lastLatitude == null || lastLongitude == null) {
      return const LocationUploadDecision(shouldUpload: true, reason: 'first_fix');
    }

    final distanceMeters = haversineMeters(lastLatitude, lastLongitude, latitude, longitude);
    if (distanceMeters >= meaningfulDistanceMeters(phase)) {
      return const LocationUploadDecision(shouldUpload: true, reason: 'distance');
    }

    if (forceHeartbeat) {
      return const LocationUploadDecision(shouldUpload: true, reason: 'heartbeat');
    }

    return const LocationUploadDecision(shouldUpload: false, reason: 'distance_threshold');
  }
}

double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
  const radiusMeters = 6371000.0;
  final dLat = _toRadians(lat2 - lat1);
  final dLon = _toRadians(lon2 - lon1);
  final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(_toRadians(lat1)) *
          math.cos(_toRadians(lat2)) *
          math.sin(dLon / 2) *
          math.sin(dLon / 2);
  return radiusMeters * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
}

double _toRadians(double degrees) => degrees * math.pi / 180;

