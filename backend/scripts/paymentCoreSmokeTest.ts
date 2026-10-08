import { FareCalculation, Ride } from '../../packages/shared_types/src';
import { paymentService } from '../src/payments/paymentService';

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

const fare: FareCalculation = {
  baseFare: 1000,
  distanceKm: 3,
  distanceFare: 700,
  durationMinutes: 10,
  timeFare: 300,
  surgeMultiplier: 1,
  grossFare: 2000,
  platformCommission: 200,
  driverNetEarnings: 1800,
  currency: 'YER'
};

const ride = (patch: Partial<Ride> = {}): Ride => ({
  id: `ride_${Math.random().toString(36).substring(2, 8)}`,
  customerId: 'flutter_demo_customer',
  passengerId: 'flutter_demo_customer',
  customerName: 'Test Customer',
  customerPhone: '770000000',
  customerRating: 5,
  driverId: 'flutter_demo_driver',
  driverName: 'Test Driver',
  vehicleType: 'ECONOMY',
  status: 'TRIP_COMPLETED',
  pickup: { latitude: 15.3, longitude: 44.2, addressName: 'A' },
  destination: { latitude: 15.4, longitude: 44.3, addressName: 'B' },
  passengerCount: 1,
  airConditioningRequired: false,
  estimatedDistanceKm: 3,
  estimatedDurationMins: 10,
  fare,
  estimatedFare: fare.grossFare,
  finalFare: fare.grossFare,
  paymentMethod: 'WALLET',
  paymentStatus: 'PENDING',
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  ...patch
});

const customer = { uid: 'flutter_demo_customer', role: 'CUSTOMER' as const, authSource: 'demo' as const };
const driver = { uid: 'flutter_demo_driver', role: 'DRIVER' as const, authSource: 'demo' as const };
const otherDriver = { uid: 'other_driver', role: 'DRIVER' as const, authSource: 'demo' as const };
const actor = { actorUid: 'test', actorRole: 'SYSTEM', requestId: 'payment-smoke' };

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const expectError = async (code: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof Error && error.message === code || (error as { code?: string }).code === code, `Expected ${code}`);
    return;
  }
  throw new Error(`Expected ${code}`);
};

const tests: TestCase[] = [
  {
    name: 'wallet payment success',
    run: async () => {
      const sample = ride();
      const result = await paymentService.createRidePayment({
        user: customer,
        rideId: sample.id,
        method: 'wallet',
        idempotencyKey: `wallet_${sample.id}`,
        actor,
        usePersistentStore: false,
        demoRide: sample
      });
      assert(result.payment.amount === 2000, 'Trusted fare amount must come from ride');
      assert(result.payment.status === 'paid', 'Wallet payment should be paid');
      assert(result.financialTransactions.some((tx) => tx.type === 'platform_commission'), 'Commission missing');
      assert(result.financialTransactions.some((tx) => tx.type === 'driver_earning'), 'Driver earning missing');
    }
  },
  {
    name: 'duplicate wallet payment is safe',
    run: async () => {
      const sample = ride();
      const key = `dup_wallet_${sample.id}`;
      const first = await paymentService.createRidePayment({ user: customer, rideId: sample.id, method: 'wallet', idempotencyKey: key, actor, usePersistentStore: false, demoRide: sample });
      const second = await paymentService.createRidePayment({ user: customer, rideId: sample.id, method: 'wallet', idempotencyKey: key, actor, usePersistentStore: false, demoRide: sample });
      assert(first.payment.id === second.payment.id, 'Duplicate idempotency should return existing payment');
    }
  },
  {
    name: 'cash payment success',
    run: async () => {
      const sample = ride({ paymentMethod: 'CASH' });
      const result = await paymentService.confirmCashPayment({ user: driver, rideId: sample.id, idempotencyKey: `cash_${sample.id}`, actor, usePersistentStore: false, demoRide: sample });
      assert(result.payment.method === 'cash', 'Cash method expected');
      assert(result.payment.status === 'paid', 'Cash payment should be paid');
    }
  },
  {
    name: 'duplicate cash confirmation is safe',
    run: async () => {
      const sample = ride({ paymentMethod: 'CASH' });
      const first = await paymentService.confirmCashPayment({ user: driver, rideId: sample.id, idempotencyKey: `cash_dup_${sample.id}`, actor, usePersistentStore: false, demoRide: sample });
      const second = await paymentService.confirmCashPayment({ user: driver, rideId: sample.id, idempotencyKey: `cash_dup_${sample.id}`, actor, usePersistentStore: false, demoRide: sample });
      assert(first.payment.id === second.payment.id, 'Duplicate cash confirmation should return existing payment');
    }
  },
  {
    name: 'wrong driver cash confirmation rejected',
    run: async () => {
      const sample = ride({ paymentMethod: 'CASH' });
      await expectError('CASH_CONFIRM_FORBIDDEN', () => paymentService.confirmCashPayment({ user: otherDriver, rideId: sample.id, idempotencyKey: `bad_driver_${sample.id}`, actor, usePersistentStore: false, demoRide: sample }));
    }
  },
  {
    name: 'ride not completed rejected',
    run: async () => {
      const sample = ride({ status: 'TRIP_STARTED' });
      await expectError('RIDE_NOT_COMPLETED', () => paymentService.createRidePayment({ user: customer, rideId: sample.id, method: 'wallet', idempotencyKey: `not_done_${sample.id}`, actor, usePersistentStore: false, demoRide: sample }));
    }
  },
  {
    name: 'insufficient balance fails without paid status',
    run: async () => {
      const sample = ride({ fare: { ...fare, grossFare: 999999, platformCommission: 100000, driverNetEarnings: 899999 } });
      const result = await paymentService.createRidePayment({ user: customer, rideId: sample.id, method: 'wallet', idempotencyKey: `insufficient_${sample.id}`, actor, usePersistentStore: false, demoRide: sample });
      assert(result.payment.status === 'failed', 'Insufficient balance should fail');
    }
  },
  {
    name: 'digital provider missing config',
    run: async () => {
      const sample = ride({ paymentMethod: 'DIGITAL_PROVIDER' });
      await expectError('PAYMENT_PROVIDER_NOT_CONFIGURED', () => paymentService.createRidePayment({ user: customer, rideId: sample.id, method: 'digital_provider', idempotencyKey: `digital_${sample.id}`, actor, usePersistentStore: false, demoRide: sample }));
    }
  },
  {
    name: 'invalid webhook rejected',
    run: async () => {
      await expectError('INVALID_WEBHOOK_SIGNATURE', () => paymentService.processWebhook({ provider: 'unconfigured', headers: {}, body: {}, usePersistentStore: false }));
    }
  },
  {
    name: 'client amount ignored',
    run: async () => {
      const sample = ride();
      const result = await paymentService.createRidePayment({ user: customer, rideId: sample.id, method: 'wallet', idempotencyKey: `ignore_amount_${sample.id}`, actor, usePersistentStore: false, demoRide: sample });
      assert(result.payment.amount === sample.fare.grossFare, 'Payment amount must equal trusted ride fare');
    }
  }
];

for (const test of tests) {
  await test.run();
  console.log(`PASS ${test.name}`);
}
