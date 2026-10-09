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
  } = {}
): Promise<{ status: number; json: ApiResponse<T> }> => {
  const headers: Record<string, string> = {
    authorization: 'Bearer qa-smoke-token',
    'content-type': 'application/json',
    'x-user-id': options.uid || (options.role === 'DRIVER' ? 'qa_bid_driver' : 'qa_bid_customer'),
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
  customerName: 'QA Bidding Customer',
  customerPhone: '771234567',
  pickup: { latitude: 15.3694, longitude: 44.191, addressName: 'Pickup' },
  destination: { latitude: 15.347, longitude: 44.206, addressName: 'Destination' },
  vehicleType: 'ECONOMY',
  passengerCount: 1,
  airConditioningRequired: false,
  paymentMethod: 'CASH'
};

const main = async (): Promise<void> => {
  const { default: app } = await import('../src/server');
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const fastRide = await request<Record<string, unknown>>(baseUrl, '/api/rides', {
      method: 'POST',
      role: 'CUSTOMER',
      uid: 'bid_customer_fast',
      idempotencyKey: 'qa-fast-still-works',
      body: ridePayload
    });
    assert(fastRide.status === 200 && fastRide.json.data.bookingMode === 'FAST', 'FAST ride should still be created');
    const estimatedFare = Number(fastRide.json.data.estimatedFare || 5000);
    const bidLow = Math.round(estimatedFare * 0.95);
    const bidMid = Math.round(estimatedFare);
    const bidHigh = Math.round(estimatedFare * 1.05);
    await request<Record<string, unknown>>(baseUrl, `/api/rides/${fastRide.json.data.id}/cancel`, {
      method: 'POST',
      role: 'CUSTOMER',
      uid: 'bid_customer_fast',
      body: { reason: 'fast flow checked before bidding smoke' }
    });

    const biddingRide = await request<Record<string, unknown>>(baseUrl, '/api/rides', {
      method: 'POST',
      role: 'CUSTOMER',
      uid: 'bid_customer_1',
      idempotencyKey: 'qa-bidding-create',
      body: { ...ridePayload, bookingMode: 'BIDDING', customerProposedFare: bidLow }
    });
    assert(biddingRide.status === 200, 'BIDDING ride creation failed');
    const rideId = String(biddingRide.json.data.id);
    assert(biddingRide.json.data.biddingStatus === 'OPEN', 'BIDDING ride should open bidding');

    const incoming = await request<Record<string, unknown> | null>(baseUrl, '/api/dispatch/incoming', {
      role: 'DRIVER',
      uid: 'bid_driver_a'
    });
    assert(incoming.status === 200 && incoming.json.data?.id === rideId, 'driver should receive bidding request');

    const bidA = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/bids`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'bid_driver_a',
      idempotencyKey: 'bid-a',
      body: { amount: bidMid, etaMinutes: 7, driverName: 'Driver A' }
    });
    const bidB = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/bids`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'bid_driver_b',
      idempotencyKey: 'bid-b',
      body: { amount: bidLow, etaMinutes: 6, driverName: 'Driver B' }
    });
    const bidC = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/bids`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'bid_driver_c',
      idempotencyKey: 'bid-c',
      body: { amount: bidHigh, etaMinutes: 9, driverName: 'Driver C' }
    });
    assert([bidA.status, bidB.status, bidC.status].every((status) => status === 200), 'three driver bids should submit');

    const bids = await request<Array<Record<string, unknown>>>(baseUrl, `/api/rides/${rideId}/bids`, {
      role: 'CUSTOMER',
      uid: 'bid_customer_1'
    });
    assert(bids.status === 200 && bids.json.data.length === 3, 'customer should read three bids');

    const [selectB, selectA] = await Promise.all([
      request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/bids/${bidB.json.data.id}/select`, {
        method: 'POST',
        role: 'CUSTOMER',
        uid: 'bid_customer_1'
      }),
      request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/bids/${bidA.json.data.id}/select`, {
        method: 'POST',
        role: 'CUSTOMER',
        uid: 'bid_customer_1'
      })
    ]);
    const statuses = [selectB.status, selectA.status].sort();
    assert(statuses[0] === 200 && statuses[1] === 409, 'only one bid selection should win');
    const selectedRide = selectB.status === 200 ? selectB.json.data : selectA.json.data;
    assert(selectedRide.finalFare === bidLow, 'selected final fare should be trusted bid amount');
    assert((selectedRide.fare as Record<string, unknown>).platformCommission === Math.round(bidLow * 0.1), '10% commission should be based on final fare');

    const withdrawSelected = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/bids/${bidB.json.data.id}/withdraw`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'bid_driver_b'
    });
    assert(withdrawSelected.status === 409, 'selected bid cannot be withdrawn');

    console.log('Bidding smoke test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
