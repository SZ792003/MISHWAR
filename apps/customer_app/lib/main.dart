import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:mishwar_shared/geo_hardening.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:mishwar_shared/mishwar_api.dart';
import 'package:mishwar_shared/mishwar_brand.dart';
import 'package:mishwar_shared/mobile_runtime.dart';
import 'package:mishwar_shared/osm_ride_map.dart';
import 'package:mishwar_shared/production_tasks.dart';

final apiProvider = Provider<MishwarApi>((ref) => MishwarApi(firebaseIdTokenProvider: firebaseIdToken));

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
      'DRIVER_ASSIGNED' || 'DRIVER_ARRIVING' || 'DRIVER_ON_THE_WAY' => 'الكابتن في الطريق إليك',
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
    final code = data is Map && data['error'] is Map ? data['error']['code'] : null;
    if (code == 'ACCOUNT_BLOCKED' || code == 'ACCOUNT_SUSPENDED') {
      return 'تم تقييد الحساب مؤقتاً، يرجى التواصل مع الدعم.';
    }
    if (data is Map && data['message'] is String) return data['message'] as String;
    return error.message ?? 'تعذر الاتصال بالخادم';
  }
  return 'تعذر تنفيذ الطلب. حاول مرة أخرى.';
}

String _locationUpdateLabel(Object? value) {
  return liveLocationStatus(value is String ? value : null).label;
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

class _CustomerHomeScreenState extends ConsumerState<CustomerHomeScreen> {
  final _pickupController = TextEditingController(text: 'ميدان التحرير');
  final _destinationController = TextEditingController(text: 'شارع حدة');
  double _pickupLatitude = 15.3694;
  double _pickupLongitude = 44.1910;
  double _destinationLatitude = 15.3470;
  double _destinationLongitude = 44.2060;
  String _mapSelection = 'pickup';
  Timer? _pollTimer;
  Timer? _searchDebounce;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _rideSubscription;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _driverLocationSubscription;
  String? _subscribedDriverId;
  String? _subscribedRideId;
  Map<String, dynamic>? _ride;
  RouteModel? _routePreview;
  List<PlaceModel> _placeResults = const [];
  String _vehicleType = 'ECONOMY';
  String _paymentMethod = 'CASH';
  int _passengerCount = 1;
  bool _airConditioningRequired = false;
  bool _busy = false;
  bool _paymentBusy = false;
  bool _refundBusy = false;
  bool _safetyBusy = false;
  bool _refreshing = false;
  String? _message;

  @override
  void initState() {
    super.initState();
    unawaited(registerMessagingToken(api: ref.read(apiProvider), role: 'CUSTOMER'));
    unawaited(ref.read(apiProvider).syncOfflineQueue());
    unawaited(_refreshRoutePreview());
    _refreshRide();
    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _refreshRide());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _searchDebounce?.cancel();
    _stopRideListener();
    _stopDriverLocationListener();
    _pickupController.dispose();
    _destinationController.dispose();
    super.dispose();
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
    } catch (error) {
      if (mounted && _ride == null) setState(() => _message = _errorMessage(error));
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _requestRide() async {
    if (_pickupController.text.trim().isEmpty || _destinationController.text.trim().isEmpty) {
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

  void _selectMapLocation(double latitude, double longitude) {
    setState(() {
      final coordinates = '${latitude.toStringAsFixed(5)}, ${longitude.toStringAsFixed(5)}';
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
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        setState(() => _message = 'فعّل خدمة الموقع على جهازك ثم حاول مجدداً.');
        return;
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.deniedForever) {
        setState(() => _message = 'إذن الموقع محظور. غيّره من إعدادات الجهاز ثم حاول مجدداً.');
        return;
      }
      if (permission == LocationPermission.denied) {
        setState(() => _message = 'لم يتم منح إذن الموقع. يمكنك اختيار النقطة يدوياً من الخريطة.');
        return;
      }
      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 12),
      );
      _selectMapLocation(position.latitude, position.longitude);
    } catch (_) {
      if (mounted) setState(() => _message = 'تعذر تحديد موقعك الحالي. يمكنك اختيار النقطة يدوياً.');
    }
  }

  Future<void> _reverseSelectedPoint(double latitude, double longitude) async {
    try {
      final place = await ref.read(apiProvider).reverseGeocode(latitude: latitude, longitude: longitude);
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
            origin: GeoPointModel(latitude: _pickupLatitude, longitude: _pickupLongitude),
            destination: GeoPointModel(latitude: _destinationLatitude, longitude: _destinationLongitude),
            vehicleType: _vehicleType,
          );
      if (mounted) setState(() => _routePreview = route);
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
      _rideSubscription = FirebaseFirestore.instance.collection('rides').doc(rideId).snapshots().listen(
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

    if (_subscribedDriverId == driverId && _subscribedRideId == rideId) return;
    _stopDriverLocationListener();
    _subscribedDriverId = driverId;
    _subscribedRideId = rideId;

    unawaited(_ensureFirebaseReady().then((ready) {
      if (!ready || !mounted || _subscribedDriverId != driverId || _subscribedRideId != rideId) return;
      _driverLocationSubscription = FirebaseFirestore.instance
          .collection('driverLocations')
          .doc(driverId)
          .snapshots()
          .listen((snapshot) {
        if (!mounted || !snapshot.exists) return;
        final data = snapshot.data();
        if (data == null || data['rideId'] != rideId || data['driverId'] != driverId) return;
        final latitude = (data['latitude'] as num?)?.toDouble();
        final longitude = (data['longitude'] as num?)?.toDouble();
        if (latitude == null || longitude == null) return;
        final updatedAt = _timestampToIso(data['updatedAt']) ?? _timestampToIso(data['serverUpdatedAt']);
        setState(() {
          final current = _ride;
          if (current == null || current['id'] != rideId) return;
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
        if (mounted) setState(() => _message = 'تعذر استقبال موقع الكابتن المباشر حالياً');
      });
    }));
  }

  Map<String, dynamic> _smoothLocation(Map<String, dynamic>? previous, double latitude, double longitude) {
    final previousLat = (previous?['latitude'] as num?)?.toDouble();
    final previousLng = (previous?['longitude'] as num?)?.toDouble();
    if (previousLat == null || previousLng == null) {
      return {'latitude': latitude, 'longitude': longitude, 'addressName': 'Live driver location'};
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
            paymentMethod: ride['paymentMethod'] == 'DIGITAL_PROVIDER' ? 'digital_provider' : 'wallet',
          );
      final payment = result['payment'] is Map ? Map<String, dynamic>.from(result['payment'] as Map) : result;
      if (mounted) {
        setState(() {
          _ride = {...ride, 'paymentStatus': _paymentStatusFromBackend(payment['status'])};
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
      final payment = await ref.read(apiProvider).ridePayment(ride['id'] as String);
      final paymentId = payment?['id']?.toString();
      if (paymentId == null) throw StateError('لا توجد عملية دفع قابلة للاسترجاع لهذا المشوار');
      final refund = await ref.read(apiProvider).requestPaymentRefund(
            paymentId: paymentId,
            reason: 'service_issue',
          );
      if (mounted) setState(() => _message = 'تم إرسال طلب الاسترجاع: ${refund['status']}');
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
        content: const Text('سيتم إرسال تنبيه سلامة عاجل إلى فريق عمليات مشوار مع سياق الرحلة. لا يوجد ربط مباشر بالشرطة أو الإسعاف.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('إرسال SOS')),
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

  String _paymentStatusFromBackend(Object? status) => switch (status?.toString().toLowerCase()) {
        'paid' => 'PAID',
        'processing' => 'PROCESSING',
        'authorized' => 'AUTHORIZED',
        'failed' => 'FAILED',
        'cancelled' => 'CANCELLED',
        _ => 'PENDING',
      };

  String _paymentMessage(Object? status) => switch (status?.toString().toLowerCase()) {
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

  Future<void> _createQuickSupportTicket({String category = 'technical'}) async {
    setState(() => _message = null);
    try {
      await ref.read(apiProvider).createSupportTicket(
            role: 'CUSTOMER',
            category: category,
            subject: category == 'account_review' ? 'Account review request' : 'Customer support request',
            message: category == 'account_review'
                ? 'Please review my account status.'
                : 'I need help from support.',
            rideId: _ride?['id']?.toString(),
          );
      if (mounted) setState(() => _message = 'تم إرسال طلب الدعم للمراجعة.');
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
      if (mounted) setState(() => _message = 'تم تسجيل الطلب وسيتم مراجعته يدويا.');
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
              Text('API: $mishwarApiBaseUrl'),
              if (mishwarAppMode.toLowerCase() != 'production') Text('Mode: $mishwarAppMode'),
              Text('Privacy: ${config['privacyPolicyUrl'] ?? 'not configured'}'),
              Text('Terms: ${config['termsUrl'] ?? 'not configured'}'),
              Text('Support: ${config['supportUrl'] ?? config['supportEmail'] ?? 'not configured'}'),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('إغلاق')),
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
    final isActiveRide = _ride != null && !_terminalStatuses.contains(_ride!['status']);

    return Scaffold(
      appBar: AppBar(
        title: const Text('مشوار'),
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
        ],
      ),
      body: Container(
        decoration: const BoxDecoration(gradient: MishwarBrand.gradient),
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const MishwarBrandHeader(subtitle: 'رحلات ذكية • أسرع • أكثر أماناً'),
              const SizedBox(height: 16),
              _HealthCard(health: health),
              const SizedBox(height: 16),
              OfflineSyncCard(api: ref.read(apiProvider)),
              const SizedBox(height: 16),
              _LaunchReadinessCard(
                onSupport: () => _createQuickSupportTicket(),
                onAccountReview: () => _createQuickSupportTicket(category: 'account_review'),
                onDeleteAccount: () => _createPrivacyRequest('account_deletion'),
                onDataAccess: () => _createPrivacyRequest('data_access'),
              ),
              if (mishwarAppMode.toLowerCase() != 'demo') const SizedBox(height: 16),
              const ProductionTasksCard(
                audience: ProductionTaskAudience.customer,
                title: 'مهام تطبيق العميل',
              ),
              const SizedBox(height: 16),
              if (mishwarAppMode.toLowerCase() != 'demo') ...[
                _PassengerOnboardingCard(api: ref.read(apiProvider)),
                const SizedBox(height: 16),
              ],
              if (isActiveRide) _activeRideCard(_ride!) else _bookingCard(),
              if (_message != null) ...[
                const SizedBox(height: 12),
                _MessageBanner(message: _message!),
              ],
            ],
          ),
        ),
      ),
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
              Text(_rideStatusLabel(previousStatus), style: const TextStyle(color: Colors.white70)),
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
                    trailing: place.distanceMeters == null ? null : Text(formatDistance(place.distanceMeters!)),
                    onTap: () => _selectPlace(place),
                  )),
            ],
            const SizedBox(height: 16),
            Align(
              alignment: Alignment.centerRight,
              child: Text('اختر نقطة على الخريطة', style: Theme.of(context).textTheme.titleSmall),
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'pickup', label: Text('الانطلاق'), icon: Icon(Icons.trip_origin)),
                ButtonSegment(value: 'destination', label: Text('الوجهة'), icon: Icon(Icons.location_on_outlined)),
              ],
              selected: {_mapSelection},
              onSelectionChanged: (selection) => setState(() => _mapSelection = selection.first),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _busy ? null : _useCurrentLocation,
              icon: const Icon(Icons.my_location),
              label: const Text('استخدم موقعي الحالي'),
            ),
            const SizedBox(height: 10),
            SizedBox(
              height: 230,
              child: MishwarMap(
                centerLatitude: (_pickupLatitude + _destinationLatitude) / 2,
                centerLongitude: (_pickupLongitude + _destinationLongitude) / 2,
                pickupLatitude: _pickupLatitude,
                pickupLongitude: _pickupLongitude,
                destinationLatitude: _destinationLatitude,
                destinationLongitude: _destinationLongitude,
                routePolyline: _routePreview?.polyline ?? const [],
                onMapTap: _selectMapLocation,
                routingEnabled: widget.routingEnabled,
              ),
            ),
            if (_routePreview != null) ...[
              const SizedBox(height: 8),
              _RideDetail(
                label: 'المسار التقريبي',
                value: '${formatDistance(_routePreview!.distanceMeters)} · ${formatDuration(_routePreview!.durationSeconds)}',
              ),
            ],
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _vehicleType,
              decoration: const InputDecoration(labelText: 'نوع المركبة', border: OutlineInputBorder()),
              items: _vehicleOptions.entries
                  .map((entry) => DropdownMenuItem(value: entry.key, child: Text(entry.value)))
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
              value: _passengerCount,
              decoration: const InputDecoration(labelText: 'عدد الركاب', border: OutlineInputBorder()),
              items: List.generate(_vehicleType == 'MOTORCYCLE' ? 1 : 4, (index) => index + 1)
                  .map((count) => DropdownMenuItem(value: count, child: Text('$count')))
                  .toList(),
              onChanged: _busy ? null : (value) => setState(() => _passengerCount = value ?? 1),
            ),
            if (_vehicleType != 'MOTORCYCLE')
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('أحتاج إلى مكيف'),
                value: _airConditioningRequired,
                onChanged: _busy ? null : (value) => setState(() => _airConditioningRequired = value),
              ),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: [
                ButtonSegment(value: 'CASH', label: Text('نقداً'), icon: Icon(Icons.payments_outlined)),
                ButtonSegment(value: 'WALLET', label: Text('المحفظة'), icon: Icon(Icons.account_balance_wallet_outlined)),
                if (mishwarEnableDigitalPayment)
                  const ButtonSegment(value: 'DIGITAL_PROVIDER', label: Text('إلكتروني'), icon: Icon(Icons.credit_card)),
              ],
              selected: {_paymentMethod},
              onSelectionChanged: _busy ? null : (selection) => setState(() => _paymentMethod = selection.first),
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: _busy ? null : _requestRide,
              icon: _busy
                  ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.local_taxi),
              label: Text(_busy ? 'جارٍ إرسال الطلب...' : 'اطلب مشواراً'),
              style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _activeRideCard(Map<String, dynamic> ride) {
    final status = ride['status'] as String? ?? '';
    final fare = ride['fare'] is Map ? Map<String, dynamic>.from(ride['fare'] as Map) : <String, dynamic>{};
    final pickup = Map<String, dynamic>.from(ride['pickup'] as Map);
    final destination = Map<String, dynamic>.from(ride['destination'] as Map);
    final driverLocation = ride['driverLocation'] is Map
      ? Map<String, dynamic>.from(ride['driverLocation'] as Map)
      : null;
    final driverFreshness = liveLocationStatus(ride['driverLocationUpdatedAt'] as String?);
    final showDriverLocation = driverLocation != null && driverFreshness.freshness != LiveLocationFreshness.offline;
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
                Expanded(child: Text(_rideStatusLabel(status), style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
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
                centerLatitude: ((pickup['latitude'] as num).toDouble() + (destination['latitude'] as num).toDouble()) / 2,
                centerLongitude: ((pickup['longitude'] as num).toDouble() + (destination['longitude'] as num).toDouble()) / 2,
                pickupLatitude: (pickup['latitude'] as num).toDouble(),
                pickupLongitude: (pickup['longitude'] as num).toDouble(),
                destinationLatitude: (destination['latitude'] as num).toDouble(),
                destinationLongitude: (destination['longitude'] as num).toDouble(),
                driverLatitude: showDriverLocation ? (driverLocation['latitude'] as num?)?.toDouble() : null,
                driverLongitude: showDriverLocation ? (driverLocation['longitude'] as num?)?.toDouble() : null,
                routePolyline: _routePolylineFromRide(ride),
                routingEnabled: widget.routingEnabled,
                followTarget: showDriverLocation,
              ),
            ),
            const SizedBox(height: 18),
            _RideDetail(label: 'من', value: ride['pickup']?['addressName']?.toString() ?? _pickupController.text),
            _RideDetail(label: 'إلى', value: ride['destination']?['addressName']?.toString() ?? _destinationController.text),
            _RideDetail(label: 'المركبة', value: _vehicleOptions[ride['vehicleType']] ?? ride['vehicleType'].toString()),
            _RideDetail(label: 'الدفع', value: _paymentMethodLabel(ride['paymentMethod'])),
            _RideDetail(label: 'حالة الدفع', value: _paymentStatusLabel(ride['paymentStatus'])),
            if (ride['driverName'] != null) _RideDetail(label: 'الكابتن', value: ride['driverName'].toString()),
            if (fare['grossFare'] != null) _RideDetail(label: 'الأجرة التقديرية', value: '${fare['grossFare']} ر.ي'),
            const SizedBox(height: 14),
            if (status != 'TRIP_COMPLETED') ...[
              FilledButton.icon(
                onPressed: _safetyBusy ? null : () => _confirmAndSendSos(ride),
                icon: _safetyBusy
                    ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.health_and_safety_outlined),
                label: const Text('السلامة / SOS'),
                style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626)),
              ),
              const SizedBox(height: 8),
            ],
            if (status == 'TRIP_COMPLETED' &&
                ride['paymentStatus'] != 'PAID' &&
                (ride['paymentMethod'] == 'WALLET' || ride['paymentMethod'] == 'DIGITAL_PROVIDER'))
              FilledButton.icon(
                onPressed: _paymentBusy ? null : _payForCompletedRide,
                icon: _paymentBusy
                    ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.lock_outline),
                label: Text(ride['paymentMethod'] == 'WALLET' ? 'الدفع من المحفظة' : 'بدء الدفع الإلكتروني'),
              ),
            if (status == 'TRIP_COMPLETED' && ride['paymentMethod'] == 'CASH' && ride['paymentStatus'] != 'PAID')
              const Text('بانتظار تأكيد الكابتن لاستلام المبلغ نقداً', textAlign: TextAlign.center),
            if (status == 'TRIP_COMPLETED' && ride['paymentStatus'] == 'PAID') ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: _refundBusy ? null : _requestRefundForRide,
                icon: _refundBusy
                    ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
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
                const Icon(Icons.privacy_tip_outlined, color: Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(child: Text('الدعم والخصوصية', style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 8),
            const Text('يمكنك طلب دعم، مراجعة حساب، حذف حساب، أو طلب بيانات. الحذف لا يتم فوريا وقد تتطلب بعض السجلات احتفاظا للمراجعة المالية أو السلامة.'),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(onPressed: onSupport, icon: const Icon(Icons.support_agent_outlined), label: const Text('دعم')),
                OutlinedButton.icon(onPressed: onAccountReview, icon: const Icon(Icons.manage_accounts_outlined), label: const Text('مراجعة الحساب')),
                OutlinedButton.icon(onPressed: onDataAccess, icon: const Icon(Icons.file_present_outlined), label: const Text('طلب البيانات')),
                OutlinedButton.icon(onPressed: onDeleteAccount, icon: const Icon(Icons.delete_outline), label: const Text('طلب حذف الحساب')),
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
  State<_PassengerOnboardingCard> createState() => _PassengerOnboardingCardState();
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
                Icon(_done ? Icons.verified_user_outlined : Icons.person_add_alt_1_outlined, color: const Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(child: Text('تجهيز حساب العميل', style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 8),
            const Text('يثبت دور CUSTOMER بعد تسجيل الدخول الحقيقي ويجهز الحساب للطلبات الإنتاجية.'),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _busy || _done ? null : _complete,
              icon: _busy
                  ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
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
          loading: () => const Row(children: [CircularProgressIndicator(), SizedBox(width: 12), Text('جاري الاتصال بالخادم...')]),
          error: (error, _) => Text('تعذر الاتصال بالخادم: $error'),
          data: (data) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('حالة الخادم', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text('${data['service']} - ${data['status']}'),
              Text('API: $mishwarApiBaseUrl', style: Theme.of(context).textTheme.bodySmall),
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
          SizedBox(width: 74, child: Text(label, style: const TextStyle(color: Colors.white60))),
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
        DateTime.now().difference(DateTime.tryParse(updatedAt as String)?.toLocal() ?? DateTime(2000)).inSeconds < 30;
    final color = isLive ? const Color(0xFF10B981) : Colors.amber;
    return Row(
      children: [
        Icon(isLive ? Icons.gps_fixed : Icons.location_searching, size: 18, color: color),
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
