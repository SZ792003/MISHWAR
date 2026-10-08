import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:latlong2/latlong.dart';

class MishwarMap extends StatefulWidget {
  const MishwarMap({
    super.key,
    required this.centerLatitude,
    required this.centerLongitude,
    this.pickupLatitude,
    this.pickupLongitude,
    this.destinationLatitude,
    this.destinationLongitude,
    this.driverLatitude,
    this.driverLongitude,
    this.onMapTap,
    this.routingEnabled = true,
    this.routePolyline = const [],
    this.followTarget = true,
  });

  final double centerLatitude;
  final double centerLongitude;
  final double? pickupLatitude;
  final double? pickupLongitude;
  final double? destinationLatitude;
  final double? destinationLongitude;
  final double? driverLatitude;
  final double? driverLongitude;
  final void Function(double latitude, double longitude)? onMapTap;
  final bool routingEnabled;
  final List<GeoPointModel> routePolyline;
  final bool followTarget;

  @override
  State<MishwarMap> createState() => _MishwarMapState();
}

class _MishwarMapState extends State<MishwarMap> {
  final _mapController = MapController();
  List<LatLng> _routePoints = const [];
  bool _followTarget = true;

  LatLng? get _pickup => _point(widget.pickupLatitude, widget.pickupLongitude);
  LatLng? get _destination => _point(widget.destinationLatitude, widget.destinationLongitude);

  LatLng? _point(double? latitude, double? longitude) {
    if (latitude == null || longitude == null) return null;
    return LatLng(latitude, longitude);
  }

  @override
  void initState() {
    super.initState();
    _followTarget = widget.followTarget;
    _loadRoute();
  }

  @override
  void didUpdateWidget(covariant MishwarMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.pickupLatitude != widget.pickupLatitude ||
        oldWidget.pickupLongitude != widget.pickupLongitude ||
        oldWidget.destinationLatitude != widget.destinationLatitude ||
        oldWidget.destinationLongitude != widget.destinationLongitude ||
        oldWidget.driverLatitude != widget.driverLatitude ||
        oldWidget.driverLongitude != widget.driverLongitude ||
        oldWidget.routePolyline.length != widget.routePolyline.length) {
      _loadRoute();
      if (_followTarget) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _moveToTarget());
      }
    }
  }

  Future<void> _loadRoute() async {
    final pickup = _pickup;
    final destination = _destination;
    if (pickup == null || destination == null) {
      if (mounted) setState(() => _routePoints = const []);
      return;
    }

    final trustedPoints = widget.routePolyline
        .map((point) => LatLng(point.latitude, point.longitude))
        .toList();
    setState(() => _routePoints = trustedPoints.length > 1 ? trustedPoints : [pickup, destination]);
  }

  void _moveToTarget() {
    if (!mounted) return;
    final driver = _point(widget.driverLatitude, widget.driverLongitude);
    final pickup = _pickup;
    final destination = _destination;
    final center = LatLng(widget.centerLatitude, widget.centerLongitude);
    final target = driver ??
        (pickup != null && destination != null
            ? LatLng((pickup.latitude + destination.latitude) / 2, (pickup.longitude + destination.longitude) / 2)
            : center);
    _mapController.move(target, driver == null ? 13 : 16);
  }

  @override
  Widget build(BuildContext context) {
    final pickup = _pickup;
    final destination = _destination;
    final driver = _point(widget.driverLatitude, widget.driverLongitude);
    final center = LatLng(widget.centerLatitude, widget.centerLongitude);
    final routeCenter = pickup != null && destination != null
        ? LatLng((pickup.latitude + destination.latitude) / 2, (pickup.longitude + destination.longitude) / 2)
        : center;
    final hasDistinctRoute = pickup != null &&
      destination != null &&
      (pickup.latitude != destination.latitude || pickup.longitude != destination.longitude);
    final cameraPoints = [
      if (pickup != null) pickup,
      if (destination != null) destination,
      if (driver != null) driver,
    ];
    final markers = <Marker>[
      if (pickup != null)
        _marker(pickup, Icons.trip_origin, const Color(0xFF10B981), 'موقع الانطلاق'),
      if (destination != null)
        _marker(destination, Icons.location_on, const Color(0xFFF97316), 'الوجهة'),
      if (driver != null)
        _marker(driver, Icons.directions_car, const Color(0xFF38BDF8), 'الكابتن'),
    ];

    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: FlutterMap(
        key: ValueKey('${routeCenter.latitude}:${routeCenter.longitude}'),
        mapController: _mapController,
        options: MapOptions(
          initialCenter: routeCenter,
          initialZoom: 13,
          initialCameraFit: hasDistinctRoute
              ? CameraFit.bounds(
                  bounds: LatLngBounds.fromPoints(cameraPoints),
                  padding: const EdgeInsets.all(42),
                )
              : null,
          onMapReady: () => setState(() {}),
          onPositionChanged: (camera, hasGesture) {
            if (hasGesture && _followTarget) {
              setState(() => _followTarget = false);
            }
          },
          onTap: widget.onMapTap == null
              ? null
              : (tapPosition, point) => widget.onMapTap!(point.latitude, point.longitude),
        ),
        children: [
          TileLayer(
            urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            userAgentPackageName: 'com.mishwar.ride_hailing',
            maxZoom: 19,
          ),
          if (_routePoints.length > 1)
            PolylineLayer(
              polylines: [
                Polyline(points: _routePoints, strokeWidth: 4, color: const Color(0xFF10B981)),
              ],
            ),
          if (markers.isNotEmpty) MarkerLayer(markers: markers),
          Align(
            alignment: Alignment.topRight,
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Material(
                color: Theme.of(context).colorScheme.surface,
                shape: const CircleBorder(),
                elevation: 3,
                child: IconButton(
                  tooltip: driver == null ? 'إعادة توسيط الخريطة' : 'توسيط الخريطة على الكابتن',
                  onPressed: () {
                    setState(() => _followTarget = true);
                    _moveToTarget();
                  },
                  icon: Icon(driver == null ? Icons.fit_screen : Icons.my_location),
                ),
              ),
            ),
          ),
          if (!_followTarget)
            Align(
              alignment: Alignment.topCenter,
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: FilledButton.icon(
                  onPressed: () {
                    setState(() => _followTarget = true);
                    _moveToTarget();
                  },
                  icon: const Icon(Icons.gps_fixed, size: 18),
                  label: Text(driver == null ? 'العودة للمسار' : 'العودة لمتابعة الكابتن'),
                ),
              ),
            ),
          const RichAttributionWidget(
            alignment: AttributionAlignment.bottomRight,
            attributions: [
              TextSourceAttribution('© OpenStreetMap contributors'),
              TextSourceAttribution('Route by MISHWAR backend'),
            ],
          ),
          Align(
            alignment: Alignment.bottomLeft,
            child: IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Colors.white.withOpacity(0.9),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                  child: Text(
                    '© OpenStreetMap contributors · Route by MISHWAR backend',
                    style: TextStyle(color: Color(0xFF263238), fontSize: 9),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Marker _marker(LatLng point, IconData icon, Color color, String label) {
    return Marker(
      point: point,
      width: 42,
      height: 48,
      child: Tooltip(
        message: label,
        child: Icon(icon, color: color, size: 36, shadows: const [Shadow(color: Colors.black54, blurRadius: 5)]),
      ),
    );
  }
}
