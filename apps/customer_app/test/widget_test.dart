import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mishwar_customer/main.dart';
import 'package:mishwar_shared/geo_models.dart';
import 'package:mishwar_shared/mishwar_api.dart';

class _FakeMishwarApi extends MishwarApi {
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
}

void main() {
  testWidgets('customer ride booking screen starts', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(_FakeMishwarApi())],
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
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(_FakeMishwarApi())],
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
}
