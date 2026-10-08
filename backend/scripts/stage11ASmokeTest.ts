process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'demo';
process.env.API_TOKEN = 'qa-smoke-token';
process.env.SUPPORT_URL = '';
process.env.SUPPORT_EMAIL = '';
process.env.PRIVACY_POLICY_URL = '';
process.env.TERMS_URL = '';

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
    'content-type': 'application/json',
    authorization: 'Bearer qa-smoke-token',
    'x-user-id': options.uid || (options.role === 'DRIVER' ? 'stage11_driver' : 'stage11_customer'),
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
  customerName: 'QA Customer',
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
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  try {
    const config = await request<Record<string, unknown>>(baseUrl, '/api/config/public');
    assert(config.status === 200 && config.json.data.privacyPolicyUrl === null, 'legal URLs should be config-driven without fake defaults');

    const ticket = await request<Record<string, unknown>>(baseUrl, '/api/support/tickets', {
      method: 'POST',
      uid: 'stage11_customer',
      body: {
        category: 'account_review',
        subject: 'Account review',
        message: 'I need help reviewing an account restriction.'
      }
    });
    assert(ticket.status === 200 && ticket.json.success, 'support ticket create failed');
    const ticketId = String(ticket.json.data.id);

    const ownTicket = await request<Record<string, unknown>>(baseUrl, `/api/support/tickets/${ticketId}`, {
      uid: 'stage11_customer'
    });
    assert(ownTicket.status === 200, 'user should read own ticket');

    const unrelatedTicket = await request<Record<string, unknown>>(baseUrl, `/api/support/tickets/${ticketId}`, {
      uid: 'other_customer'
    });
    assert(unrelatedTicket.status === 403, 'unrelated user should be denied');

    const supportList = await request<unknown[]>(baseUrl, '/api/admin/support/tickets', {
      role: 'SUPPORT_REVIEWER',
      uid: 'support_qa'
    });
    assert(supportList.status === 200 && Array.isArray(supportList.json.data), 'support reviewer access failed');

    const restrictedSupport = await request<Record<string, unknown>>(baseUrl, '/api/support/tickets', {
      method: 'POST',
      uid: 'restricted_customer',
      body: {
        category: 'account_review',
        subject: 'Restricted account',
        message: 'Please review my account.'
      }
    });
    assert(restrictedSupport.status === 200, 'restricted account support path should remain available in demo foundation');

    const deletion = await request<Record<string, unknown>>(baseUrl, '/api/privacy/requests', {
      method: 'POST',
      uid: 'stage11_customer',
      body: { type: 'account_deletion', message: 'Please review deletion.' }
    });
    assert(deletion.status === 200 && deletion.json.data.status === 'pending_review', 'account deletion request failed');

    const duplicateDeletion = await request<Record<string, unknown>>(baseUrl, '/api/privacy/requests', {
      method: 'POST',
      uid: 'stage11_customer',
      body: { type: 'account_deletion' }
    });
    assert(duplicateDeletion.status === 409, 'duplicate deletion request should be controlled');

    const accessRequest = await request<Record<string, unknown>>(baseUrl, '/api/privacy/requests', {
      method: 'POST',
      uid: 'stage11_customer',
      body: { type: 'data_access' }
    });
    assert(accessRequest.status === 200, 'data access privacy request failed');

    const analytics = await request<Record<string, unknown>>(baseUrl, '/api/analytics/events', {
      method: 'POST',
      uid: 'stage11_customer',
      body: {
        name: 'ride_request_started',
        parameters: {
          vehicle_type: 'ECONOMY',
          phone: '771234567',
          latitude: 15.3694,
          walletBalance: 1000
        }
      }
    });
    const parameters = analytics.json.data.parameters as Record<string, unknown>;
    assert(analytics.status === 200 && parameters.vehicle_type === 'ECONOMY', 'analytics event failed');
    assert(parameters.phone === undefined && parameters.latitude === undefined && parameters.walletBalance === undefined, 'analytics PII was not stripped');

    const ride = await request<Record<string, unknown>>(baseUrl, '/api/rides', {
      method: 'POST',
      uid: 'stage11_customer',
      idempotencyKey: 'stage11-rating-ride',
      body: ridePayload
    });
    assert(ride.status === 200, 'ride creation failed');
    const rideId = String(ride.json.data.id);

    const earlyRating = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/rating`, {
      method: 'POST',
      uid: 'stage11_customer',
      body: { stars: 5, reasons: ['behavior'] }
    });
    assert(earlyRating.status === 409, 'rating should require completed ride');

    const accepted = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/accept`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'stage11_driver',
      body: { driverName: 'Stage 11 Driver' }
    });
    assert(accepted.status === 200, 'accept failed');
    assert((await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/arrived`, { method: 'POST', role: 'DRIVER', uid: 'stage11_driver' })).status === 200, 'arrived failed');
    assert((await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/start`, { method: 'POST', role: 'DRIVER', uid: 'stage11_driver' })).status === 200, 'start failed');
    assert((await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/complete`, { method: 'POST', role: 'DRIVER', uid: 'stage11_driver' })).status === 200, 'complete failed');

    const rating = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/rating`, {
      method: 'POST',
      uid: 'stage11_customer',
      body: { stars: 5, reasons: ['behavior', 'navigation'], comment: 'Good ride' }
    });
    assert(rating.status === 200 && rating.json.data.stars === 5, 'completed ride rating failed');
    const ratingId = rating.json.data.id;

    const duplicateRating = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/rating`, {
      method: 'POST',
      uid: 'stage11_customer',
      body: { stars: 4, reasons: ['navigation'] }
    });
    assert(duplicateRating.status === 200 && duplicateRating.json.data.id === ratingId && duplicateRating.json.data.stars === 4, 'duplicate rating should update controlled record');

    console.log('Stage 11A smoke test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
