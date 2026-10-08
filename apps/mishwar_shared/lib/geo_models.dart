class GeoPointModel {
  const GeoPointModel({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;

  Map<String, dynamic> toJson() => {
        'latitude': latitude,
        'longitude': longitude,
      };

  static GeoPointModel? fromJson(Object? value) {
    if (value is! Map) return null;
    final latitude = (value['latitude'] as num?)?.toDouble();
    final longitude = (value['longitude'] as num?)?.toDouble();
    if (latitude == null || longitude == null) return null;
    return GeoPointModel(latitude: latitude, longitude: longitude);
  }
}

class PlaceModel {
  const PlaceModel({
    required this.id,
    required this.name,
    required this.address,
    required this.latitude,
    required this.longitude,
    required this.provider,
    required this.type,
    this.distanceMeters,
  });

  final String id;
  final String name;
  final String address;
  final double latitude;
  final double longitude;
  final String provider;
  final String type;
  final int? distanceMeters;

  static PlaceModel fromJson(Map<String, dynamic> json) => PlaceModel(
        id: json['id']?.toString() ?? '',
        name: json['name']?.toString() ?? '',
        address: json['address']?.toString() ?? '',
        latitude: (json['latitude'] as num).toDouble(),
        longitude: (json['longitude'] as num).toDouble(),
        provider: json['provider']?.toString() ?? 'unknown',
        type: json['type']?.toString() ?? 'unknown',
        distanceMeters: (json['distanceMeters'] as num?)?.round(),
      );
}

class RouteModel {
  const RouteModel({
    required this.origin,
    required this.destination,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.polyline,
    required this.provider,
    required this.calculatedAt,
    this.fallback = false,
  });

  final GeoPointModel origin;
  final GeoPointModel destination;
  final int distanceMeters;
  final int durationSeconds;
  final List<GeoPointModel> polyline;
  final String provider;
  final String calculatedAt;
  final bool fallback;

  static RouteModel fromJson(Map<String, dynamic> json) => RouteModel(
        origin: GeoPointModel.fromJson(json['origin'])!,
        destination: GeoPointModel.fromJson(json['destination'])!,
        distanceMeters: (json['distanceMeters'] as num).round(),
        durationSeconds: (json['durationSeconds'] as num).round(),
        polyline: ((json['polyline'] as List?) ?? const [])
            .map(GeoPointModel.fromJson)
            .whereType<GeoPointModel>()
            .toList(),
        provider: json['provider']?.toString() ?? 'unknown',
        calculatedAt: json['calculatedAt']?.toString() ?? '',
        fallback: json['fallback'] == true,
      );
}

String formatDistance(int meters) {
  if (meters < 1000) return '$meters م';
  final km = meters / 1000;
  return '${km.toStringAsFixed(km >= 10 ? 0 : 1)} كم';
}

String formatDuration(int seconds) {
  final minutes = (seconds / 60).ceil();
  if (minutes < 60) return '$minutes دقيقة';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  return rest == 0 ? '$hours ساعة' : '$hours ساعة و $rest دقيقة';
}
