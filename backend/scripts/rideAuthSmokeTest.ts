process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'demo';
process.env.API_TOKEN = 'qa-smoke-token';

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

const request = async <T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    role?: string;
    uid?: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    token?: string;
    omitToken?: boolean;
  } = {}
): Promise<{ status: number; json: ApiResponse<T> }> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-user-id': options.uid || (options.role === 'DRIVER' ? 'qa_driver' : 'qa_customer'),
    'x-user-role': options.role || 'CUSTOMER',
    ...(options.idempotencyKey ? { 'x-idempotency-key': options.idempotencyKey } : {})
  };
  if (!options.omitToken) headers.authorization = `Bearer ${options.token || 'qa-smoke-token'}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, json: await response.json() as ApiResponse<T> };
};

const ridePayload = {
  customerName: 'QA Customer',
  customerPhone: '771234567',
  pickup: { latitude: 15.3694, longitude: 44.191, addressName: 'Pickup' },
  destination: { latitude: 15.347, longitude: 44.206, addressName: 'Destination' },
  vehicleType: 'ECONOMY',
  passengerCount: 1,
  airConditioningRequired: false,
  paymentMethod: 'CASH'
};

const createRide = async (baseUrl: string, uid: string, key: string): Promise<string> => {
  const ride = await request<Record<string, unknown>>(baseUrl, '/api/rides', {
    method: 'POST',
    role: 'CUSTOMER',
    uid,
    idempotencyKey: key,
    body: ridePayload
  });
  assert(ride.status === 200 && ride.json.success, 'ride creation failed');
  return String(ride.json.data.id);
};

const main = async (): Promise<void> => {
  const { default: app } = await import('../src/server');
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const missingToken = await request<Record<string, unknown>>(baseUrl, '/api/rides/latest', { omitToken: true });
    assert(missingToken.status === 401, 'missing token should be rejected');

    const invalidToken = await request<Record<string, unknown>>(baseUrl, '/api/rides/latest', { token: 'wrong-token' });
    assert(invalidToken.status === 401, 'invalid token should be rejected');

    const customerOnDriverEndpoint = await request<Record<string, unknown>>(baseUrl, '/api/dispatch/incoming', {
      role: 'CUSTOMER',
      uid: 'qa_customer'
    });
    assert(customerOnDriverEndpoint.status === 403, 'wrong role should be rejected on driver endpoint');

    const adminFinanceDenied = await request<Record<string, unknown>>(baseUrl, '/api/admin/finance/summary', {
      role: 'CUSTOMER',
      uid: 'qa_customer'
    });
    assert(adminFinanceDenied.status === 403, 'customer should not access admin finance');

    const rideId = await createRide(baseUrl, 'qa_customer', 'qa-ride-auth-01');
    const accepted = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/accept`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'qa_driver',
      body: { driverName: 'QA Driver' }
    });
    assert(accepted.status === 200, 'ride acceptance failed');

    const duplicateAccept = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/accept`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'qa_driver_2',
      body: { driverName: 'Wrong Driver' }
    });
    assert(duplicateAccept.status === 409, 'duplicate accept protection failed');

    const unrelatedRead = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}`, {
      role: 'CUSTOMER',
      uid: 'unrelated_customer'
    });
    assert(unrelatedRead.status === 403, 'unrelated user should not read ride');

    const customerLocationUpdate = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/location`, {
      method: 'POST',
      role: 'CUSTOMER',
      uid: 'qa_customer',
      body: { latitude: 15.37, longitude: 44.2 }
    });
    assert(customerLocationUpdate.status === 403, 'customer should not update driver location');

    const started = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/start`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'qa_driver'
    });
    assert(started.status === 409, 'invalid state transition should fail before arrival');

    const arrived = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/arrived`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'qa_driver'
    });
    assert(arrived.status === 200, 'ride arrived failed');

    const startedAfterArrive = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/start`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'qa_driver'
    });
    assert(startedAfterArrive.status === 200, 'ride start failed');

    const completed = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/complete`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'qa_driver'
    });
    assert(completed.status === 200, 'ride complete failed');

    const arrivedAfterComplete = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/arrived`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'qa_driver'
    });
    assert(arrivedAfterComplete.status === 409, 'completed ride should reject older state transitions');

    const rideToCancel = await createRide(baseUrl, 'qa_cancel_customer', 'qa-ride-auth-cancel');
    const cancelled = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideToCancel}/cancel`, {
      method: 'POST',
      role: 'CUSTOMER',
      uid: 'qa_cancel_customer',
      body: { reason: 'qa cancel' }
    });
    assert(cancelled.status === 200, 'ride cancel failed');

    const riskDenied = await request<Record<string, unknown>>(baseUrl, '/api/admin/risk/cases', {
      role: 'CUSTOMER',
      uid: 'qa_customer'
    });
    assert(riskDenied.status === 403, 'non-admin risk investigation should be rejected');

    const safetyDenied = await request<Record<string, unknown>>(baseUrl, '/api/admin/safety/incidents', {
      role: 'CUSTOMER',
      uid: 'qa_customer'
    });
    assert(safetyDenied.status === 403, 'non-admin safety investigation should be rejected');

    console.log('Ride and auth smoke test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
