import 'package:flutter_test/flutter_test.dart';
import 'package:mishwar_shared/geo_hardening.dart';
import 'package:mishwar_shared/geo_models.dart';

void main() {
  test('GeoPointModel parses valid API coordinates', () {
    final point = GeoPointModel.fromJson({
      'latitude': 15.3694,
      'longitude': 44.191,
    });

    expect(point, isNotNull);
    expect(point!.latitude, 15.3694);
    expect(point.longitude, 44.191);
    expect(point.toJson(), {'latitude': 15.3694, 'longitude': 44.191});
  });

  test('route formatting handles short and long distances', () {
    expect(formatDistance(900), contains('900'));
    expect(formatDistance(1250), contains('1.3'));
    expect(formatDuration(120), contains('2'));
    expect(formatDuration(3660), contains('1'));
  });

  test('location hardening rejects impossible jumps', () {
    final now = DateTime.utc(2026, 1, 1, 12);
    final result = evaluateDisplayLocation(
      latitude: 16,
      longitude: 45,
      capturedAt: now,
      now: now,
      previousLatitude: 15,
      previousLongitude: 44,
      previousCapturedAt: now.subtract(const Duration(seconds: 1)),
    );

    expect(result.accepted, isFalse);
    expect(result.reason, 'impossible_jump');
  });

  test('route refresh respects destination changes and minimum interval', () {
    final now = DateTime.utc(2026, 1, 1, 12);

    expect(
      shouldRefreshRoute(now: now, destinationChanged: true).shouldRefresh,
      isTrue,
    );
    expect(
      shouldRefreshRoute(
        now: now,
        lastRefreshAt: now.subtract(const Duration(seconds: 5)),
      ).reason,
      'minimum_interval',
    );
  });
}
