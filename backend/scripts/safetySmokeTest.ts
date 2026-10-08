process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'demo';

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
  } = {}
): Promise<{ status: number; json: ApiResponse<T> }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-user-id': options.uid || (options.role === 'DRIVER' ? 'flutter_demo_driver' : 'flutter_demo_customer'),
      'x-user-role': options.role || 'CUSTOMER',
      ...(options.idempotencyKey ? { 'x-idempotency-key': options.idempotencyKey } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, json: await response.json() as ApiResponse<T> };
};

const main = async (): Promise<void> => {
  const { default: app } = await import('../src/server');
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const rideRes = await request<Record<string, unknown>>(baseUrl, '/api/rides', {
      method: 'POST',
      role: 'CUSTOMER',
      idempotencyKey: 'safety-smoke-ride',
      body: {
        customerName: 'Smoke Customer',
        customerPhone: '771234567',
        pickup: { latitude: 15.3694, longitude: 44.191, addressName: 'Pickup' },
        destination: { latitude: 15.347, longitude: 44.206, addressName: 'Destination' },
        vehicleType: 'ECONOMY',
        passengerCount: 1,
        airConditioningRequired: false,
        paymentMethod: 'CASH'
      }
    });
    assert(rideRes.status === 200 && rideRes.json.success, 'ride create failed');
    const rideId = String(rideRes.json.data.id);

    const sosRes = await request<{ incidentId: string }>(baseUrl, `/api/rides/${rideId}/sos`, {
      method: 'POST',
      role: 'CUSTOMER',
      body: { description: 'customer smoke SOS' }
    });
    assert(sosRes.status === 200 && sosRes.json.data.incidentId, 'customer SOS failed');

    const duplicateSos = await request<{ incidentId: string }>(baseUrl, `/api/rides/${rideId}/sos`, {
      method: 'POST',
      role: 'CUSTOMER',
      body: { description: 'duplicate customer smoke SOS' }
    });
    assert(duplicateSos.status === 200, 'duplicate SOS should be deduplicated successfully');
    assert(duplicateSos.json.data.incidentId === sosRes.json.data.incidentId, 'duplicate SOS did not return same incident');

    const unrelated = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/sos`, {
      method: 'POST',
      role: 'CUSTOMER',
      uid: 'unrelated_customer',
      body: { description: 'should fail' }
    });
    assert(unrelated.status === 403, 'unrelated user SOS should be rejected');

    const invalidRide = await request<Record<string, unknown>>(baseUrl, '/api/rides/missing_ride/sos', {
      method: 'POST',
      role: 'CUSTOMER',
      body: { description: 'missing ride' }
    });
    assert(invalidRide.status === 404, 'invalid ride should be rejected');

    await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/accept`, {
      method: 'POST',
      role: 'DRIVER',
      body: { driverName: 'Smoke Driver' }
    });
    const driverSos = await request<{ incidentId: string }>(baseUrl, `/api/rides/${rideId}/sos`, {
      method: 'POST',
      role: 'DRIVER',
      body: { description: 'driver smoke SOS' }
    });
    assert(driverSos.status === 200 && driverSos.json.data.incidentId, 'driver SOS failed');

    const ack = await request<Record<string, unknown>>(baseUrl, `/api/admin/safety/incidents/${sosRes.json.data.incidentId}/acknowledge`, {
      method: 'POST',
      role: 'DISPATCHER',
      uid: 'dispatcher_01',
      body: {}
    });
    assert(ack.status === 200, 'dispatcher acknowledge failed');

    const unauthorizedAck = await request<Record<string, unknown>>(baseUrl, `/api/admin/safety/incidents/${driverSos.json.data.incidentId}/acknowledge`, {
      method: 'POST',
      role: 'CUSTOMER',
      body: {}
    });
    assert(unauthorizedAck.status === 403, 'unauthorized acknowledge should fail');

    const signal = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/safety/signals`, {
      method: 'POST',
      role: 'DRIVER',
      body: { type: 'significant_route_deviation', metadata: { smoke: true } }
    });
    assert(signal.status === 200, 'route deviation safety signal failed');

    console.log('Safety smoke test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
