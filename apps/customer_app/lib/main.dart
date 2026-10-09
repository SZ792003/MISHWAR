import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:mishwar_shared/geo_hardening.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:mishwar_shared/location_ui.dart';
import 'package:mishwar_shared/mishwar_api.dart';
import 'package:mishwar_shared/mishwar_brand.dart';
import 'package:mishwar_shared/mobile_runtime.dart';
import 'package:mishwar_shared/osm_ride_map.dart';
import 'package:mishwar_shared/production_tasks.dart';

final apiProvider = Provider<MishwarApi>(
    (ref) => MishwarApi(firebaseIdTokenProvider: firebaseIdToken));

final healthProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  return ref.watch(apiProvider).health();
});

const _vehicleOptions = <String, String>{
  'ECONOMY': 'سيارة اقتصادية',
  'MOTORCYCLE': 'دراجة نارية',
  'COMFORT': 'سيارة مريحة',
  'FAMILY': 'سيارة عائلية',
};

const _terminalStatuses = <String>{
  'TRIP_COMPLETED',
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_PASSENGER',
  'CANCELLED_BY_DRIVER',
  'NO_DRIVER_FOUND',
  'NO_DRIVER_AVAILABLE',
};

String _rideStatusLabel(String status) => switch (status) {
      'SEARCHING_DRIVER' => 'جاري البحث عن كابتن',
      'DRIVER_ASSIGNED' ||
      'DRIVER_ARRIVING' ||
      'DRIVER_ON_THE_WAY' =>
        'الكابتن في الطريق إليك',
      'DRIVER_ARRIVED' => 'وصل الكابتن إلى موقعك',
      'TRIP_STARTED' => 'مشوارك جارٍ الآن',
      'TRIP_COMPLETED' => 'اكتمل المشوار',
      'CANCELLED_BY_CUSTOMER' || 'CANCELLED_BY_PASSENGER' => 'تم إلغاء المشوار',
      'CANCELLED_BY_DRIVER' => 'ألغى الكابتن المشوار',
      'NO_DRIVER_FOUND' || 'NO_DRIVER_AVAILABLE' => 'لم يتم العثور على كابتن',
      _ => 'حالة المشوار: $status',
    };

String _errorMessage(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    final code =
        data is Map && data['error'] is Map ? data['error']['code'] : null;
    if (code == 'ACCOUNT_BLOCKED' || code == 'ACCOUNT_SUSPENDED') {
      return 'تم تقييد الحساب مؤقتاً، يرجى التواصل مع الدعم.';
    }
    if (data is Map && data['message'] is String) {
      return data['message'] as String;
    }
    return error.message ?? 'تعذر الاتصال بالخادم';
  }
  return 'تعذر تنفيذ الطلب. حاول مرة أخرى.';
}

String _locationUpdateLabel(Object? value) {
  return liveLocationStatus(value is String ? value : null).label;
}

int _intValue(Object? value, {int fallback = 0}) {
  if (value is int) return value;
  if (value is num) return value.round();
  return int.tryParse(value?.toString() ?? '') ?? fallback;
}

double _doubleValue(Object? value, {double fallback = 0}) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '') ?? fallback;
}

String _money(Object? value) => '${_intValue(value)} ر.ي';

String _remainingTimeLabel(Object? value) {
  if (value is! String) return 'الوقت غير محدد';
  final expiresAt = DateTime.tryParse(value);
  if (expiresAt == null) return 'الوقت غير محدد';
  final remaining = expiresAt.difference(DateTime.now().toUtc());
  if (remaining.inSeconds <= 0) return 'انتهت المهلة';
  if (remaining.inMinutes < 1) return 'أقل من دقيقة';
  return '${remaining.inMinutes} دقيقة متبقية';
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await setupFirebaseRuntime(role: 'CUSTOMER');
  runApp(const ProviderScope(child: MishwarCustomerApp()));
}

class MishwarCustomerApp extends StatelessWidget {
  const MishwarCustomerApp({super.key, this.routingEnabled = true});

  final bool routingEnabled;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'مشوار - تطبيق العميل',
      debugShowCheckedModeBanner: false,
      locale: const Locale('ar', 'YE'),
      supportedLocales: const [Locale('ar', 'YE'), Locale('en', 'US')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: MishwarBrand.buildTheme(brightness: Brightness.dark),
      home: AuthGate(
        role: 'CUSTOMER',
        child: CustomerHomeScreen(routingEnabled: routingEnabled),
      ),
    );
  }
}

class CustomerHomeScreen extends ConsumerStatefulWidget {
  const CustomerHomeScreen({super.key, this.routingEnabled = true});

  final bool routingEnabled;

  @override
  ConsumerState<CustomerHomeScreen> createState() => _CustomerHomeScreenState();
}

class _CustomerHomeScreenState extends ConsumerState<CustomerHomeScreen>
    with WidgetsBindingObserver {
  final _pickupController = TextEditingController(text: 'ميدان التحرير');
  final _destinationController = TextEditingController(text: 'شارع حدة');
  final _proposedFareController = TextEditingController(text: '5000');
  double _pickupLatitude = 15.3694;
  double _pickupLongitude = 44.1910;
  double _destinationLatitude = 15.3470;
  double _destinationLongitude = 44.2060;
  String _mapSelection = 'pickup';
  Timer? _pollTimer;
  Timer? _searchDebounce;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _rideSubscription;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>?
      _driverLocationSubscription;
  String? _subscribedDriverId;
  String? _subscribedRideId;
  Map<String, dynamic>? _ride;
  RouteModel? _routePreview;
  List<PlaceModel> _placeResults = const [];
  String _vehicleType = 'ECONOMY';
  String _paymentMethod = 'CASH';
  String _bookingMode = 'FAST';
  List<Map<String, dynamic>> _bids = const [];
  int _passengerCount = 1;
  bool _airConditioningRequired = false;
  bool _busy = false;
  bool _paymentBusy = false;
  bool _refundBusy = false;
  bool _safetyBusy = false;
  bool _refreshing = false;
  bool _locatingCurrentPosition = false;
  int _tabIndex = 0;
  MishwarLocationUiState _locationUiState = MishwarLocationUiState.idle;
  String? _message;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(
        registerMessagingToken(api: ref.read(apiProvider), role: 'CUSTOMER'));
    unawaited(ref.read(apiProvider).syncOfflineQueue());
    unawaited(_refreshRoutePreview());
    _refreshRide();
    _pollTimer =
        Timer.periodic(const Duration(seconds: 5), (_) => _refreshRide());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pollTimer?.cancel();
    _searchDebounce?.cancel();
    _stopRideListener();
    _stopDriverLocationListener();
    _pickupController.dispose();
    _destinationController.dispose();
    _proposedFareController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(ref.read(apiProvider).syncOfflineQueue());
      unawaited(_refreshRide());
      unawaited(_refreshRoutePreview());
    }
  }

  Future<void> _signOut() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await signOutAndClearSession(
        api: ref.read(apiProvider),
        role: 'CUSTOMER',
      );
      if (mounted) {
        setState(
            () => _message = 'تم تسجيل الخروج وتنظيف بيانات الجلسة المحلية.');
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshRide() async {
    if (_refreshing || _busy) return;
    _refreshing = true;
    try {
      final ride = await ref.read(apiProvider).activeRide('CUSTOMER');
      if (mounted) {
        setState(() => _ride = ride);
        _syncRideListener(ride);
        _syncDriverLocationListener(ride);
      }
      if (ride?['bookingMode'] == 'BIDDING' &&
          ride?['biddingStatus'] == 'OPEN') {
        await _refreshBids(ride!['id'] as String);
      }
    } catch (error) {
      if (mounted && _ride == null) {
        setState(() => _message = _errorMessage(error));
      }
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _requestRide() async {
    if (_pickupController.text.trim().isEmpty ||
        _destinationController.text.trim().isEmpty) {
      setState(() => _message = 'أدخل موقع الانطلاق والوجهة أولاً');
      return;
    }
    unawaited(logAnalyticsEvent(
      role: 'CUSTOMER',
      name: 'ride_request_started',
      parameters: {
        'vehicle_type': _vehicleType,
        'payment_method': _paymentMethod,
      },
    ));
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final ride = await ref.read(apiProvider).requestRide(
            pickupName: _pickupController.text.trim(),
            destinationName: _destinationController.text.trim(),
            pickupLatitude: _pickupLatitude,
            pickupLongitude: _pickupLongitude,
            destinationLatitude: _destinationLatitude,
            destinationLongitude: _destinationLongitude,
            vehicleType: _vehicleType,
            passengerCount: _passengerCount,
            airConditioningRequired: _airConditioningRequired,
            paymentMethod: _paymentMethod,
            bookingMode: _bookingMode,
            customerProposedFare: _bookingMode == 'BIDDING'
                ? int.tryParse(_proposedFareController.text
                    .replaceAll(RegExp(r'[^0-9]'), ''))
                : null,
          );
      if (mounted) {
        setState(() => _ride = ride);
        _syncRideListener(ride);
        _syncDriverLocationListener(ride);
      }
      unawaited(logAnalyticsEvent(
        role: 'CUSTOMER',
        name: 'ride_requested',
        parameters: {
          'vehicle_type': _vehicleType,
          'payment_method': _paymentMethod,
          'passenger_count': _passengerCount,
        },
      ));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshBids(String rideId) async {
    try {
      final bids = await ref.read(apiProvider).rideBids(rideId);
      bids.sort((a, b) {
        final amountCompare =
            _intValue(a['amount']).compareTo(_intValue(b['amount']));
        if (amountCompare != 0) return amountCompare;
        final etaCompare =
            _intValue(a['etaMinutes']).compareTo(_intValue(b['etaMinutes']));
        if (etaCompare != 0) return etaCompare;
        return _doubleValue(b['driverRating'])
            .compareTo(_doubleValue(a['driverRating']));
      });
      if (mounted) setState(() => _bids = bids);
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    }
  }

  Future<void> _selectBid(Map<String, dynamic> bid) async {
    final ride = _ride;
    if (ride == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('تأكيد اختيار العرض'),
        content: Text(
          'سيتم اعتماد عرض ${bid['driverName']?.toString() ?? 'كابتن مشوار'} بقيمة ${_money(bid['amount'])}. لا يمكن اختيار عرض آخر بعد التأكيد.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('رجوع')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('اختيار العرض')),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final updated = await ref.read(apiProvider).selectRideBid(
            rideId: ride['id'] as String,
            bidId: bid['id'] as String,
          );
      if (mounted) {
        setState(() {
          _ride = updated;
          _bids = const [];
        });
        _syncRideListener(updated);
        _syncDriverLocationListener(updated);
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _selectMapLocation(double latitude, double longitude) {
    setState(() {
      final coordinates =
          '${latitude.toStringAsFixed(5)}, ${longitude.toStringAsFixed(5)}';
      if (_mapSelection == 'pickup') {
        _pickupLatitude = latitude;
        _pickupLongitude = longitude;
        _pickupController.text = 'موقع الانطلاق على الخريطة ($coordinates)';
      } else {
        _destinationLatitude = latitude;
        _destinationLongitude = longitude;
        _destinationController.text = 'الوجهة على الخريطة ($coordinates)';
      }
    });
    unawaited(_reverseSelectedPoint(latitude, longitude));
    unawaited(_refreshRoutePreview());
  }

  Future<void> _searchPlaces(String query) async {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 450), () async {
      if (query.trim().length < 2) {
        if (mounted) setState(() => _placeResults = const []);
        return;
      }
      try {
        final results = await ref.read(apiProvider).searchPlaces(
              query: query.trim(),
              latitude: _pickupLatitude,
              longitude: _pickupLongitude,
            );
        if (mounted) setState(() => _placeResults = results);
      } catch (_) {
        if (mounted) setState(() => _placeResults = const []);
      }
    });
  }

  void _selectPlace(PlaceModel place) {
    setState(() {
      if (_mapSelection == 'pickup') {
        _pickupLatitude = place.latitude;
        _pickupLongitude = place.longitude;
        _pickupController.text = place.name;
      } else {
        _destinationLatitude = place.latitude;
        _destinationLongitude = place.longitude;
        _destinationController.text = place.name;
      }
      _placeResults = const [];
    });
    unawaited(_refreshRoutePreview());
  }

  Future<void> _useCurrentLocation() async {
    setState(() {
      _locatingCurrentPosition = true;
      _locationUiState = MishwarLocationUiState.waitingForGps;
      _message = locationUiMessage(_locationUiState);
    });
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        setState(() {
          _locationUiState = MishwarLocationUiState.serviceDisabled;
          _message = locationUiMessage(_locationUiState);
        });
        return;
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.deniedForever) {
        setState(() {
          _locationUiState = MishwarLocationUiState.permissionDeniedForever;
          _message = locationUiMessage(_locationUiState);
        });
        return;
      }
      if (permission == LocationPermission.denied) {
        setState(() {
          _locationUiState = MishwarLocationUiState.permissionDenied;
          _message = locationUiMessage(_locationUiState);
        });
        return;
      }
      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 12),
      );
      setState(() {
        _locationUiState = MishwarLocationUiState.ready;
        _message = locationUiMessage(_locationUiState);
      });
      _selectMapLocation(position.latitude, position.longitude);
    } catch (_) {
      if (mounted) {
        setState(() {
          _locationUiState = MishwarLocationUiState.failed;
          _message = locationUiMessage(_locationUiState);
        });
      }
    } finally {
      if (mounted) setState(() => _locatingCurrentPosition = false);
    }
  }

  Future<void> _reverseSelectedPoint(double latitude, double longitude) async {
    try {
      final place = await ref
          .read(apiProvider)
          .reverseGeocode(latitude: latitude, longitude: longitude);
      if (place == null || !mounted) return;
      setState(() {
        if (_mapSelection == 'pickup') {
          _pickupController.text = place.name;
        } else {
          _destinationController.text = place.name;
        }
      });
    } catch (_) {
      // Coordinates remain authoritative even when address lookup fails.
    }
  }

  Future<void> _refreshRoutePreview() async {
    try {
      final route = await ref.read(apiProvider).calculateRoute(
            origin: GeoPointModel(
                latitude: _pickupLatitude, longitude: _pickupLongitude),
            destination: GeoPointModel(
                latitude: _destinationLatitude,
                longitude: _destinationLongitude),
            vehicleType: _vehicleType,
          );
      if (mounted) {
        setState(() => _routePreview = route);
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _routePreview = null;
          _message = 'تعذر العثور على مسار بين الموقعين.';
        });
      }
    }
  }

  List<GeoPointModel> _routePolylineFromRide(Map<String, dynamic> ride) {
    final raw = ride['routePolyline'];
    if (raw is! List) return _routePreview?.polyline ?? const [];
    return raw.map(GeoPointModel.fromJson).whereType<GeoPointModel>().toList();
  }

  Future<bool> _ensureFirebaseReady() async {
    return ensureFirebaseReady();
  }

  void _syncRideListener(Map<String, dynamic>? ride) {
    final rideId = ride?['id'] as String?;
    final status = ride?['status'] as String?;
    final canListen = rideId != null &&
        !_terminalStatuses.contains(status) &&
        mishwarAppMode.toLowerCase() != 'demo';

    if (!canListen) {
      _stopRideListener();
      return;
    }

    unawaited(_ensureFirebaseReady().then((ready) {
      if (!ready || !mounted) return;
      _rideSubscription?.cancel();
      _rideSubscription = FirebaseFirestore.instance
          .collection('rides')
          .doc(rideId)
          .snapshots()
          .listen(
        (snapshot) {
          if (!mounted || !snapshot.exists) return;
          final data = snapshot.data();
          if (data == null) return;
          setState(() => _ride = {...data, 'id': data['id'] ?? rideId});
          _syncDriverLocationListener(_ride);
        },
      );
    }));
  }

  void _syncDriverLocationListener(Map<String, dynamic>? ride) {
    final status = ride?['status'] as String?;
    final rideId = ride?['id'] as String?;
    final driverId = ride?['driverId'] as String?;
    final canTrack = rideId != null &&
        driverId != null &&
        !_terminalStatuses.contains(status) &&
        status != 'SEARCHING_DRIVER' &&
        mishwarAppMode.toLowerCase() != 'demo';

    if (!canTrack) {
      _stopDriverLocationListener();
      return;
    }

    if (_subscribedDriverId == driverId && _subscribedRideId == rideId) {
      return;
    }
    _stopDriverLocationListener();
    _subscribedDriverId = driverId;
    _subscribedRideId = rideId;

    unawaited(_ensureFirebaseReady().then((ready) {
      if (!ready ||
          !mounted ||
          _subscribedDriverId != driverId ||
          _subscribedRideId != rideId) {
        return;
      }
      _driverLocationSubscription = FirebaseFirestore.instance
          .collection('driverLocations')
          .doc(driverId)
          .snapshots()
          .listen((snapshot) {
        if (!mounted || !snapshot.exists) return;
        final data = snapshot.data();
        if (data == null ||
            data['rideId'] != rideId ||
            data['driverId'] != driverId) {
          return;
        }
        final latitude = (data['latitude'] as num?)?.toDouble();
        final longitude = (data['longitude'] as num?)?.toDouble();
        if (latitude == null || longitude == null) {
          return;
        }
        final updatedAt = _timestampToIso(data['updatedAt']) ??
            _timestampToIso(data['serverUpdatedAt']);
        setState(() {
          final current = _ride;
          if (current == null || current['id'] != rideId) {
            return;
          }
          final previous = current['driverLocation'] is Map
              ? Map<String, dynamic>.from(current['driverLocation'] as Map)
              : null;
          _ride = {
            ...current,
            'driverLocation': _smoothLocation(previous, latitude, longitude),
            'driverLocationUpdatedAt': updatedAt,
          };
        });
      }, onError: (_) {
        if (mounted) {
          setState(() => _message = 'تعذر استقبال موقع الكابتن المباشر حالياً');
        }
      });
    }));
  }

  Map<String, dynamic> _smoothLocation(
      Map<String, dynamic>? previous, double latitude, double longitude) {
    final previousLat = (previous?['latitude'] as num?)?.toDouble();
    final previousLng = (previous?['longitude'] as num?)?.toDouble();
    if (previousLat == null || previousLng == null) {
      return {
        'latitude': latitude,
        'longitude': longitude,
        'addressName': 'Live driver location'
      };
    }
    return {
      'latitude': previousLat + (latitude - previousLat) * 0.45,
      'longitude': previousLng + (longitude - previousLng) * 0.45,
      'addressName': 'Live driver location',
    };
  }

  String? _timestampToIso(Object? value) {
    if (value is Timestamp) return value.toDate().toLocal().toIso8601String();
    if (value is String) return value;
    return null;
  }

  void _stopDriverLocationListener() {
    _driverLocationSubscription?.cancel();
    _driverLocationSubscription = null;
    _subscribedDriverId = null;
    _subscribedRideId = null;
  }

  void _stopRideListener() {
    _rideSubscription?.cancel();
    _rideSubscription = null;
  }

  Future<void> _cancelRide() async {
    final ride = _ride;
    if (ride == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final updated = await ref.read(apiProvider).rideAction(
            ride['id'] as String,
            'cancel',
            reason: 'تم الإلغاء من تطبيق العميل',
          );
      if (mounted) {
        setState(() => _ride = updated);
        _syncRideListener(updated);
        _syncDriverLocationListener(updated);
      }
      unawaited(logAnalyticsEvent(role: 'CUSTOMER', name: 'ride_cancelled'));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _payForCompletedRide() async {
    final ride = _ride;
    if (ride == null) return;
    setState(() {
      _paymentBusy = true;
      _message = null;
    });
    try {
      final result = await ref.read(apiProvider).createRidePayment(
            rideId: ride['id'] as String,
            paymentMethod: ride['paymentMethod'] == 'DIGITAL_PROVIDER'
                ? 'digital_provider'
                : 'wallet',
          );
      final payment = result['payment'] is Map
          ? Map<String, dynamic>.from(result['payment'] as Map)
          : result;
      if (mounted) {
        setState(() {
          _ride = {
            ...ride,
            'paymentStatus': _paymentStatusFromBackend(payment['status'])
          };
          _message = _paymentMessage(payment['status']);
        });
      }
      unawaited(logAnalyticsEvent(
        role: 'CUSTOMER',
        name: 'payment_method_selected',
        parameters: {'method': ride['paymentMethod']?.toString() ?? 'unknown'},
      ));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _paymentBusy = false);
    }
  }

  Future<void> _requestRefundForRide() async {
    final ride = _ride;
    if (ride == null) return;
    setState(() {
      _refundBusy = true;
      _message = null;
    });
    try {
      final payment =
          await ref.read(apiProvider).ridePayment(ride['id'] as String);
      final paymentId = payment?['id']?.toString();
      if (paymentId == null) {
        throw StateError('لا توجد عملية دفع قابلة للاسترجاع لهذا المشوار');
      }
      final refund = await ref.read(apiProvider).requestPaymentRefund(
            paymentId: paymentId,
            reason: 'service_issue',
          );
      if (mounted) {
        setState(
            () => _message = 'تم إرسال طلب الاسترجاع: ${refund['status']}');
      }
      unawaited(logAnalyticsEvent(role: 'CUSTOMER', name: 'refund_requested'));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _refundBusy = false);
    }
  }

  Future<void> _confirmAndSendSos(Map<String, dynamic> ride) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('تنبيه السلامة'),
        content: const Text(
            'سيتم إرسال تنبيه سلامة عاجل إلى فريق عمليات مشوار مع سياق الرحلة. لا يوجد ربط مباشر بالشرطة أو الإسعاف.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('إلغاء')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('إرسال SOS')),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _safetyBusy = true;
      _message = null;
    });
    try {
      final response = await ref.read(apiProvider).triggerRideSos(
            rideId: ride['id'] as String,
            role: 'CUSTOMER',
            description: 'SOS from customer Flutter app',
          );
      final incidentId = response['incidentId']?.toString();
      if (mounted) {
        setState(() => _message = incidentId == null
            ? 'تم إرسال تنبيه السلامة لفريق عمليات مشوار.'
            : 'تم إرسال تنبيه السلامة. رقم البلاغ: $incidentId');
      }
      unawaited(logAnalyticsEvent(role: 'CUSTOMER', name: 'sos_pressed'));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _safetyBusy = false);
    }
  }

  String _paymentStatusFromBackend(Object? status) =>
      switch (status?.toString().toLowerCase()) {
        'paid' => 'PAID',
        'processing' => 'PROCESSING',
        'authorized' => 'AUTHORIZED',
        'failed' => 'FAILED',
        'cancelled' => 'CANCELLED',
        _ => 'PENDING',
      };

  String _paymentMessage(Object? status) =>
      switch (status?.toString().toLowerCase()) {
        'paid' => 'تم تأكيد الدفع بنجاح',
        'processing' => 'الدفع قيد المعالجة لدى المزود',
        'authorized' => 'تم تفويض الدفع وبانتظار التأكيد',
        'failed' => 'فشلت عملية الدفع',
        _ => 'تم إنشاء عملية الدفع',
      };

  String _paymentStatusLabel(Object? status) => switch (status?.toString()) {
        'PAID' => 'مدفوع',
        'PROCESSING' => 'قيد المعالجة',
        'AUTHORIZED' => 'مفوّض',
        'FAILED' => 'فشل',
        'CANCELLED' => 'ملغي',
        _ => 'بانتظار الدفع',
      };

  String _paymentMethodLabel(Object? method) => switch (method?.toString()) {
        'WALLET' => 'المحفظة',
        'DIGITAL_PROVIDER' => 'إلكتروني',
        _ => 'نقداً',
      };

  Future<void> _createQuickSupportTicket(
      {String category = 'technical'}) async {
    setState(() => _message = null);
    try {
      await ref.read(apiProvider).createSupportTicket(
            role: 'CUSTOMER',
            category: category,
            subject: category == 'account_review'
                ? 'Account review request'
                : 'Customer support request',
            message: category == 'account_review'
                ? 'Please review my account status.'
                : 'I need help from support.',
            rideId: _ride?['id']?.toString(),
          );
      if (mounted) {
        setState(() => _message = 'تم إرسال طلب الدعم للمراجعة.');
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    }
  }

  Future<void> _createPrivacyRequest(String type) async {
    setState(() => _message = null);
    try {
      await ref.read(apiProvider).createPrivacyRequest(
            role: 'CUSTOMER',
            type: type,
            message: type == 'account_deletion'
                ? 'Please review my account deletion request.'
                : 'Please review my account data request.',
          );
      if (mounted) {
        setState(() => _message = 'تم تسجيل الطلب وسيتم مراجعته يدويا.');
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    }
  }

  Future<void> _showAboutAndLegal() async {
    try {
      final config = await ref.read(apiProvider).publicConfig();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('مشوار'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('API: $mishwarApiBaseUrl'),
              if (mishwarAppMode.toLowerCase() != 'production')
                const Text('Mode: $mishwarAppMode'),
              Text(
                  'Privacy: ${config['privacyPolicyUrl'] ?? 'not configured'}'),
              Text('Terms: ${config['termsUrl'] ?? 'not configured'}'),
              Text(
                  'Support: ${config['supportUrl'] ?? config['supportEmail'] ?? 'not configured'}'),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('إغلاق')),
          ],
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    }
  }

  Future<void> _rateCompletedRide(Map<String, dynamic> ride, int stars) async {
    setState(() => _message = null);
    try {
      await ref.read(apiProvider).submitRideRating(
        rideId: ride['id'] as String,
        stars: stars,
        reasons: const ['behavior', 'navigation'],
      );
      if (mounted) setState(() => _message = 'شكرا، تم حفظ تقييم الرحلة.');
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    final health = ref.watch(healthProvider);
    final isActiveRide =
        _ride != null && !_terminalStatuses.contains(_ride!['status']);
    final page = switch (_tabIndex) {
      1 => _tripsAndReceiptsPage(),
      2 => _profileAndSettingsPage(health),
      _ => _homeRidePage(isActiveRide),
    };

    return Scaffold(
      appBar: AppBar(
        title: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _MishwarMark(size: 32),
            SizedBox(width: 10),
            Text('مشوار'),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'تحديث الحالة',
            onPressed: _refreshRide,
            icon: const Icon(Icons.refresh_rounded),
          ),
          IconButton(
            tooltip: 'Support',
            onPressed: () => _createQuickSupportTicket(),
            icon: const Icon(Icons.support_agent_outlined),
          ),
          IconButton(
            tooltip: 'About',
            onPressed: _showAboutAndLegal,
            icon: const Icon(Icons.info_outline),
          ),
          IconButton(
            tooltip: 'تسجيل الخروج',
            onPressed: _busy ? null : _signOut,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Container(
        decoration: const BoxDecoration(gradient: MishwarBrand.gradient),
        child: SafeArea(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 260),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            child: page,
          ),
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (index) => setState(() => _tabIndex = index),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.map_outlined),
              selectedIcon: Icon(Icons.map),
              label: 'الرئيسية'),
          NavigationDestination(
              icon: Icon(Icons.receipt_long_outlined),
              selectedIcon: Icon(Icons.receipt_long),
              label: 'الرحلات'),
          NavigationDestination(
              icon: Icon(Icons.person_outline),
              selectedIcon: Icon(Icons.person),
              label: 'حسابي'),
        ],
      ),
    );
  }

  Widget _homeRidePage(bool isActiveRide) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 760;
        final map = _heroMapPanel(isActiveRide);
        final content = ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _startCard(isActiveRide),
            const SizedBox(height: 16),
            OfflineSyncCard(api: ref.read(apiProvider)),
            if (_message != null) ...[
              const SizedBox(height: 12),
              _MessageBanner(message: _message!),
            ],
            const SizedBox(height: 16),
            if (isActiveRide) _activeRideCard(_ride!) else _bookingCard(),
          ],
        );
        if (!wide) {
          return ListView(
            key: const ValueKey('home-mobile'),
            padding: EdgeInsets.zero,
            children: [
              SizedBox(height: 330, child: map),
              SizedBox(
                  height: constraints.maxHeight - 330 > 360
                      ? constraints.maxHeight - 330
                      : 360,
                  child: content),
            ],
          );
        }
        return Row(
          key: const ValueKey('home-wide'),
          children: [
            Expanded(flex: 5, child: map),
            Expanded(flex: 4, child: content),
          ],
        );
      },
    );
  }

  Widget _heroMapPanel(bool isActiveRide) {
    if (!widget.routingEnabled) {
      return const _StaticMapPlaceholder();
    }
    final ride = _ride;
    final pickup = ride?['pickup'] is Map
        ? Map<String, dynamic>.from(ride!['pickup'] as Map)
        : null;
    final destination = ride?['destination'] is Map
        ? Map<String, dynamic>.from(ride!['destination'] as Map)
        : null;
    final driverLocation = ride?['driverLocation'] is Map
        ? Map<String, dynamic>.from(ride!['driverLocation'] as Map)
        : null;
    final routePolyline = ride == null
        ? (_routePreview?.polyline ?? const <GeoPointModel>[])
        : _routePolylineFromRide(ride);

    return Stack(
      children: [
        Positioned.fill(
          child: MishwarMap(
            centerLatitude:
                isActiveRide && pickup != null && destination != null
                    ? ((pickup['latitude'] as num).toDouble() +
                            (destination['latitude'] as num).toDouble()) /
                        2
                    : (_pickupLatitude + _destinationLatitude) / 2,
            centerLongitude:
                isActiveRide && pickup != null && destination != null
                    ? ((pickup['longitude'] as num).toDouble() +
                            (destination['longitude'] as num).toDouble()) /
                        2
                    : (_pickupLongitude + _destinationLongitude) / 2,
            pickupLatitude: pickup == null
                ? _pickupLatitude
                : (pickup['latitude'] as num).toDouble(),
            pickupLongitude: pickup == null
                ? _pickupLongitude
                : (pickup['longitude'] as num).toDouble(),
            destinationLatitude: destination == null
                ? _destinationLatitude
                : (destination['latitude'] as num).toDouble(),
            destinationLongitude: destination == null
                ? _destinationLongitude
                : (destination['longitude'] as num).toDouble(),
            driverLatitude: (driverLocation?['latitude'] as num?)?.toDouble(),
            driverLongitude: (driverLocation?['longitude'] as num?)?.toDouble(),
            routePolyline: routePolyline,
            onMapTap: isActiveRide ? null : _selectMapLocation,
            routingEnabled: widget.routingEnabled,
            followTarget: driverLocation != null,
          ),
        ),
        Positioned(
          left: 16,
          right: 16,
          top: 16,
          child: _MapStatusPill(
            title: isActiveRide
                ? _rideStatusLabel(ride?['status'] as String? ?? '')
                : 'حدد موقعك ووجهتك',
            subtitle: isActiveRide
                ? 'تابع الكابتن وحالة الرحلة مباشرة'
                : 'اضغط على الخريطة أو ابحث عن موقع يدويًا',
            icon: isActiveRide
                ? Icons.near_me_outlined
                : Icons.touch_app_outlined,
          ),
        ),
      ],
    );
  }

  Widget _startCard(bool isActiveRide) {
    final status = _ride?['status'] as String?;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Row(
              children: [
                _MishwarMark(size: 56),
                SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('مشوار',
                          style: TextStyle(
                              fontSize: 28, fontWeight: FontWeight.w900)),
                      Text('رحلتك تبدأ من الخريطة',
                          style: TextStyle(color: Colors.white70)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _StatusChip(
                    icon: Icons.flash_on_outlined,
                    label: _bookingMode == 'FAST'
                        ? 'مشوار سريع'
                        : 'مشوار بالعروض'),
                _StatusChip(
                    icon: Icons.directions_car_outlined,
                    label: _vehicleOptions[_vehicleType] ?? _vehicleType),
                _StatusChip(
                    icon: Icons.people_outline, label: '$_passengerCount ركاب'),
              ],
            ),
            if (status == 'SEARCHING_DRIVER') ...[
              const SizedBox(height: 16),
              const _WaitingCaptainIndicator(),
            ] else if (status == 'NO_DRIVER_FOUND' ||
                status == 'NO_DRIVER_AVAILABLE') ...[
              const SizedBox(height: 16),
              _EmptyState(
                icon: Icons.person_search_outlined,
                title: 'لا يوجد كباتن متاحون',
                message: 'جرّب تغيير نوع المركبة أو أعد الطلب بعد قليل.',
                action: OutlinedButton.icon(
                  onPressed: _busy ? null : _requestRide,
                  icon: const Icon(Icons.refresh),
                  label: const Text('إعادة المحاولة'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _tripsAndReceiptsPage() {
    final ride = _ride;
    return ListView(
      key: const ValueKey('trips'),
      padding: const EdgeInsets.all(16),
      children: [
        Text('سجل الرحلات والفواتير',
            style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 12),
        if (ride == null)
          const _EmptyState(
            icon: Icons.receipt_long_outlined,
            title: 'لا توجد رحلات بعد',
            message: 'ستظهر هنا الرحلات والفواتير بعد أول طلب.',
          )
        else ...[
          _ReceiptCard(ride: ride),
          const SizedBox(height: 16),
          _RatingAndComplaintCard(
            ride: ride,
            onRate: (stars) => _rateCompletedRide(ride, stars),
            onComplaint: () => _createQuickSupportTicket(category: 'technical'),
          ),
        ],
      ],
    );
  }

  Widget _profileAndSettingsPage(AsyncValue<Map<String, dynamic>> health) {
    return ListView(
      key: const ValueKey('profile'),
      padding: const EdgeInsets.all(16),
      children: [
        const MishwarBrandHeader(subtitle: 'حساب العميل والإعدادات'),
        const SizedBox(height: 16),
        _HealthCard(health: health),
        const SizedBox(height: 16),
        _LaunchReadinessCard(
          onSupport: () => _createQuickSupportTicket(),
          onAccountReview: () =>
              _createQuickSupportTicket(category: 'account_review'),
          onDeleteAccount: () => _createPrivacyRequest('account_deletion'),
          onDataAccess: () => _createPrivacyRequest('data_access'),
        ),
        if (mishwarAppMode.toLowerCase() != 'demo') ...[
          const SizedBox(height: 16),
          _PassengerOnboardingCard(api: ref.read(apiProvider)),
        ],
        const SizedBox(height: 16),
        const ProductionTasksCard(
          audience: ProductionTaskAudience.customer,
          title: 'مهام تطبيق العميل',
        ),
      ],
    );
  }

  Widget _bookingCard() {
    final previousStatus = _ride?['status'] as String?;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('احجز مشوارك', style: Theme.of(context).textTheme.titleLarge),
            if (previousStatus != null) ...[
              const SizedBox(height: 8),
              Text(_rideStatusLabel(previousStatus),
                  style: const TextStyle(color: Colors.white70)),
            ],
            if (previousStatus == 'TRIP_COMPLETED' && _ride != null) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () => _rateCompletedRide(_ride!, 5),
                icon: const Icon(Icons.star_rate_outlined),
                label: const Text('Rate ride'),
              ),
            ],
            const SizedBox(height: 18),
            TextField(
              controller: _pickupController,
              textDirection: TextDirection.rtl,
              onTap: () => setState(() => _mapSelection = 'pickup'),
              onChanged: _searchPlaces,
              decoration: const InputDecoration(
                labelText: 'موقع الانطلاق',
                prefixIcon: Icon(Icons.trip_origin),
                suffixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _destinationController,
              textDirection: TextDirection.rtl,
              onTap: () => setState(() => _mapSelection = 'destination'),
              onChanged: _searchPlaces,
              decoration: const InputDecoration(
                labelText: 'الوجهة',
                prefixIcon: Icon(Icons.location_on_outlined),
                suffixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
              ),
            ),
            if (_placeResults.isNotEmpty) ...[
              const SizedBox(height: 8),
              ..._placeResults.take(4).map((place) => ListTile(
                    dense: true,
                    leading: const Icon(Icons.place_outlined),
                    title: Text(place.name),
                    subtitle: Text(place.address),
                    trailing: place.distanceMeters == null
                        ? null
                        : Text(formatDistance(place.distanceMeters!)),
                    onTap: () => _selectPlace(place),
                  )),
            ],
            const SizedBox(height: 16),
            Align(
              alignment: Alignment.centerRight,
              child: Text('اختر نقطة على الخريطة',
                  style: Theme.of(context).textTheme.titleSmall),
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(
                    value: 'pickup',
                    label: Text('الانطلاق'),
                    icon: Icon(Icons.trip_origin)),
                ButtonSegment(
                    value: 'destination',
                    label: Text('الوجهة'),
                    icon: Icon(Icons.location_on_outlined)),
              ],
              selected: {_mapSelection},
              onSelectionChanged: (selection) =>
                  setState(() => _mapSelection = selection.first),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _busy || _locatingCurrentPosition
                  ? null
                  : _useCurrentLocation,
              icon: _locatingCurrentPosition
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.my_location),
              label: Text(_locatingCurrentPosition
                  ? 'جارٍ تحديد الموقع...'
                  : 'استخدم موقعي الحالي'),
            ),
            const SizedBox(height: 8),
            _GpsStatusBanner(state: _locationUiState),
            const SizedBox(height: 10),
            SizedBox(
              height: 230,
              child: widget.routingEnabled
                  ? MishwarMap(
                      centerLatitude:
                          (_pickupLatitude + _destinationLatitude) / 2,
                      centerLongitude:
                          (_pickupLongitude + _destinationLongitude) / 2,
                      pickupLatitude: _pickupLatitude,
                      pickupLongitude: _pickupLongitude,
                      destinationLatitude: _destinationLatitude,
                      destinationLongitude: _destinationLongitude,
                      routePolyline: _routePreview?.polyline ?? const [],
                      onMapTap: _selectMapLocation,
                      routingEnabled: widget.routingEnabled,
                    )
                  : const _StaticMapPlaceholder(),
            ),
            if (_routePreview != null) ...[
              const SizedBox(height: 8),
              _RideDetail(
                label: 'المسار التقريبي',
                value:
                    '${formatDistance(_routePreview!.distanceMeters)} · ${formatDuration(_routePreview!.durationSeconds)}',
              ),
            ],
            const SizedBox(height: 12),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(
                    value: 'FAST',
                    label: Text('مشوار سريع'),
                    icon: Icon(Icons.flash_on_outlined)),
                ButtonSegment(
                    value: 'BIDDING',
                    label: Text('مشوار بالعروض'),
                    icon: Icon(Icons.local_offer_outlined)),
              ],
              selected: {_bookingMode},
              onSelectionChanged: _busy
                  ? null
                  : (selection) =>
                      setState(() => _bookingMode = selection.first),
            ),
            const SizedBox(height: 8),
            _BookingModeHint(
              mode: _bookingMode,
              estimatedFare: _routePreview == null
                  ? null
                  : 'المسار ${formatDistance(_routePreview!.distanceMeters)} · ${formatDuration(_routePreview!.durationSeconds)}',
            ),
            if (_bookingMode == 'BIDDING') ...[
              const SizedBox(height: 12),
              TextField(
                controller: _proposedFareController,
                keyboardType: TextInputType.number,
                textDirection: TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'السعر المقترح',
                  prefixIcon: Icon(Icons.price_change_outlined),
                  suffixText: 'ر.ي',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'سيعرض الكباتن أسعارهم ووقت الوصول، ثم تختار عرضاً واحداً فقط.',
                textAlign: TextAlign.center,
              ),
            ],
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _vehicleType,
              isExpanded: true,
              decoration: const InputDecoration(
                  labelText: 'نوع المركبة', border: OutlineInputBorder()),
              items: _vehicleOptions.entries
                  .map((entry) => DropdownMenuItem(
                      value: entry.key, child: Text(entry.value)))
                  .toList(),
              onChanged: _busy
                  ? null
                  : (value) => setState(() {
                        _vehicleType = value ?? 'ECONOMY';
                        if (_vehicleType == 'MOTORCYCLE') {
                          _passengerCount = 1;
                          _airConditioningRequired = false;
                        }
                      }),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(
              initialValue: _passengerCount,
              isExpanded: true,
              decoration: const InputDecoration(
                  labelText: 'عدد الركاب', border: OutlineInputBorder()),
              items: List.generate(_vehicleType == 'MOTORCYCLE' ? 1 : 4,
                      (index) => index + 1)
                  .map((passengerCountOption) => DropdownMenuItem(
                      value: passengerCountOption,
                      child: Text('$passengerCountOption')))
                  .toList(),
              onChanged: _busy
                  ? null
                  : (value) => setState(() => _passengerCount = value ?? 1),
            ),
            if (_vehicleType != 'MOTORCYCLE')
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('أحتاج إلى مكيف'),
                value: _airConditioningRequired,
                onChanged: _busy
                    ? null
                    : (value) =>
                        setState(() => _airConditioningRequired = value),
              ),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(
                    value: 'CASH',
                    label: Text('نقداً'),
                    icon: Icon(Icons.payments_outlined)),
                ButtonSegment(
                    value: 'WALLET',
                    label: Text('المحفظة'),
                    icon: Icon(Icons.account_balance_wallet_outlined)),
                if (mishwarEnableDigitalPayment)
                  ButtonSegment(
                      value: 'DIGITAL_PROVIDER',
                      label: Text('إلكتروني'),
                      icon: Icon(Icons.credit_card)),
              ],
              selected: {_paymentMethod},
              onSelectionChanged: _busy
                  ? null
                  : (selection) =>
                      setState(() => _paymentMethod = selection.first),
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: _busy ? null : _requestRide,
              icon: _busy
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.local_taxi),
              label: Text(_busy ? 'جارٍ إرسال الطلب...' : 'اطلب مشواراً'),
              style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _activeRideCard(Map<String, dynamic> ride) {
    final status = ride['status'] as String? ?? '';
    final fare = ride['fare'] is Map
        ? Map<String, dynamic>.from(ride['fare'] as Map)
        : <String, dynamic>{};
    final pickup = Map<String, dynamic>.from(ride['pickup'] as Map);
    final destination = Map<String, dynamic>.from(ride['destination'] as Map);
    final driverLocation = ride['driverLocation'] is Map
        ? Map<String, dynamic>.from(ride['driverLocation'] as Map)
        : null;
    final driverFreshness =
        liveLocationStatus(ride['driverLocationUpdatedAt'] as String?);
    final showDriverLocation = driverLocation != null &&
        driverFreshness.freshness != LiveLocationFreshness.offline;
    final progress = switch (status) {
      'SEARCHING_DRIVER' => 0.2,
      'DRIVER_ASSIGNED' || 'DRIVER_ARRIVING' || 'DRIVER_ON_THE_WAY' => 0.4,
      'DRIVER_ARRIVED' => 0.6,
      'TRIP_STARTED' => 0.8,
      _ => 1.0,
    };

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.directions_car, color: Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(
                    child: Text(_rideStatusLabel(status),
                        style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            if (ride['bookingMode'] == 'BIDDING' &&
                ride['biddingStatus'] == 'OPEN') ...[
              _BiddingSummaryCard(
                proposedFare: ride['customerProposedFare'],
                estimatedFare: ride['serverEstimatedFare'] ?? fare['grossFare'],
                expiresAt: ride['biddingExpiresAt'],
                bidsCount: _bids.length,
                onRefresh:
                    _busy ? null : () => _refreshBids(ride['id'] as String),
              ),
              const SizedBox(height: 10),
              if (_bids.isEmpty)
                _BiddingEmptyState(
                  expired: _remainingTimeLabel(ride['biddingExpiresAt']) ==
                      'انتهت المهلة',
                  onRefresh:
                      _busy ? null : () => _refreshBids(ride['id'] as String),
                  onCancel: _busy ? null : _cancelRide,
                )
              else
                ..._bids.asMap().entries.map(
                      (entry) => _BidOfferCard(
                        bid: entry.value,
                        rank: entry.key + 1,
                        busy: _busy,
                        onSelect: () => _selectBid(entry.value),
                      ),
                    ),
            ],
            const SizedBox(height: 14),
            LinearProgressIndicator(value: progress, minHeight: 5),
            if (ride['driverId'] != null) ...[
              const SizedBox(height: 12),
              _DriverLocationStatus(updatedAt: ride['driverLocationUpdatedAt']),
            ],
            const SizedBox(height: 14),
            SizedBox(
              height: 220,
              child: MishwarMap(
                centerLatitude: ((pickup['latitude'] as num).toDouble() +
                        (destination['latitude'] as num).toDouble()) /
                    2,
                centerLongitude: ((pickup['longitude'] as num).toDouble() +
                        (destination['longitude'] as num).toDouble()) /
                    2,
                pickupLatitude: (pickup['latitude'] as num).toDouble(),
                pickupLongitude: (pickup['longitude'] as num).toDouble(),
                destinationLatitude:
                    (destination['latitude'] as num).toDouble(),
                destinationLongitude:
                    (destination['longitude'] as num).toDouble(),
                driverLatitude: showDriverLocation
                    ? (driverLocation['latitude'] as num?)?.toDouble()
                    : null,
                driverLongitude: showDriverLocation
                    ? (driverLocation['longitude'] as num?)?.toDouble()
                    : null,
                routePolyline: _routePolylineFromRide(ride),
                routingEnabled: widget.routingEnabled,
                followTarget: showDriverLocation,
              ),
            ),
            const SizedBox(height: 18),
            _RideDetail(
                label: 'من',
                value: ride['pickup']?['addressName']?.toString() ??
                    _pickupController.text),
            _RideDetail(
                label: 'إلى',
                value: ride['destination']?['addressName']?.toString() ??
                    _destinationController.text),
            _RideDetail(
                label: 'المركبة',
                value: _vehicleOptions[ride['vehicleType']] ??
                    ride['vehicleType'].toString()),
            _RideDetail(
                label: 'الدفع',
                value: _paymentMethodLabel(ride['paymentMethod'])),
            _RideDetail(
                label: 'حالة الدفع',
                value: _paymentStatusLabel(ride['paymentStatus'])),
            if (ride['driverName'] != null)
              _RideDetail(
                  label: 'الكابتن', value: ride['driverName'].toString()),
            if (fare['grossFare'] != null)
              _RideDetail(
                  label: 'الأجرة التقديرية', value: '${fare['grossFare']} ر.ي'),
            const SizedBox(height: 14),
            if (status != 'TRIP_COMPLETED') ...[
              FilledButton.icon(
                onPressed: _safetyBusy ? null : () => _confirmAndSendSos(ride),
                icon: _safetyBusy
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.health_and_safety_outlined),
                label: const Text('السلامة / SOS'),
                style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFFDC2626)),
              ),
              const SizedBox(height: 8),
            ],
            if (status == 'TRIP_COMPLETED' &&
                ride['paymentStatus'] != 'PAID' &&
                (ride['paymentMethod'] == 'WALLET' ||
                    ride['paymentMethod'] == 'DIGITAL_PROVIDER'))
              FilledButton.icon(
                onPressed: _paymentBusy ? null : _payForCompletedRide,
                icon: _paymentBusy
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.lock_outline),
                label: Text(ride['paymentMethod'] == 'WALLET'
                    ? 'الدفع من المحفظة'
                    : 'بدء الدفع الإلكتروني'),
              ),
            if (status == 'TRIP_COMPLETED' &&
                ride['paymentMethod'] == 'CASH' &&
                ride['paymentStatus'] != 'PAID')
              const Text('بانتظار تأكيد الكابتن لاستلام المبلغ نقداً',
                  textAlign: TextAlign.center),
            if (status == 'TRIP_COMPLETED' &&
                ride['paymentStatus'] == 'PAID') ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: _refundBusy ? null : _requestRefundForRide,
                icon: _refundBusy
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.undo_outlined),
                label: const Text('طلب استرجاع'),
              ),
            ],
            if (status == 'TRIP_COMPLETED') const SizedBox(height: 8),
            if (status != 'TRIP_COMPLETED')
              OutlinedButton.icon(
                onPressed: _busy ? null : _cancelRide,
                icon: const Icon(Icons.close),
                label: const Text('إلغاء المشوار'),
              ),
            if (status == 'TRIP_COMPLETED')
              const Text('شكراً لاختيارك مشوار', textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

class _BookingModeHint extends StatelessWidget {
  const _BookingModeHint({required this.mode, this.estimatedFare});

  final String mode;
  final String? estimatedFare;

  @override
  Widget build(BuildContext context) {
    final isBidding = mode == 'BIDDING';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(isBidding ? Icons.local_offer_outlined : Icons.flash_on_outlined,
              color: const Color(0xFF10B981)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isBidding
                      ? 'مشوار بالعروض: اقترح سعرك، ثم اختر عرض كابتن واحداً بعد وصول العروض.'
                      : 'مشوار سريع: السعر والتوزيع يتمان تلقائياً من الخادم.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                if (estimatedFare != null) ...[
                  const SizedBox(height: 4),
                  Text(estimatedFare!,
                      style: Theme.of(context).textTheme.labelSmall),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _GpsStatusBanner extends StatelessWidget {
  const _GpsStatusBanner({required this.state});

  final MishwarLocationUiState state;

  @override
  Widget build(BuildContext context) {
    final isProblem = state == MishwarLocationUiState.permissionDenied ||
        state == MishwarLocationUiState.permissionDeniedForever ||
        state == MishwarLocationUiState.serviceDisabled ||
        state == MishwarLocationUiState.failed;
    final isBusy = state == MishwarLocationUiState.waitingForGps;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: (isProblem ? const Color(0xFFF59E0B) : const Color(0xFF10B981))
            .withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: (isProblem ? const Color(0xFFF59E0B) : const Color(0xFF10B981))
              .withValues(alpha: 0.24),
        ),
      ),
      child: Row(
        children: [
          if (isBusy)
            const SizedBox.square(
                dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
          else
            Icon(
              isProblem ? Icons.location_off_outlined : Icons.gps_fixed,
              color:
                  isProblem ? const Color(0xFFF59E0B) : const Color(0xFF10B981),
              size: 18,
            ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              locationUiMessage(state),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

class _BiddingSummaryCard extends StatelessWidget {
  const _BiddingSummaryCard({
    required this.proposedFare,
    required this.estimatedFare,
    required this.expiresAt,
    required this.bidsCount,
    required this.onRefresh,
  });

  final Object? proposedFare;
  final Object? estimatedFare;
  final Object? expiresAt;
  final int bidsCount;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    final remaining = _remainingTimeLabel(expiresAt);
    final expired = remaining == 'انتهت المهلة';
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF10B981).withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border:
            Border.all(color: const Color(0xFF10B981).withValues(alpha: 0.30)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(expired ? Icons.timer_off_outlined : Icons.timer_outlined,
                  color: expired
                      ? const Color(0xFFF59E0B)
                      : const Color(0xFF10B981)),
              const SizedBox(width: 10),
              Expanded(
                  child: Text(
                      expired
                          ? 'انتهت مهلة استقبال العروض'
                          : 'استقبال عروض الكباتن',
                      style: Theme.of(context).textTheme.titleSmall)),
              IconButton(
                tooltip: 'تحديث العروض',
                onPressed: onRefresh,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _BidMetric(label: 'سعرك', value: _money(proposedFare)),
              _BidMetric(label: 'استرشادي', value: _money(estimatedFare)),
              _BidMetric(label: 'العروض', value: '$bidsCount'),
              _BidMetric(label: 'المهلة', value: remaining),
            ],
          ),
        ],
      ),
    );
  }
}

class _BiddingEmptyState extends StatelessWidget {
  const _BiddingEmptyState({
    required this.expired,
    required this.onRefresh,
    required this.onCancel,
  });

  final bool expired;
  final VoidCallback? onRefresh;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.06),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
            ),
            child: Column(
              children: [
                Icon(
                  expired ? Icons.timer_off_outlined : Icons.hourglass_empty,
                  color: const Color(0xFF10B981),
                  size: 34,
                ),
                const SizedBox(height: 10),
                Text(
                  expired ? 'لم تصل عروض ضمن المهلة' : 'بانتظار عروض الكباتن',
                  style: Theme.of(context).textTheme.titleSmall,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 6),
                Text(
                  expired
                      ? 'يمكنك تحديث العروض أو إلغاء الطلب وتجربة سعر آخر.'
                      : 'سنحدّث القائمة عند عودة الاتصال أو وصول عرض جديد.',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.center,
            children: [
              OutlinedButton.icon(
                  onPressed: onRefresh,
                  icon: const Icon(Icons.refresh),
                  label: const Text('تحديث')),
              TextButton.icon(
                  onPressed: onCancel,
                  icon: const Icon(Icons.close),
                  label: const Text('إلغاء الطلب')),
            ],
          ),
        ],
      ),
    );
  }
}

class _BidOfferCard extends StatelessWidget {
  const _BidOfferCard({
    required this.bid,
    required this.rank,
    required this.busy,
    required this.onSelect,
  });

  final Map<String, dynamic> bid;
  final int rank;
  final bool busy;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final rating = _doubleValue(bid['driverRating'], fallback: 5);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    backgroundColor:
                        rank == 1 ? const Color(0xFF10B981) : Colors.white12,
                    child: Text('$rank',
                        style: const TextStyle(color: Colors.white)),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(bid['driverName']?.toString() ?? 'كابتن مشوار',
                            style: Theme.of(context).textTheme.titleSmall),
                        const SizedBox(height: 4),
                        Text(
                            'الوصول ${_intValue(bid['etaMinutes'], fallback: 8)} دقيقة · تقييم ${rating.toStringAsFixed(1)}',
                            style: Theme.of(context).textTheme.bodySmall),
                      ],
                    ),
                  ),
                  Text(_money(bid['amount']),
                      style: Theme.of(context).textTheme.titleMedium),
                ],
              ),
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: busy ? null : onSelect,
                icon: const Icon(Icons.check_circle_outline),
                label: const Text('اختيار هذا العرض'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BidMetric extends StatelessWidget {
  const _BidMetric({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text('$label: $value'),
      side: BorderSide(color: Colors.white.withValues(alpha: 0.12)),
    );
  }
}

class _MishwarMark extends StatelessWidget {
  const _MishwarMark({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        gradient:
            LinearGradient(colors: [MishwarBrand.primary, MishwarBrand.accent]),
      ),
      child: Icon(Icons.route_rounded, color: Colors.white, size: size * 0.52),
    );
  }
}

class _MapStatusPill extends StatelessWidget {
  const _MapStatusPill({
    required this.title,
    required this.subtitle,
    required this.icon,
  });

  final String title;
  final String subtitle;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: MishwarBrand.background.withValues(alpha: 0.88),
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Icon(icon, color: MishwarBrand.accent),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: const TextStyle(fontWeight: FontWeight.w800)),
                  const SizedBox(height: 2),
                  Text(subtitle,
                      style:
                          const TextStyle(color: Colors.white70, fontSize: 12)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StaticMapPlaceholder extends StatelessWidget {
  const _StaticMapPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: MishwarBrand.panel,
      child: Stack(
        children: [
          Positioned.fill(
            child: CustomPaint(painter: _MapGridPainter()),
          ),
          const Center(
            child: _MapStatusPill(
              title: 'خريطة مشوار',
              subtitle: 'معاينة ثابتة للاختبارات المحلية',
              icon: Icons.map_outlined,
            ),
          ),
        ],
      ),
    );
  }
}

class _MapGridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final linePaint = Paint()
      ..color = Colors.white.withValues(alpha: 0.05)
      ..strokeWidth = 1;
    for (var x = 0.0; x < size.width; x += 36) {
      canvas.drawLine(Offset(x, 0), Offset(x + 80, size.height), linePaint);
    }
    for (var y = 0.0; y < size.height; y += 34) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y + 24), linePaint);
    }
    final routePaint = Paint()
      ..color = MishwarBrand.primary
      ..strokeWidth = 5
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;
    final path = Path()
      ..moveTo(size.width * 0.18, size.height * 0.72)
      ..quadraticBezierTo(size.width * 0.52, size.height * 0.28,
          size.width * 0.82, size.height * 0.42);
    canvas.drawPath(path, routePaint);
    final pointPaint = Paint()..color = MishwarBrand.accent;
    canvas.drawCircle(
        Offset(size.width * 0.18, size.height * 0.72), 8, pointPaint);
    canvas.drawCircle(
        Offset(size.width * 0.82, size.height * 0.42), 8, pointPaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Chip(
      avatar: Icon(icon, size: 16, color: MishwarBrand.primary),
      label: Text(label),
      backgroundColor: MishwarBrand.primary.withValues(alpha: 0.12),
      side: BorderSide(color: Colors.white.withValues(alpha: 0.08)),
    );
  }
}

class _WaitingCaptainIndicator extends StatelessWidget {
  const _WaitingCaptainIndicator();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: MishwarBrand.surfaceAlt.withValues(alpha: 0.8),
        borderRadius: BorderRadius.circular(16),
      ),
      child: const Row(
        children: [
          SizedBox.square(
              dimension: 22,
              child: CircularProgressIndicator(strokeWidth: 2.4)),
          SizedBox(width: 12),
          Expanded(child: Text('نبحث عن أقرب كابتن مناسب لرحلتك')),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          children: [
            Icon(icon, size: 38, color: MishwarBrand.accent),
            const SizedBox(height: 10),
            Text(title,
                style: Theme.of(context).textTheme.titleMedium,
                textAlign: TextAlign.center),
            const SizedBox(height: 6),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70)),
            if (action != null) ...[
              const SizedBox(height: 12),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

class _ReceiptCard extends StatelessWidget {
  const _ReceiptCard({required this.ride});

  final Map<String, dynamic> ride;

  @override
  Widget build(BuildContext context) {
    final fare = ride['fare'] is Map
        ? Map<String, dynamic>.from(ride['fare'] as Map)
        : <String, dynamic>{};
    final pickup = ride['pickup'] is Map
        ? Map<String, dynamic>.from(ride['pickup'] as Map)
        : <String, dynamic>{};
    final destination = ride['destination'] is Map
        ? Map<String, dynamic>.from(ride['destination'] as Map)
        : <String, dynamic>{};
    final amount =
        ride['finalFare'] ?? fare['grossFare'] ?? ride['estimatedFare'] ?? '-';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.receipt_long_outlined,
                    color: MishwarBrand.primary),
                const SizedBox(width: 10),
                Expanded(
                    child: Text('فاتورة المشوار',
                        style: Theme.of(context).textTheme.titleMedium)),
                Text('$amount ر.ي',
                    style: const TextStyle(
                        fontWeight: FontWeight.w900,
                        color: MishwarBrand.accent)),
              ],
            ),
            const SizedBox(height: 12),
            _ReceiptLine(
                label: 'من', value: pickup['addressName']?.toString() ?? '-'),
            _ReceiptLine(
                label: 'إلى',
                value: destination['addressName']?.toString() ?? '-'),
            _ReceiptLine(
                label: 'الحالة',
                value: _rideStatusLabel(ride['status']?.toString() ?? '')),
            _ReceiptLine(
                label: 'الدفع',
                value: ride['paymentMethod']?.toString() ?? 'CASH'),
            if (ride['driverName'] != null)
              _ReceiptLine(
                  label: 'الكابتن', value: ride['driverName'].toString()),
          ],
        ),
      ),
    );
  }
}

class _ReceiptLine extends StatelessWidget {
  const _ReceiptLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        children: [
          SizedBox(
              width: 72,
              child:
                  Text(label, style: const TextStyle(color: Colors.white60))),
          Expanded(child: Text(value, textAlign: TextAlign.right)),
        ],
      ),
    );
  }
}

class _RatingAndComplaintCard extends StatelessWidget {
  const _RatingAndComplaintCard({
    required this.ride,
    required this.onRate,
    required this.onComplaint,
  });

  final Map<String, dynamic> ride;
  final ValueChanged<int> onRate;
  final VoidCallback onComplaint;

  @override
  Widget build(BuildContext context) {
    final completed = ride['status'] == 'TRIP_COMPLETED';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('التقييم والشكاوى',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(
                5,
                (index) => IconButton(
                  tooltip: '${index + 1}',
                  onPressed: completed ? () => onRate(index + 1) : null,
                  icon: const Icon(Icons.star_rate_rounded,
                      color: MishwarBrand.accent),
                ),
              ),
            ),
            OutlinedButton.icon(
              onPressed: onComplaint,
              icon: const Icon(Icons.report_problem_outlined),
              label: const Text('إرسال شكوى أو ملاحظة'),
            ),
          ],
        ),
      ),
    );
  }
}

class _LaunchReadinessCard extends StatelessWidget {
  const _LaunchReadinessCard({
    required this.onSupport,
    required this.onAccountReview,
    required this.onDeleteAccount,
    required this.onDataAccess,
  });

  final VoidCallback onSupport;
  final VoidCallback onAccountReview;
  final VoidCallback onDeleteAccount;
  final VoidCallback onDataAccess;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.privacy_tip_outlined,
                    color: Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(
                    child: Text('الدعم والخصوصية',
                        style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 8),
            const Text(
                'يمكنك طلب دعم، مراجعة حساب، حذف حساب، أو طلب بيانات. الحذف لا يتم فوريا وقد تتطلب بعض السجلات احتفاظا للمراجعة المالية أو السلامة.'),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                    onPressed: onSupport,
                    icon: const Icon(Icons.support_agent_outlined),
                    label: const Text('دعم')),
                OutlinedButton.icon(
                    onPressed: onAccountReview,
                    icon: const Icon(Icons.manage_accounts_outlined),
                    label: const Text('مراجعة الحساب')),
                OutlinedButton.icon(
                    onPressed: onDataAccess,
                    icon: const Icon(Icons.file_present_outlined),
                    label: const Text('طلب البيانات')),
                OutlinedButton.icon(
                    onPressed: onDeleteAccount,
                    icon: const Icon(Icons.delete_outline),
                    label: const Text('طلب حذف الحساب')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _PassengerOnboardingCard extends StatefulWidget {
  const _PassengerOnboardingCard({required this.api});

  final MishwarApi api;

  @override
  State<_PassengerOnboardingCard> createState() =>
      _PassengerOnboardingCardState();
}

class _PassengerOnboardingCardState extends State<_PassengerOnboardingCard> {
  bool _busy = false;
  bool _done = false;
  String? _message;

  Future<void> _complete() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await widget.api.completePassengerOnboarding();
      if (mounted) {
        setState(() {
          _done = true;
          _message = 'حساب العميل جاهز للعمل بالإنتاج';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(
                    _done
                        ? Icons.verified_user_outlined
                        : Icons.person_add_alt_1_outlined,
                    color: const Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(
                    child: Text('تجهيز حساب العميل',
                        style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 8),
            const Text(
                'يثبت دور CUSTOMER بعد تسجيل الدخول الحقيقي ويجهز الحساب للطلبات الإنتاجية.'),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _busy || _done ? null : _complete,
              icon: _busy
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.check_circle_outline),
              label: Text(_done ? 'مكتمل' : 'إكمال التجهيز'),
            ),
            if (_message != null) ...[
              const SizedBox(height: 8),
              Text(_message!, textAlign: TextAlign.right),
            ],
          ],
        ),
      ),
    );
  }
}

class _HealthCard extends StatelessWidget {
  const _HealthCard({required this.health});

  final AsyncValue<Map<String, dynamic>> health;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: health.when(
          loading: () => const Row(children: [
            CircularProgressIndicator(),
            SizedBox(width: 12),
            Text('جاري الاتصال بالخادم...')
          ]),
          error: (error, _) => const Text(
            'تعذر الاتصال بالخادم. تحقق من الإنترنت أو عنوان Backend.',
          ),
          data: (data) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('حالة الخادم',
                  style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text('${data['service']} - ${data['status']}'),
              Text('API: $mishwarApiBaseUrl',
                  style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
        ),
      ),
    );
  }
}

class _RideDetail extends StatelessWidget {
  const _RideDetail({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        children: [
          SizedBox(
              width: 74,
              child:
                  Text(label, style: const TextStyle(color: Colors.white60))),
          Expanded(child: Text(value, textAlign: TextAlign.right)),
        ],
      ),
    );
  }
}

class _DriverLocationStatus extends StatelessWidget {
  const _DriverLocationStatus({required this.updatedAt});

  final Object? updatedAt;

  @override
  Widget build(BuildContext context) {
    final isLive = updatedAt is String &&
        DateTime.now()
                .difference(DateTime.tryParse(updatedAt as String)?.toLocal() ??
                    DateTime(2000))
                .inSeconds <
            30;
    final color = isLive ? const Color(0xFF10B981) : Colors.amber;
    return Row(
      children: [
        Icon(isLive ? Icons.gps_fixed : Icons.location_searching,
            size: 18, color: color),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            _locationUpdateLabel(updatedAt),
            style: TextStyle(color: color, fontWeight: FontWeight.w600),
          ),
        ),
        if (isLive)
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
      ],
    );
  }
}

class _MessageBanner extends StatelessWidget {
  const _MessageBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Text(message, textDirection: TextDirection.rtl),
      ),
    );
  }
}
