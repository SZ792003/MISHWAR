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
        'totalRideCount': 0,
        'totalRideGross': 0,
        'totalEarnings': 0,
        'totalPlatformCommission': 0,
        'totalCommissionCollected': 0,
        'outstandingCommissionDebt': 0,
        'totalPaidOut': 0,
        'currency': 'YER',
        'payouts': <dynamic>[],
        'recentTransactions': <dynamic>[],
        'settlements': <dynamic>[],
      };
}

class _BiddingRideApi extends _FakeMishwarApi {
  var bidSubmissions = 0;

  @override
  Future<Map<String, dynamic>?> incomingRide() async => {
        'id': 'ride-bid-1',
        'status': 'SEARCHING_DRIVER',
        'bookingMode': 'BIDDING',
        'customerName': 'عميل مشوار',
        'customerProposedFare': 5000,
        'serverEstimatedFare': 5400,
        'biddingExpiresAt': DateTime.now()
            .toUtc()
            .add(const Duration(minutes: 4))
            .toIso8601String(),
        'pickup': {
          'latitude': 15.3694,
          'longitude': 44.1910,
          'addressName': 'موقع الانطلاق',
        },
        'destination': {
          'latitude': 15.3470,
          'longitude': 44.2060,
          'addressName': 'الوجهة',
        },
        'fare': {'grossFare': 5400},
        'paymentMethod': 'CASH',
        'paymentStatus': 'PENDING',
        'vehicleType': 'ECONOMY',
      };

  @override
  Future<Map<String, dynamic>> submitRideBid({
    required String rideId,
    required int amount,
    int etaMinutes = 8,
  }) async {
    bidSubmissions += 1;
    return {
      'id': 'bid-1',
      'rideId': rideId,
      'amount': amount,
      'etaMinutes': etaMinutes,
    };
  }
}

class _FastRideActionApi extends _FakeMishwarApi {
  var acceptCalls = 0;

  @override
  Future<Map<String, dynamic>?> incomingRide() async => {
        'id': 'ride-fast-1',
        'status': 'SEARCHING_DRIVER',
        'bookingMode': 'FAST',
        'customerName': 'عميل مشوار',
        'pickup': {
          'latitude': 15.3694,
          'longitude': 44.1910,
          'addressName': 'موقع الانطلاق',
        },
        'destination': {
          'latitude': 15.3470,
          'longitude': 44.2060,
          'addressName': 'الوجهة',
        },
        'fare': {'grossFare': 5400},
        'paymentMethod': 'CASH',
        'paymentStatus': 'PENDING',
        'vehicleType': 'ECONOMY',
      };

  @override
  Future<Map<String, dynamic>> rideAction(
    String rideId,
    String action, {
    String? driverName,
    String? reason,
    String? actorRole,
  }) async {
    if (action == 'accept') {
      acceptCalls += 1;
      await Future<void>.delayed(const Duration(milliseconds: 80));
    }
    return {
      'id': rideId,
      'status': 'DRIVER_ASSIGNED',
      'bookingMode': 'FAST',
      'driverId': 'driver-test',
      'driverName': driverName ?? 'كابتن مشوار',
      'pickup': {
        'latitude': 15.3694,
        'longitude': 44.1910,
        'addressName': 'موقع الانطلاق',
      },
      'destination': {
        'latitude': 15.3470,
        'longitude': 44.2060,
        'addressName': 'الوجهة',
      },
      'fare': {'grossFare': 5400},
      'paymentMethod': 'CASH',
      'paymentStatus': 'PENDING',
      'vehicleType': 'ECONOMY',
    };
  }
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

  testWidgets('driver cannot submit duplicate bid for same ride',
      (tester) async {
    final api = _BiddingRideApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(api)],
        child: const MaterialApp(
          home: DriverHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.scrollUntilVisible(
      find.text('إرسال العرض'),
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('إرسال العرض'));
    await tester.pump();
    expect(find.text('تم إرسال عرضك للعميل'), findsOneWidget);

    await tester.scrollUntilVisible(
      find.text('إرسال العرض'),
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('إرسال العرض'));
    await tester.pump();
    expect(find.text('لديك عرض مرسل لهذا الطلب. اسحبه قبل إرسال عرض جديد.'),
        findsOneWidget);
    expect(api.bidSubmissions, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('driver accept button ignores rapid duplicate taps',
      (tester) async {
    final api = _FastRideActionApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiProvider.overrideWithValue(api)],
        child: const MaterialApp(
          home: DriverHomeScreen(routingEnabled: false),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    await tester.scrollUntilVisible(
      find.text('قبول الطلب'),
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('قبول الطلب'));
    await tester.tap(find.text('قبول الطلب'), warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 120));

    expect(api.acceptCalls, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
