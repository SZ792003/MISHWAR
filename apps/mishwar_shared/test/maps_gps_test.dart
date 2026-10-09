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
      GeoPointModel(latitude: 15.3694, longitude: 44.191),
      GeoPointModel(latitude: 95, longitude: 44.191),
      GeoPointModel(latitude: 15.347, longitude: 44.206),
      GeoPointModel(latitude: 15.0, longitude: 200),
    ]);

    expect(points, hasLength(2));
    expect(points.first.latitude, 15.3694);
    expect(points.last.longitude, 44.206);
  });
}
