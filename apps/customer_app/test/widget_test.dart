import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dio/dio.dart';
import 'package:mishwar_customer/main.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:mishwar_shared/mishwar_api.dart';

class _FakeMishwarApi extends MishwarApi {
  var requestRideCount = 0;
  final idempotencyKeys = <String?>[];

  @override
  Future<Map<String, dynamic>> health() async => {
        'service': 'Test API',
        'status': 'ONLINE',
      };

  @override
  Future<Map<String, dynamic>?> activeRide(String role) async => null;

  @override
  Future<RouteModel> calculateRoute({
    required GeoPointModel origin,
    required GeoPointModel destination,
    String vehicleType = 'CAR',
    String role = 'CUSTOMER',
  }) async =>
      RouteModel(
        origin: origin,
        destination: destination,
        distanceMeters: 1200,
        durationSeconds: 300,
        polyline: [origin, destination],
        provider: 'test',
        calculatedAt: DateTime.utc(2026).toIso8601String(),
      );

  @override
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
    String bookingMode = 'FAST',
    int? customerProposedFare,
    String? idempotencyKey,
  }) async {
    requestRideCount += 1;
    idempotencyKeys.add(idempotencyKey);
    return {
      'id': 'ride-test',
      'status': 'SEARCHING_DRIVER',
      'bookingMode': bookingMode,
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
      'fare': {'grossFare': customerProposedFare ?? 1200},
      'paymentMethod': paymentMethod,
      'paymentStatus': 'PENDING',
      'vehicleType': vehicleType,
    };
  }
}

class _FlakyRideRequestApi extends _FakeMishwarApi {
  @override
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
    String bookingMode = 'FAST',
    int? customerProposedFare,
    String? idempotencyKey,
  }) async {
    requestRideCount += 1;
    idempotencyKeys.add(idempotencyKey);
    if (requestRideCount == 1) {
      throw DioException.connectionTimeout(
        timeout: const Duration(seconds: 5),
        requestOptions: RequestOptions(path: '/api/rides'),
      );
    }
    return {
      'id': 'ride-after-retry',
      'status': 'SEARCHING_DRIVER',
      'bookingMode': bookingMode,
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
      'fare': {'grossFare': customerProposedFare ?? 1200},
      'paymentMethod': paymentMethod,
      'paymentStatus': 'PENDING',
      'vehicleType': vehicleType,
    };
  }
}

void main() {
  testWidgets('customer ride booking screen starts', (tester) async {
    final api = _FakeMishwarApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(api)],
        child: const MaterialApp(
          home: CustomerHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.byType(CustomerHomeScreen), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('customer navigation reaches trips and profile tabs',
      (tester) async {
    final api = _FakeMishwarApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(api)],
        child: const MaterialApp(
          home: CustomerHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.tap(find.text('الرحلات'));
    await tester.pumpAndSettle();
    expect(find.text('سجل الرحلات والفواتير'), findsOneWidget);

    await tester.tap(find.text('حسابي'));
    await tester.pumpAndSettle();
    expect(find.text('حساب العميل والإعدادات'), findsOneWidget);

    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('customer booking validates bidding fare and shows vehicles',
      (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final api = _FakeMishwarApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(api)],
        child: const MaterialApp(
          home: CustomerHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('سيارة اقتصادية'), findsWidgets);
    expect(find.text('دراجة نارية'), findsOneWidget);

    await tester.scrollUntilVisible(
      find.text('مشوار بالعروض').last,
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('مشوار بالعروض').last);
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'السعر المقترح'), 'abc');
    await tester.scrollUntilVisible(
      find.text('اطلب مشواراً'),
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('اطلب مشواراً'));
    await tester.pump();

    expect(api.requestRideCount, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('customer reuses ride idempotency key after weak connection',
      (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final api = _FlakyRideRequestApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(api)],
        child: const MaterialApp(
          home: CustomerHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.scrollUntilVisible(
      find.text('اطلب مشواراً'),
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('اطلب مشواراً'));
    await tester.pump();
    expect(api.requestRideCount, 1);

    await tester.scrollUntilVisible(
      find.text('اطلب مشواراً'),
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('اطلب مشواراً'));
    await tester.pump();

    expect(api.requestRideCount, 2);
    expect(api.idempotencyKeys.first, isNotNull);
    expect(api.idempotencyKeys[1], api.idempotencyKeys.first);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
