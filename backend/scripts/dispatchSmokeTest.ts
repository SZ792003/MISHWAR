process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'demo';
process.env.API_TOKEN = 'qa-smoke-token';
process.env.DISPATCH_OFFER_TTL_MS = '120';

export {};

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message: string;
  error?: { code?: string } | null;
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const request = async <T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    role?: string;
    uid?: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {}
): Promise<{ status: number; json: ApiResponse<T> }> => {
  const headers: Record<string, string> = {
    authorization: 'Bearer qa-smoke-token',
    'content-type': 'application/json',
    'x-user-id': options.uid || (options.role === 'DRIVER' ? 'qa_driver' : 'qa_customer'),
    'x-user-role': options.role || 'CUSTOMER',
    ...(options.idempotencyKey ? { 'x-idempotency-key': options.idempotencyKey } : {})
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, json: await response.json() as ApiResponse<T> };
};

const ridePayload = {
  customerName: 'QA Dispatch Customer',
  customerPhone: '771234567',
  pickup: { latitude: 15.3694, longitude: 44.191, addressName: 'Pickup' },
  destination: { latitude: 15.347, longitude: 44.206, addressName: 'Destination' },
  vehicleType: 'ECONOMY',
  passengerCount: 1,
  airConditioningRequired: false,
  paymentMethod: 'CASH'
};

const createRide = async (baseUrl: string, key: string): Promise<string> => {
  const ride = await request<Record<string, unknown>>(baseUrl, '/api/rides', {
    method: 'POST',
    role: 'CUSTOMER',
    uid: `customer_${key}`,
    idempotencyKey: key,
    body: ridePayload
  });
  assert(ride.status === 200 && ride.json.success, 'ride creation failed');
  return String(ride.json.data.id);
};

const incomingRideId = async (baseUrl: string, driverId: string): Promise<string | null> => {
  const incoming = await request<Record<string, unknown> | null>(baseUrl, '/api/dispatch/incoming', {
    role: 'DRIVER',
    uid: driverId
  });
  assert(incoming.status === 200, `incoming ride failed for ${driverId}`);
  return incoming.json.data ? String((incoming.json.data as Record<string, unknown>).id) : null;
};

const main = async (): Promise<void> => {
  const { default: app } = await import('../src/server');
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const rideId = await createRide(baseUrl, 'qa-dispatch-ttl');

    const firstOffer = await incomingRideId(baseUrl, 'driver_a');
    assert(firstOffer === rideId, 'first driver should receive the searching ride');

    const duplicatePoll = await incomingRideId(baseUrl, 'driver_a');
    assert(duplicatePoll === rideId, 'same driver should recover the active offer instead of receiving a duplicate');

    const lockedForOther = await incomingRideId(baseUrl, 'driver_b');
    assert(lockedForOther === null, 'second driver should not receive an actively locked offer');

    await delay(180);
    const retryAfterExpiry = await incomingRideId(baseUrl, 'driver_b');
    assert(retryAfterExpiry === rideId, 'offer should be retried for another driver after expiry');

    const declined = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/decline`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'driver_b'
    });
    assert(declined.status === 200, 'driver decline failed');

    const declinedDriverReplay = await incomingRideId(baseUrl, 'driver_b');
    assert(declinedDriverReplay === null, 'declined driver should not receive the same ride again');

    const retryAfterDecline = await incomingRideId(baseUrl, 'driver_c');
    assert(retryAfterDecline === rideId, 'ride should be offered to another driver after decline');

    const [driverCAccept, driverDAccept] = await Promise.all([
      request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/accept`, {
        method: 'POST',
        role: 'DRIVER',
        uid: 'driver_c',
        body: { driverName: 'Driver C' }
      }),
      request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/accept`, {
        method: 'POST',
        role: 'DRIVER',
        uid: 'driver_d',
        body: { driverName: 'Driver D' }
      })
    ]);
    const statuses = [driverCAccept.status, driverDAccept.status].sort();
    assert(statuses[0] === 200 && statuses[1] === 409, 'concurrent accept should produce exactly one winner');

    const activeAfterReconnect = await request<Record<string, unknown> | null>(baseUrl, '/api/rides/active', {
      role: 'DRIVER',
      uid: driverCAccept.status === 200 ? 'driver_c' : 'driver_d'
    });
    assert(activeAfterReconnect.status === 200 && activeAfterReconnect.json.data, 'driver should recover active ride from backend after reconnect');

    console.log('Dispatch smoke test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
