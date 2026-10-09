import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mishwar_driver/main.dart';
import 'package:mishwar_shared/mishwar_api.dart';

class _FakeMishwarApi extends MishwarApi {
  @override
  Future<Map<String, dynamic>> health() async => {
        'service': 'Test API',
        'status': 'ONLINE',
      };

  @override
  Future<Map<String, dynamic>?> incomingRide() async => null;

  @override
  Future<Map<String, dynamic>> driverFinance() async => {
        'availableBalance': 0,
        'pendingBalance': 0,
        'reservedBalance': 0,
        'totalEarnings': 0,
        'totalPaidOut': 0,
        'currency': 'YER',
        'payouts': <dynamic>[],
        'recentTransactions': <dynamic>[],
      };
}

void main() {
  testWidgets('driver home screen starts', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(_FakeMishwarApi())],
        child: const MaterialApp(
          home: DriverHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.byType(DriverHomeScreen), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('driver navigation reaches rides, finance, and account tabs',
      (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(_FakeMishwarApi())],
        child: const MaterialApp(
          home: DriverHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.tap(find.text('الرحلات'));
    await tester.pumpAndSettle();
    expect(find.text('سجل الرحلات'), findsOneWidget);

    await tester.tap(find.text('المالية'));
    await tester.pumpAndSettle();
    expect(find.text('حسابي المالي'), findsWidgets);

    await tester.tap(find.text('حسابي'));
    await tester.pumpAndSettle();
    expect(find.text('كابتن مشوار'), findsWidgets);

    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
