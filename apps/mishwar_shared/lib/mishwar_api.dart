import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:shared_preferences/shared_preferences.dart';

const mishwarApiBaseUrl = String.fromEnvironment(
  'MISHWAR_API_BASE_URL',
  defaultValue: 'http://localhost:4000',
);

const mishwarAppMode = String.fromEnvironment(
  'MISHWAR_APP_MODE',
  defaultValue: 'demo',
);

const mishwarFirebaseIdToken = String.fromEnvironment(
  'MISHWAR_FIREBASE_ID_TOKEN',
  defaultValue: '',
);

const mishwarEnableDigitalPayment = bool.fromEnvironment(
  'MISHWAR_ENABLE_DIGITAL_PAYMENT',
  defaultValue: false,
);

const demoCustomerId = 'flutter_demo_customer';
const demoDriverId = 'flutter_demo_driver';
typedef FirebaseIdTokenProvider = Future<String?> Function();

bool get mishwarIsProductionMode => mishwarAppMode.toLowerCase() == 'production';

bool get mishwarIsStrictMobileMode {
  final mode = mishwarAppMode.toLowerCase();
  return mode == 'production' || mode == 'pilot' || mode == 'staging';
}

bool get mishwarApiBaseUrlIsUnsafeForStrictMode {
  final normalized = mishwarApiBaseUrl.toLowerCase();
  return normalized.isEmpty ||
      normalized.contains('localhost') ||
      normalized.contains('127.0.0.1') ||
      normalized.contains('demo') ||
      !normalized.startsWith('https://');
}

void validateMishwarMobileRuntimeConfig() {
  if (mishwarIsStrictMobileMode && mishwarApiBaseUrlIsUnsafeForStrictMode) {
    throw StateError(
      'MISHWAR_API_BASE_URL must be a real HTTPS API URL in staging, pilot, and production modes.',
    );
  }
}

class OfflineMutationQueuedException implements Exception {
  const OfflineMutationQueuedException(this.message);

  final String message;

  @override
  String toString() => message;
}

class MishwarApi {
  MishwarApi({FirebaseIdTokenProvider? firebaseIdTokenProvider})
      : _dio = Dio(BaseOptions(
          baseUrl: mishwarApiBaseUrl,
          connectTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 5),
        )),
        _firebaseIdTokenProvider = firebaseIdTokenProvider {
    validateMishwarMobileRuntimeConfig();
  }

  final Dio _dio;
  final FirebaseIdTokenProvider? _firebaseIdTokenProvider;

  static const _offlineQueueKey = 'mishwar_offline_mutation_queue';

  bool get _isDemoMode => mishwarAppMode.toLowerCase() == 'demo';

  Future<Map<String, String>> _headers(String role) async {
    if (_isDemoMode) {
      return {
        'x-user-id': role == 'CUSTOMER' ? demoCustomerId : demoDriverId,
        'x-user-role': role,
      };
    }

    final token = await _firebaseIdTokenProvider?.call() ?? mishwarFirebaseIdToken;
    return token.isEmpty ? <String, String>{} : {'Authorization': 'Bearer $token'};
  }

  Map<String, dynamic> _data(Response<dynamic> response) {
    return Map<String, dynamic>.from(response.data['data'] as Map);
  }

  bool _isOfflineError(Object error) {
    return error is DioException &&
        (error.type == DioExceptionType.connectionError ||
            error.type == DioExceptionType.connectionTimeout ||
            error.type == DioExceptionType.receiveTimeout ||
            error.response == null);
  }

  Future<void> _queueMutation({
    required String method,
    required String path,
    required String role,
    required Map<String, dynamic> data,
    Map<String, String>? extraHeaders,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final existing = prefs.getStringList(_offlineQueueKey) ?? <String>[];
    final isLocationUpdate = path.contains('/location');
    final queue = isLocationUpdate
        ? existing.where((raw) {
            try {
              final item = Map<String, dynamic>.from(jsonDecode(raw) as Map);
              return item['path'] != path || item['role'] != role;
            } catch (_) {
              return false;
            }
          }).toList()
        : existing;
    queue.add(jsonEncode({
      'method': method,
      'path': path,
      'role': role,
      'data': data,
      'extraHeaders': extraHeaders ?? <String, String>{},
      'queuedAt': DateTime.now().toUtc().toIso8601String(),
    }));
    await prefs.setStringList(_offlineQueueKey, queue.length > 50 ? queue.sublist(queue.length - 50) : queue);
  }

  Future<Response<dynamic>> _postWithOfflineQueue({
    required String path,
    required String role,
    required Map<String, dynamic> data,
    Map<String, String>? extraHeaders,
    bool queueWhenOffline = true,
  }) async {
    try {
      return await _dio.post(
        path,
        data: data,
        options: Options(headers: {
          ...await _headers(role),
          ...?extraHeaders,
        }),
      );
    } catch (error) {
      if (queueWhenOffline && _isOfflineError(error)) {
        await _queueMutation(
          method: 'POST',
          path: path,
          role: role,
          data: data,
          extraHeaders: extraHeaders,
        );
        throw const OfflineMutationQueuedException(
          'لا يوجد اتصال حالياً. تم حفظ العملية وستتم مزامنتها عند عودة الشبكة.',
        );
      }
      rethrow;
    }
  }

  Future<Response<dynamic>> _postCritical({
    required String path,
    required String role,
    required Map<String, dynamic> data,
    Map<String, String>? extraHeaders,
  }) {
    return _postWithOfflineQueue(
      path: path,
      role: role,
      data: data,
      extraHeaders: extraHeaders,
      queueWhenOffline: false,
    );
  }

  bool _isOfflineReplayAllowed(String path) {
    return path.contains('/location') || path == '/api/devices/register';
  }

  Future<int> pendingOfflineMutationsCount() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(_offlineQueueKey)?.length ?? 0;
  }

  Future<int> syncOfflineQueue() async {
    final prefs = await SharedPreferences.getInstance();
    final queue = [...prefs.getStringList(_offlineQueueKey) ?? <String>[]];
    if (queue.isEmpty) return 0;

    var synced = 0;
    final remaining = <String>[];
    for (final raw in queue) {
      try {
        final item = Map<String, dynamic>.from(jsonDecode(raw) as Map);
        final method = item['method'] as String? ?? 'POST';
        final path = item['path'] as String;
        final role = item['role'] as String;
        final data = Map<String, dynamic>.from(item['data'] as Map);
        final extraHeaders = Map<String, String>.from(item['extraHeaders'] as Map? ?? const {});
        if (method != 'POST') continue;
        if (!_isOfflineReplayAllowed(path)) {
          synced += 1;
          continue;
        }
        await _postWithOfflineQueue(
          path: path,
          role: role,
          data: data,
          extraHeaders: extraHeaders,
          queueWhenOffline: false,
        );
        synced += 1;
      } catch (_) {
        remaining.add(raw);
      }
    }

    await prefs.setStringList(_offlineQueueKey, remaining);
    return synced;
  }

  Future<Map<String, dynamic>> health() async {
    final response = await _dio.get('/health');
    final data = response.data;
    if (data is Map && data['data'] is Map) {
      return Map<String, dynamic>.from(data['data'] as Map);
    }
    return Map<String, dynamic>.from(data as Map);
  }

  Future<Map<String, dynamic>> publicConfig() async {
    final response = await _dio.get('/api/config/public');
    return _data(response);
  }

  Future<Map<String, dynamic>?> activeRide(String role) async {
    final response = await _dio.get(
      '/api/rides/active',
      options: Options(headers: await _headers(role)),
    );
    final data = response.data['data'];
    return data == null ? null : Map<String, dynamic>.from(data as Map);
  }

  Future<Map<String, dynamic>?> incomingRide() async {
    final response = await _dio.get(
      '/api/dispatch/incoming',
      options: Options(headers: await _headers('DRIVER')),
    );
    final data = response.data['data'];
    return data == null ? null : Map<String, dynamic>.from(data as Map);
  }

  Future<List<PlaceModel>> searchPlaces({
    required String query,
    double? latitude,
    double? longitude,
    String role = 'CUSTOMER',
  }) async {
    final response = await _dio.get(
      '/api/geo/search',
      queryParameters: {
        'q': query,
        if (latitude != null) 'latitude': latitude,
        if (longitude != null) 'longitude': longitude,
      },
      options: Options(headers: await _headers(role)),
    );
    final data = (response.data['data'] as List?) ?? const [];
    return data.map((item) => PlaceModel.fromJson(Map<String, dynamic>.from(item as Map))).toList();
  }

  Future<PlaceModel?> reverseGeocode({
    required double latitude,
    required double longitude,
    String role = 'CUSTOMER',
  }) async {
    final response = await _dio.get(
      '/api/geo/reverse',
      queryParameters: {
        'latitude': latitude,
        'longitude': longitude,
      },
      options: Options(headers: await _headers(role)),
    );
    final data = response.data['data'];
    return data is Map ? PlaceModel.fromJson(Map<String, dynamic>.from(data)) : null;
  }

  Future<RouteModel> calculateRoute({
    required GeoPointModel origin,
    required GeoPointModel destination,
    String vehicleType = 'CAR',
    String role = 'CUSTOMER',
  }) async {
    final response = await _postWithOfflineQueue(
      path: '/api/geo/route',
      role: role,
      data: {
        'origin': origin.toJson(),
        'destination': destination.toJson(),
        'vehicleType': vehicleType,
      },
      queueWhenOffline: false,
    );
    return RouteModel.fromJson(_data(response));
  }

  Future<Map<String, dynamic>> updateDriverLocation({
    required String rideId,
    required double latitude,
    required double longitude,
    double? accuracy,
    double? heading,
    double? speed,
    String? clientUpdatedAt,
    int? skippedCount,
  }) async {
    final response = await _postWithOfflineQueue(
      path: '/api/rides/$rideId/location',
      role: 'DRIVER',
      data: {
        'latitude': latitude,
        'longitude': longitude,
        if (accuracy != null) 'accuracy': accuracy,
        if (heading != null) 'heading': heading,
        if (speed != null) 'speed': speed,
        if (clientUpdatedAt != null) 'clientUpdatedAt': clientUpdatedAt,
        if (skippedCount != null && skippedCount > 0) 'skippedCount': skippedCount,
      },
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> requestRide({
    required String pickupName,
    required String destinationName,
    required double pickupLatitude,
    required double pickupLongitude,
    required double destinationLatitude,
    required double destinationLongitude,
    required String vehicleType,
    required int passengerCount,
    required bool airConditioningRequired,
    required String paymentMethod,
  }) async {
    final key = 'flutter-${DateTime.now().microsecondsSinceEpoch}';
    final response = await _postCritical(
      path: '/api/rides',
      role: 'CUSTOMER',
      data: {
        'customerName': 'عميل مشوار',
        'customerPhone': '771234567',
        'pickup': {
          'latitude': pickupLatitude,
          'longitude': pickupLongitude,
          'addressName': pickupName,
        },
        'destination': {
          'latitude': destinationLatitude,
          'longitude': destinationLongitude,
          'addressName': destinationName,
        },
        'vehicleType': vehicleType,
        'passengerCount': passengerCount,
        'airConditioningRequired': airConditioningRequired,
        'paymentMethod': paymentMethod,
      },
      extraHeaders: {'x-idempotency-key': key},
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> rideAction(
    String rideId,
    String action, {
    String? driverName,
    String? reason,
    String? actorRole,
  }) async {
    final data = <String, dynamic>{};
    if (driverName != null) data['driverName'] = driverName;
    if (reason != null) data['reason'] = reason;
    final role = actorRole ??
        (action == 'accept' || action == 'arrived' || action == 'start' || action == 'complete'
            ? 'DRIVER'
            : action == 'cancel'
                ? 'CUSTOMER'
                : 'DRIVER');
    final response = await _postCritical(
      path: '/api/rides/$rideId/$action',
      role: role,
      data: data,
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> triggerRideSos({
    required String rideId,
    required String role,
    String? description,
    Map<String, dynamic>? location,
  }) async {
    final response = await _postWithOfflineQueue(
      path: '/api/rides/$rideId/sos',
      role: role,
      data: {
        if (description != null) 'description': description,
        if (location != null) 'location': location,
      },
      queueWhenOffline: false,
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> createSafetyIncident({
    required String rideId,
    required String role,
    required String type,
    String severity = 'medium',
    String? description,
    Map<String, dynamic>? location,
  }) async {
    final response = await _postWithOfflineQueue(
      path: '/api/rides/$rideId/safety/incidents',
      role: role,
      data: {
        'type': type,
        'severity': severity,
        if (description != null) 'description': description,
        if (location != null) 'location': location,
      },
      queueWhenOffline: false,
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> registerDeviceToken({
    required String role,
    required String token,
    required String platform,
  }) async {
    final response = await _postWithOfflineQueue(
      path: '/api/devices/register',
      role: role,
      data: {
        'token': token,
        'platform': platform,
      },
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> unregisterDeviceToken({
    required String role,
    required String token,
  }) async {
    final response = await _postCritical(
      path: '/api/devices/unregister',
      role: role,
      data: {'token': token},
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> completePassengerOnboarding() async {
    final response = await _postCritical(
      path: '/api/auth/passenger/complete',
      role: 'CUSTOMER',
      data: const {},
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> submitKycDocument({
    required String type,
    required String documentUrl,
    String? expiresAt,
  }) async {
    final response = await _postCritical(
      path: '/api/kyc/documents',
      role: 'DRIVER',
      data: {
        'type': type,
        'documentUrl': documentUrl,
        if (expiresAt != null) 'expiresAt': expiresAt,
      },
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> createRidePayment({
    required String rideId,
    required String paymentMethod,
  }) async {
    final key = 'pay-${rideId}-${DateTime.now().microsecondsSinceEpoch}';
    final response = await _postCritical(
      path: '/api/payments',
      role: 'CUSTOMER',
      data: {
        'rideId': rideId,
        'paymentMethod': paymentMethod,
      },
      extraHeaders: {'x-idempotency-key': key},
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> confirmCashPayment({
    required String rideId,
  }) async {
    final key = 'cash-${rideId}-${DateTime.now().microsecondsSinceEpoch}';
    final response = await _postCritical(
      path: '/api/payments/cash/confirm',
      role: 'DRIVER',
      data: {'rideId': rideId},
      extraHeaders: {'x-idempotency-key': key},
    );
    return _data(response);
  }

  Future<Map<String, dynamic>?> ridePayment(String rideId) async {
    final response = await _dio.get(
      '/api/rides/$rideId/payment',
      options: Options(headers: await _headers('CUSTOMER')),
    );
    final data = response.data['data'];
    return data == null ? null : Map<String, dynamic>.from(data as Map);
  }

  Future<Map<String, dynamic>> driverFinance() async {
    final response = await _dio.get(
      '/api/driver/finance',
      options: Options(headers: await _headers('DRIVER')),
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> requestDriverPayout({
    required int amount,
    String method = 'cash_office',
  }) async {
    final key = 'payout-${DateTime.now().microsecondsSinceEpoch}';
    final response = await _postCritical(
      path: '/api/driver/payouts',
      role: 'DRIVER',
      data: {
        'amount': amount,
        'method': method,
      },
      extraHeaders: {'x-idempotency-key': key},
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> requestPaymentRefund({
    required String paymentId,
    int? amount,
    String reason = 'service_issue',
  }) async {
    final key = 'refund-$paymentId-${DateTime.now().microsecondsSinceEpoch}';
    final response = await _postCritical(
      path: '/api/payments/$paymentId/refunds',
      role: 'CUSTOMER',
      data: {
        if (amount != null) 'amount': amount,
        'reason': reason,
      },
      extraHeaders: {'x-idempotency-key': key},
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> createSupportTicket({
    required String role,
    required String category,
    required String subject,
    required String message,
    String? rideId,
    String priority = 'medium',
  }) async {
    final response = await _postCritical(
      path: '/api/support/tickets',
      role: role,
      data: {
        'category': category,
        'subject': subject,
        'message': message,
        'priority': priority,
        if (rideId != null) 'rideId': rideId,
      },
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> createPrivacyRequest({
    required String role,
    required String type,
    String? message,
  }) async {
    final response = await _postCritical(
      path: '/api/privacy/requests',
      role: role,
      data: {
        'type': type,
        if (message != null) 'message': message,
      },
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> submitRideRating({
    required String rideId,
    required int stars,
    List<String> reasons = const [],
    String? comment,
  }) async {
    final response = await _postCritical(
      path: '/api/rides/$rideId/rating',
      role: 'CUSTOMER',
      data: {
        'stars': stars,
        'reasons': reasons,
        if (comment != null) 'comment': comment,
      },
    );
    return _data(response);
  }

  Future<Map<String, dynamic>> recordAnalyticsEvent({
    required String role,
    required String name,
    Map<String, Object?> parameters = const {},
  }) async {
    final response = await _postCritical(
      path: '/api/analytics/events',
      role: role,
      data: {
        'name': name,
        'parameters': parameters,
      },
    );
    return _data(response);
  }
}
