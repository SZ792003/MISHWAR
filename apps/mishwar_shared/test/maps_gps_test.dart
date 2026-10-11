import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:mishwar_shared/location_ui.dart';
import 'package:mishwar_shared/osm_ride_map.dart';

void main() {
  test('location UI states produce clear GPS messages', () {
    expect(
      locationUiMessage(MishwarLocationUiState.waitingForGps),
      contains('GPS'),
    );
    expect(
      locationUiMessage(MishwarLocationUiState.permissionDenied),
      contains('يدوياً'),
    );
    expect(
      locationUiMessage(MishwarLocationUiState.serviceDisabled),
      contains('فعّل'),
    );
  });

  test('route point sanitizer removes invalid mock locations', () {
    final points = sanitizeRoutePoints(const [
      GeoPointModel(latitude: 12.7855, longitude: 45.0187),
      GeoPointModel(latitude: 95, longitude: 45.0187),
      GeoPointModel(latitude: 12.8531, longitude: 44.9717),
      GeoPointModel(latitude: 15.0, longitude: 200),
    ]);

    expect(points, hasLength(2));
    expect(points.first.latitude, 12.7855);
    expect(points.last.longitude, 44.9717);
  });

  test('usable route points do not invent a straight route', () {
    expect(
      hasUsableRoutePolyline(const []),
      isFalse,
    );
    expect(
      hasUsableRoutePolyline(const [
        GeoPointModel(latitude: 12.7855, longitude: 45.0187),
      ]),
      isFalse,
    );
    expect(
      hasTrustedRouteModel(RouteModel(
        origin: const GeoPointModel(latitude: 12.7855, longitude: 45.0187),
        destination: const GeoPointModel(latitude: 12.8531, longitude: 44.9717),
        distanceMeters: 1200,
        durationSeconds: 300,
        polyline: const [],
        provider: 'fallback',
        calculatedAt: DateTime.utc(2026).toIso8601String(),
        fallback: true,
      )),
      isFalse,
    );
  });

  testWidgets('map shows route unavailable instead of a fake polyline',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: SizedBox(
            width: 360,
            height: 360,
            child: MishwarMap(
              centerLatitude: 12.7855,
              centerLongitude: 45.0187,
              pickupLatitude: 12.7855,
              pickupLongitude: 45.0187,
              destinationLatitude: 12.8531,
              destinationLongitude: 44.9717,
              routePolyline: [],
              loadTiles: false,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('المسار غير متاح حالياً'), findsOneWidget);
  });
}
