import 'dart:async';

import 'package:dio/dio.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:mishwar_shared/geo_hardening.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:mishwar_shared/location_update_policy.dart';
import 'package:mishwar_shared/mishwar_api.dart';
import 'package:mishwar_shared/mishwar_brand.dart';
import 'package:mishwar_shared/mobile_runtime.dart';
import 'package:mishwar_shared/osm_ride_map.dart';
import 'package:mishwar_shared/production_tasks.dart';

final apiProvider = Provider<MishwarApi>((ref) => MishwarApi(firebaseIdTokenProvider: firebaseIdToken));

final healthProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  return ref.watch(apiProvider).health();
});

const _terminalStatuses = <String>{
  'TRIP_COMPLETED',
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_PASSENGER',
  'CANCELLED_BY_DRIVER',
  'NO_DRIVER_FOUND',
  'NO_DRIVER_AVAILABLE',
};

String _rideStatusLabel(String status) => switch (status) {
      'SEARCHING_DRIVER' => 'طلب مشوار جديد',
      'DRIVER_ASSIGNED' || 'DRIVER_ARRIVING' || 'DRIVER_ON_THE_WAY' => 'توجه إلى موقع العميل',
      'DRIVER_ARRIVED' => 'وصلت إلى موقع العميل',
      'TRIP_STARTED' => 'المشوار جارٍ الآن',
      'TRIP_COMPLETED' => 'اكتمل المشوار',
      'CANCELLED_BY_CUSTOMER' || 'CANCELLED_BY_PASSENGER' => 'ألغى العميل المشوار',
      'CANCELLED_BY_DRIVER' => 'تم إلغاء المشوار',
      'NO_DRIVER_FOUND' || 'NO_DRIVER_AVAILABLE' => 'لم يعد الطلب متاحاً',
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

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await setupFirebaseRuntime(role: 'DRIVER');
  runApp(const ProviderScope(child: MishwarDriverApp()));
}

class MishwarDriverApp extends StatelessWidget {
  const MishwarDriverApp({super.key, this.routingEnabled = true});

  final bool routingEnabled;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'مشوار - تطبيق الكابتن',
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
        role: 'DRIVER',
        child: DriverHomeScreen(routingEnabled: routingEnabled),
      ),
    );
  }
}

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key, this.routingEnabled = true});

  final bool routingEnabled;

  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen> {
  final _locationPolicy = const DriverLocationThrottlePolicy();
  Timer? _pollTimer;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _rideSubscription;
  StreamSubscription<Position>? _locationSubscription;
  Map<String, dynamic>? _ride;
  Map<String, dynamic>? _finance;
  RouteModel? _driverRoutePreview;
  Position? _driverPosition;
  Position? _pendingOfflinePosition;
  bool _online = true;
  bool _busy = false;
  bool _cashBusy = false;
  bool _payoutBusy = false;
  bool _safetyBusy = false;
  bool _refreshing = false;
  bool _startingLocation = false;
  bool _locationPostInFlight = false;
  bool _locationServerReady = false;
  String? _locationAttemptedRideId;
  DateTime? _lastLocationPostedAt;
  DateTime? _lastRouteRefreshAt;
  Position? _lastUploadedPosition;
  Position? _lastDisplayPosition;
  int _locationSkippedCount = 0;
  String _locationMessage = 'سيُطلب إذن الموقع بعد قبول المشوار';
  String? _message;

  @override
  void initState() {
    super.initState();
    unawaited(registerMessagingToken(api: ref.read(apiProvider), role: 'DRIVER'));
    unawaited(ref.read(apiProvider).syncOfflineQueue());
    _refreshRide();
    _refreshFinance();
    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _refreshRide());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _rideSubscription?.cancel();
    _locationSubscription?.cancel();
    super.dispose();
  }

  Future<void> _refreshRide() async {
    if (!_online || _refreshing || _busy) return;
    _refreshing = true;
    try {
      final ride = await ref.read(apiProvider).incomingRide();
      if (!mounted) return;
      setState(() => _ride = ride);
      _syncRideListener(ride);
      final status = ride?['status'] as String?;
      if (ride == null || _terminalStatuses.contains(status)) {
        await _stopLocationTracking();
      } else if (status != 'SEARCHING_DRIVER' &&
          _locationSubscription == null &&
          _locationAttemptedRideId != ride['id']) {
        unawaited(_startLocationTracking(ride['id'] as String));
      }
    } catch (error) {
      if (mounted && _ride == null) setState(() => _message = _errorMessage(error));
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _refreshFinance() async {
    try {
      final finance = await ref.read(apiProvider).driverFinance();
      if (mounted) setState(() => _finance = finance);
    } catch (_) {
      // Finance may be unavailable in demo/offline mode; ride workflow should continue.
    }
  }

  Future<void> _requestPayout() async {
    final available = (_finance?['availableBalance'] as num?)?.toInt() ?? 0;
    if (available <= 0) {
      setState(() => _message = 'لا يوجد رصيد متاح للسحب حالياً');
      return;
    }
    setState(() {
      _payoutBusy = true;
      _message = null;
    });
    try {
      await ref.read(apiProvider).requestDriverPayout(amount: available);
      await _refreshFinance();
      if (mounted) setState(() => _message = 'تم إرسال طلب السحب للمراجعة');
      unawaited(logAnalyticsEvent(role: 'DRIVER', name: 'payout_requested'));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _payoutBusy = false);
    }
  }

  Future<void> _rideAction(String action) async {
    final ride = _ride;
    if (ride == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final updated = await ref.read(apiProvider).rideAction(
            ride['id'] as String,
            action,
            driverName: 'كابتن مشوار',
            reason: action == 'cancel' ? 'تم الإلغاء من تطبيق الكابتن' : null,
            actorRole: 'DRIVER',
          );
      if (mounted) setState(() => _ride = updated);
      _syncRideListener(updated);
      if (action == 'accept') {
        unawaited(logAnalyticsEvent(role: 'DRIVER', name: 'ride_offer_accepted'));
        await _startLocationTracking(updated['id'] as String);
      } else if (_terminalStatuses.contains(updated['status'])) {
        if (action == 'complete') {
          unawaited(logAnalyticsEvent(role: 'DRIVER', name: 'ride_completed'));
        }
        await _stopLocationTracking();
      } else if (action == 'start') {
        unawaited(logAnalyticsEvent(role: 'DRIVER', name: 'ride_started'));
      }
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
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
            role: 'DRIVER',
            description: 'SOS from driver Flutter app',
            location: _driverPosition == null
                ? null
                : {
                    'latitude': _driverPosition!.latitude,
                    'longitude': _driverPosition!.longitude,
                    'accuracy': _driverPosition!.accuracy,
                    'capturedAt': _driverPosition!.timestamp.toUtc().toIso8601String(),
                  },
          );
      final incidentId = response['incidentId']?.toString();
      if (mounted) {
        setState(() => _message = incidentId == null
            ? 'تم إرسال تنبيه السلامة لفريق عمليات مشوار.'
            : 'تم إرسال تنبيه السلامة. رقم البلاغ: $incidentId');
      }
      unawaited(logAnalyticsEvent(role: 'DRIVER', name: 'sos_pressed'));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _safetyBusy = false);
    }
  }

  Future<void> _confirmCashPayment() async {
    final ride = _ride;
    if (ride == null) return;
    setState(() {
      _cashBusy = true;
      _message = null;
    });
    try {
      await ref.read(apiProvider).confirmCashPayment(rideId: ride['id'] as String);
      await _refreshRide();
      if (mounted) setState(() => _message = 'تم تأكيد استلام المبلغ نقداً');
      unawaited(logAnalyticsEvent(role: 'DRIVER', name: 'cash_payment_confirmed'));
    } catch (error) {
      if (mounted) setState(() => _message = _errorMessage(error));
    } finally {
      if (mounted) setState(() => _cashBusy = false);
    }
  }

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

  Future<void> _startLocationTracking(String rideId, {bool retry = false}) async {
    if (_startingLocation ||
        _locationSubscription != null ||
        (!retry && _locationAttemptedRideId == rideId)) return;
    _locationAttemptedRideId = rideId;
    setState(() {
      _startingLocation = true;
      _locationMessage = 'جارٍ طلب إذن الموقع...';
    });

    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        throw StateError('فعّل خدمة الموقع على جهازك ثم حاول مجدداً.');
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.deniedForever) {
        throw StateError('إذن الموقع محظور. غيّره من إعدادات المتصفح ثم أعد المحاولة.');
      }
      if (permission == LocationPermission.denied) {
        throw StateError('لم يتم منح إذن الموقع. يمكنك المحاولة مرة أخرى.');
      }

      final initialPosition = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 12),
      );
      if (!mounted || _ride?['id'] != rideId) return;
      setState(() {
        _driverPosition = initialPosition;
        _locationMessage = 'تم تحديد موقعك، جارٍ مشاركته مع العميل';
      });
      await _publishLocation(rideId, initialPosition);

      final phase = _locationPhase(_ride?['status'] as String?);
      _locationSubscription = Geolocator.getPositionStream(
        locationSettings: LocationSettings(
          accuracy: LocationAccuracy.high,
          distanceFilter: _locationPolicy.distanceFilterMeters(phase),
        ),
      ).listen(
        (position) {
          if (!mounted || _ride?['id'] != rideId) return;
          final quality = evaluateDisplayLocation(
            latitude: position.latitude,
            longitude: position.longitude,
            accuracyMeters: position.accuracy,
            capturedAt: position.timestamp,
            previousLatitude: _lastDisplayPosition?.latitude,
            previousLongitude: _lastDisplayPosition?.longitude,
            previousCapturedAt: _lastDisplayPosition?.timestamp,
          );
          if (!quality.accepted) {
            _locationSkippedCount += 1;
            setState(() => _locationMessage = _driverLocationQualityMessage(quality.reason));
            return;
          }
          setState(() {
            _driverPosition = position;
            _lastDisplayPosition = position;
          });
          unawaited(_publishLocation(rideId, position));
        },
        onError: (Object error) {
          _locationSubscription?.cancel();
          _locationSubscription = null;
          if (mounted) {
            setState(() {
              _locationServerReady = false;
              _locationMessage = 'توقف تحديث الموقع: $error';
            });
          }
        },
      );
    } catch (error) {
      if (mounted) setState(() => _locationMessage = _locationErrorMessage(error));
    } finally {
      if (mounted) setState(() => _startingLocation = false);
    }
  }

  String _locationErrorMessage(Object error) {
    final message = error is StateError ? error.message : error.toString();
    return message.replaceFirst('Bad state: ', '');
  }

  String _driverLocationQualityMessage(String reason) => switch (reason) {
        'low_accuracy' => 'دقة الموقع منخفضة، سننتظر إشارة GPS أفضل.',
        'impossible_jump' => 'تم تجاهل قفزة غير منطقية في الموقع مؤقتاً.',
        'stale_timestamp' => 'الموقع قديم، بانتظار تحديث أحدث.',
        'future_timestamp' => 'وقت الجهاز غير مضبوط، تحقق من الساعة ثم حاول مجدداً.',
        _ => 'تعذر تحديث موقعك، سنحاول مع النقطة التالية.',
      };

  void _syncRideListener(Map<String, dynamic>? ride) {
    final rideId = ride?['id'] as String?;
    final status = ride?['status'] as String?;
    final canListen = rideId != null &&
        status != 'SEARCHING_DRIVER' &&
        !_terminalStatuses.contains(status) &&
        mishwarAppMode.toLowerCase() != 'demo';

    if (!canListen) {
      _rideSubscription?.cancel();
      _rideSubscription = null;
      return;
    }

    unawaited(ensureFirebaseReady().then((ready) {
      if (!ready || !mounted) return;
      _rideSubscription?.cancel();
      _rideSubscription = FirebaseFirestore.instance.collection('rides').doc(rideId).snapshots().listen(
        (snapshot) {
          if (!mounted || !snapshot.exists) return;
          final data = snapshot.data();
          if (data == null) return;
          setState(() => _ride = {...data, 'id': data['id'] ?? rideId});
        },
      );
    }));
  }

  LocationSharingPhase _locationPhase(String? rideStatus) {
    if (!_online) return LocationSharingPhase.offline;
    if (rideStatus == 'TRIP_STARTED') return LocationSharingPhase.activeTrip;
    if (rideStatus == 'DRIVER_ASSIGNED' ||
        rideStatus == 'DRIVER_ARRIVING' ||
        rideStatus == 'DRIVER_ON_THE_WAY' ||
        rideStatus == 'DRIVER_ARRIVED') {
      return LocationSharingPhase.arriving;
    }
    return LocationSharingPhase.onlineIdle;
  }

  Future<void> _publishLocation(String rideId, Position position) async {
    if (_locationPostInFlight) return;
    final now = DateTime.now();
    final decision = _locationPolicy.shouldUpload(
      phase: _locationPhase(_ride?['status'] as String?),
      now: now,
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyMeters: position.accuracy,
      capturedAt: position.timestamp,
      lastUploadedAt: _lastLocationPostedAt,
      lastLatitude: _lastUploadedPosition?.latitude,
      lastLongitude: _lastUploadedPosition?.longitude,
    );
    if (!decision.shouldUpload) {
      _locationSkippedCount += 1;
      if (mounted && decision.reason == 'low_accuracy') {
        setState(() => _locationMessage = 'تم تجاهل نقطة GPS ضعيفة مؤقتاً للحفاظ على دقة التتبع');
      }
      return;
    }

    _locationPostInFlight = true;
    try {
      final capturedAt = position.timestamp;
      final updated = await ref.read(apiProvider).updateDriverLocation(
            rideId: rideId,
            latitude: position.latitude,
            longitude: position.longitude,
            accuracy: position.accuracy,
            heading: position.heading.isFinite ? position.heading : null,
            speed: position.speed.isFinite ? position.speed : null,
            clientUpdatedAt: (capturedAt is DateTime ? capturedAt : now).toUtc().toIso8601String(),
            skippedCount: _locationSkippedCount,
          );
      if (mounted && _ride?['id'] == rideId) {
        setState(() {
          _ride = {
            ..._ride!,
            'driverLocation': updated['driverLocation'],
            'driverLocationUpdatedAt': updated['driverLocationUpdatedAt'],
          };
          _locationServerReady = true;
          _lastLocationPostedAt = now;
          _lastUploadedPosition = position;
          _pendingOfflinePosition = null;
          _locationSkippedCount = 0;
          _locationMessage = 'موقعك مباشر ويظهر للعميل';
        });
        unawaited(_refreshDriverRoute(position));
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _locationServerReady = false;
          _pendingOfflinePosition = position;
          _locationMessage = 'تعذر إرسال الموقع: ${_errorMessage(error)}';
        });
      }
    } finally {
      _locationPostInFlight = false;
    }
  }

  Future<void> _stopLocationTracking() async {
    await _locationSubscription?.cancel();
    _locationSubscription = null;
    _lastLocationPostedAt = null;
    _lastUploadedPosition = null;
    _lastDisplayPosition = null;
    _pendingOfflinePosition = null;
    _locationSkippedCount = 0;
    _locationAttemptedRideId = null;
    _driverRoutePreview = null;
    _lastRouteRefreshAt = null;
    _locationServerReady = false;
    if (mounted && _driverPosition != null) {
      setState(() {
        _driverPosition = null;
        _locationServerReady = false;
        _locationMessage = 'انتهى المشوار وتوقفت مشاركة الموقع';
      });
    }
  }

  List<GeoPointModel> _routePolylineFromRide(Map<String, dynamic> ride) {
    final status = ride['status'] as String?;
    if (status != 'TRIP_STARTED' && _driverRoutePreview?.polyline.isNotEmpty == true) {
      return _driverRoutePreview!.polyline;
    }
    final raw = ride['routePolyline'];
    if (raw is! List) return const [];
    return raw.map(GeoPointModel.fromJson).whereType<GeoPointModel>().toList();
  }

  Future<void> _refreshDriverRoute(Position position) async {
    final ride = _ride;
    if (ride == null) return;
    final status = ride['status'] as String?;
    if (status == 'TRIP_STARTED' || _terminalStatuses.contains(status)) return;
    final pickup = ride['pickup'];
    if (pickup is! Map) return;
    final destination = GeoPointModel(
      latitude: (pickup['latitude'] as num).toDouble(),
      longitude: (pickup['longitude'] as num).toDouble(),
    );
    final decision = shouldRefreshRoute(
      now: DateTime.now(),
      lastRefreshAt: _lastRouteRefreshAt,
      currentLocation: GeoPointModel(latitude: position.latitude, longitude: position.longitude),
      routePolyline: _driverRoutePreview?.polyline ?? const [],
      routeModeChanged: _driverRoutePreview == null,
    );
    if (!decision.shouldRefresh) return;
    try {
      final route = await ref.read(apiProvider).calculateRoute(
            origin: GeoPointModel(latitude: position.latitude, longitude: position.longitude),
            destination: destination,
            vehicleType: ride['vehicleType']?.toString() ?? 'CAR',
            role: 'DRIVER',
          );
      if (mounted) {
        setState(() {
          _driverRoutePreview = route;
          _lastRouteRefreshAt = DateTime.now();
        });
      }
    } catch (_) {
      // Ride flow continues without driver-to-pickup route preview.
    }
  }

  Future<void> _createQuickSupportTicket({String category = 'technical'}) async {
    setState(() => _message = null);
    try {
      await ref.read(apiProvider).createSupportTicket(
            role: 'DRIVER',
            category: category,
            subject: category == 'account_review' ? 'Driver account review request' : 'Driver support request',
            message: category == 'account_review'
                ? 'Please review my driver account status.'
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
            role: 'DRIVER',
            type: type,
            message: type == 'account_deletion'
                ? 'Please review my driver account deletion request.'
                : 'Please review my driver account data request.',
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
          title: const Text('مشوار كابتن'),
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

  @override
  Widget build(BuildContext context) {
    final health = ref.watch(healthProvider);
    final status = _ride?['status'] as String?;
    final isIncoming = status == 'SEARCHING_DRIVER';
    final isInRide = status != null && !_terminalStatuses.contains(status) && !isIncoming;

    return Scaffold(
      appBar: AppBar(
        title: const Text('كابتن مشوار'),
        actions: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_online ? 'متصل' : 'غير متصل', style: Theme.of(context).textTheme.labelSmall),
              Switch(
                value: _online,
                onChanged: _busy || isInRide
                    ? null
                    : (value) {
                        setState(() {
                          _online = value;
                          if (!value) _ride = null;
                        });
                        unawaited(logAnalyticsEvent(role: 'DRIVER', name: value ? 'driver_online' : 'driver_offline'));
                        if (value) _refreshRide();
                      },
                activeColor: const Color(0xFF10B981),
              ),
            ],
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
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
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
            const SizedBox(height: 16),
            _DriverFinanceCard(
              finance: _finance,
              busy: _payoutBusy,
              onRefresh: _refreshFinance,
              onRequestPayout: _requestPayout,
            ),
            if (mishwarAppMode.toLowerCase() != 'demo') const SizedBox(height: 16),
            const ProductionTasksCard(
              audience: ProductionTaskAudience.driver,
              title: 'مهام تطبيق الكابتن',
            ),
            const SizedBox(height: 16),
            if (mishwarAppMode.toLowerCase() != 'demo') ...[
              _DriverKycCard(api: ref.read(apiProvider)),
              const SizedBox(height: 16),
            ],
            if (isInRide && _ride != null) ...[
              _LocationStatusCard(
                message: _locationMessage,
                isStarting: _startingLocation,
                isSharing: _locationServerReady,
                accuracy: _driverPosition?.accuracy,
                onRetry: _startingLocation
                    ? null
                    : () {
                        final rideId = _ride!['id'] as String;
                        final position = _pendingOfflinePosition ?? _driverPosition;
                        if (position == null || _locationSubscription == null) {
                          _startLocationTracking(rideId, retry: true);
                        } else {
                          _publishLocation(rideId, position);
                        }
                      },
              ),
              const SizedBox(height: 12),
            ],
            if (_ride == null)
              const SizedBox(
                height: 230,
                child: MishwarMap(
                  centerLatitude: 15.3694,
                  centerLongitude: 44.1910,
                ),
              ),
            if (_ride == null) const SizedBox(height: 12),
            if (!_online)
              const _InfoCard(
                icon: Icons.pause_circle_outline,
                title: 'أنت غير متصل',
                message: 'فعّل حالة الاتصال لاستقبال طلبات المشاوير.',
              )
            else if (_ride == null)
              const _InfoCard(
                icon: Icons.radar,
                title: 'بانتظار طلب جديد',
                message: 'سيظهر طلب العميل هنا فور إرساله.',
              )
            else
              _rideCard(_ride!, incoming: isIncoming),
            if (_message != null) ...[
              const SizedBox(height: 12),
              _MessageBanner(message: _message!),
            ],
          ],
        ),
      ),
    );
  }

  Widget _rideCard(Map<String, dynamic> ride, {required bool incoming}) {
    final status = ride['status'] as String? ?? '';
    final fare = ride['fare'] is Map ? Map<String, dynamic>.from(ride['fare'] as Map) : <String, dynamic>{};
    final pickup = Map<String, dynamic>.from(ride['pickup'] as Map);
    final destination = Map<String, dynamic>.from(ride['destination'] as Map);
    final nextAction = switch (status) {
      'DRIVER_ASSIGNED' || 'DRIVER_ARRIVING' || 'DRIVER_ON_THE_WAY' => ('arrived', 'وصلت إلى العميل', Icons.place_outlined),
      'DRIVER_ARRIVED' => ('start', 'ابدأ المشوار', Icons.play_arrow),
      'TRIP_STARTED' => ('complete', 'إنهاء المشوار', Icons.flag_outlined),
      _ => (null, '', Icons.check),
    };

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(incoming ? Icons.notifications_active_outlined : Icons.navigation_outlined, color: const Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(child: Text(_rideStatusLabel(status), style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 14),
            SizedBox(
              height: 230,
              child: MishwarMap(
                centerLatitude: ((pickup['latitude'] as num).toDouble() + (destination['latitude'] as num).toDouble()) / 2,
                centerLongitude: ((pickup['longitude'] as num).toDouble() + (destination['longitude'] as num).toDouble()) / 2,
                pickupLatitude: (pickup['latitude'] as num).toDouble(),
                pickupLongitude: (pickup['longitude'] as num).toDouble(),
                destinationLatitude: (destination['latitude'] as num).toDouble(),
                destinationLongitude: (destination['longitude'] as num).toDouble(),
                driverLatitude: _driverPosition?.latitude ?? (ride['driverLocation']?['latitude'] as num?)?.toDouble(),
                driverLongitude: _driverPosition?.longitude ?? (ride['driverLocation']?['longitude'] as num?)?.toDouble(),
                routePolyline: _routePolylineFromRide(ride),
                routingEnabled: widget.routingEnabled,
              ),
            ),
            const SizedBox(height: 16),
            _RideDetail(label: 'العميل', value: ride['customerName']?.toString() ?? 'عميل مشوار'),
            _RideDetail(label: 'الانطلاق', value: ride['pickup']?['addressName']?.toString() ?? ''),
            _RideDetail(label: 'الوجهة', value: ride['destination']?['addressName']?.toString() ?? ''),
            _RideDetail(label: 'المركبة', value: ride['vehicleType']?.toString() ?? ''),
            _RideDetail(label: 'الدفع', value: _paymentMethodLabel(ride['paymentMethod'])),
            _RideDetail(label: 'حالة الدفع', value: _paymentStatusLabel(ride['paymentStatus'])),
            if (fare['grossFare'] != null) _RideDetail(label: 'الأجرة', value: '${fare['grossFare']} ر.ي'),
            const SizedBox(height: 18),
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
            if (incoming) ...[
              FilledButton.icon(
                onPressed: _busy ? null : () => _rideAction('accept'),
                icon: _busy
                    ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.check_circle_outline),
                label: const Text('قبول الطلب'),
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: _busy ? null : () => _rideAction('decline'),
                icon: const Icon(Icons.close),
                label: const Text('رفض الطلب'),
              ),
            ] else if (nextAction.$1 != null) ...[
              FilledButton.icon(
                onPressed: _busy ? null : () => _rideAction(nextAction.$1!),
                icon: _busy
                    ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(nextAction.$3),
                label: Text(nextAction.$2),
              ),
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: _busy ? null : () => _rideAction('cancel'),
                icon: const Icon(Icons.cancel_outlined),
                label: const Text('إلغاء المشوار'),
              ),
            ] else
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (status == 'TRIP_COMPLETED' && ride['paymentMethod'] == 'CASH' && ride['paymentStatus'] != 'PAID')
                    FilledButton.icon(
                      onPressed: _cashBusy ? null : _confirmCashPayment,
                      icon: _cashBusy
                          ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.payments_outlined),
                      label: const Text('تأكيد استلام المبلغ نقداً'),
                    )
                  else
                    const Text('لا يوجد إجراء مطلوب لهذا الطلب.', textAlign: TextAlign.center),
                ],
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
                const Icon(Icons.privacy_tip_outlined, color: Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(child: Text('الدعم والخصوصية', style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 8),
            const Text('طلبات الدعم والخصوصية تذهب للمراجعة اليدوية. حذف الحساب ليس حذفا فوريا لأن بعض السجلات قد تحتاج احتفاظا للمالية والسلامة والامتثال.'),
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

class _DriverKycCard extends StatefulWidget {
  const _DriverKycCard({required this.api});

  final MishwarApi api;

  @override
  State<_DriverKycCard> createState() => _DriverKycCardState();
}

class _DriverFinanceCard extends StatelessWidget {
  const _DriverFinanceCard({
    required this.finance,
    required this.busy,
    required this.onRefresh,
    required this.onRequestPayout,
  });

  final Map<String, dynamic>? finance;
  final bool busy;
  final VoidCallback onRefresh;
  final VoidCallback onRequestPayout;

  String _money(Object? value) => '${((value as num?) ?? 0).round()} ر.ي';

  @override
  Widget build(BuildContext context) {
    final transactions = (finance?['recentTransactions'] as List?) ?? const [];
    final payouts = (finance?['payouts'] as List?) ?? const [];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.account_balance_wallet_outlined, color: Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(child: Text('المحفظة والأرباح', style: Theme.of(context).textTheme.titleMedium)),
                IconButton(
                  tooltip: 'تحديث المالية',
                  onPressed: onRefresh,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _FinanceChip(label: 'متاح', value: _money(finance?['availableBalance'])),
                _FinanceChip(label: 'معلق', value: _money(finance?['pendingBalance'])),
                _FinanceChip(label: 'محجوز', value: _money(finance?['reservedBalance'])),
                _FinanceChip(label: 'إجمالي الأرباح', value: _money(finance?['totalEarnings'])),
                _FinanceChip(label: 'عمولة المنصة', value: _money(finance?['totalPlatformCommission'])),
              ],
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: busy ? null : onRequestPayout,
              icon: busy
                  ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.payments_outlined),
              label: const Text('طلب سحب الرصيد المتاح'),
            ),
            if (transactions.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text('آخر الحركات', style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: 6),
              ...transactions.take(3).map((item) {
                final tx = Map<String, dynamic>.from(item as Map);
                return _RideDetail(label: tx['type']?.toString() ?? '', value: _money(tx['amount']));
              }),
            ],
            if (payouts.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text('طلبات السحب', style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: 6),
              ...payouts.take(3).map((item) {
                final payout = Map<String, dynamic>.from(item as Map);
                return _RideDetail(label: payout['status']?.toString() ?? '', value: _money(payout['amount']));
              }),
            ],
          ],
        ),
      ),
    );
  }
}

class _FinanceChip extends StatelessWidget {
  const _FinanceChip({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Chip(
      avatar: const Icon(Icons.monetization_on_outlined, size: 18),
      label: Text('$label: $value'),
    );
  }
}

class _DriverKycCardState extends State<_DriverKycCard> {
  final _documentUrlController = TextEditingController();
  String _documentType = 'NATIONAL_ID';
  bool _busy = false;
  String? _message;

  @override
  void dispose() {
    _documentUrlController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_documentUrlController.text.trim().isEmpty) {
      setState(() => _message = 'أضف رابط مستند التحقق أولاً');
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await widget.api.submitKycDocument(
        type: _documentType,
        documentUrl: _documentUrlController.text.trim(),
      );
      if (mounted) setState(() => _message = 'تم إرسال مستند KYC للمراجعة');
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
                const Icon(Icons.badge_outlined, color: Color(0xFF10B981)),
                const SizedBox(width: 10),
                Expanded(child: Text('توثيق الكابتن KYC', style: Theme.of(context).textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _documentType,
              decoration: const InputDecoration(labelText: 'نوع المستند', border: OutlineInputBorder()),
              items: const [
                DropdownMenuItem(value: 'NATIONAL_ID', child: Text('هوية شخصية')),
                DropdownMenuItem(value: 'DRIVER_LICENSE', child: Text('رخصة قيادة')),
                DropdownMenuItem(value: 'VEHICLE_REGISTRATION', child: Text('استمارة المركبة')),
              ],
              onChanged: _busy ? null : (value) => setState(() => _documentType = value ?? 'NATIONAL_ID'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _documentUrlController,
              textDirection: TextDirection.ltr,
              decoration: const InputDecoration(
                labelText: 'رابط المستند',
                prefixIcon: Icon(Icons.link_outlined),
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _busy ? null : _submit,
              icon: _busy
                  ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.upload_file_outlined),
              label: const Text('إرسال للمراجعة'),
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
          SizedBox(width: 76, child: Text(label, style: const TextStyle(color: Colors.white60))),
          Expanded(child: Text(value, textAlign: TextAlign.right)),
        ],
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.icon, required this.title, required this.message});

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 28),
        child: Column(
          children: [
            Icon(icon, size: 36, color: const Color(0xFF10B981)),
            const SizedBox(height: 12),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(message, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
          ],
        ),
      ),
    );
  }
}

class _LocationStatusCard extends StatelessWidget {
  const _LocationStatusCard({
    required this.message,
    required this.isStarting,
    required this.isSharing,
    required this.onRetry,
    this.accuracy,
  });

  final String message;
  final bool isStarting;
  final bool isSharing;
  final double? accuracy;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final color = isSharing ? const Color(0xFF10B981) : const Color(0xFFF59E0B);
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            if (isStarting)
              const SizedBox.square(dimension: 22, child: CircularProgressIndicator(strokeWidth: 2))
            else
              Icon(isSharing ? Icons.gps_fixed : Icons.location_searching, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(isSharing ? 'مشاركة الموقع مباشرة' : 'مشاركة الموقع غير مفعلة',
                      style: const TextStyle(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 3),
                  Text(message, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
            if (accuracy != null && isSharing)
              Text('±${accuracy!.round()} م', style: Theme.of(context).textTheme.labelSmall),
            if (!isSharing && !isStarting)
              IconButton(
                tooltip: 'إعادة محاولة تحديد الموقع',
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
              ),
          ],
        ),
      ),
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
