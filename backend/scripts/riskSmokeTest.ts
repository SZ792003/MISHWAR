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
      'x-user-id': options.uid || (options.role === 'DRIVER' ? 'risk_driver' : 'risk_customer'),
      'x-user-role': options.role || 'CUSTOMER',
      ...(options.idempotencyKey ? { 'x-idempotency-key': options.idempotencyKey } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, json: await response.json() as ApiResponse<T> };
};

const createRide = async (baseUrl: string, uid: string, key: string): Promise<string> => {
  const ride = await request<Record<string, unknown>>(baseUrl, '/api/rides', {
    method: 'POST',
    role: 'CUSTOMER',
    uid,
    idempotencyKey: key,
    body: {
      customerName: 'Risk Customer',
      customerPhone: '771234567',
      pickup: { latitude: 15.3694, longitude: 44.191, addressName: 'Pickup' },
      destination: { latitude: 15.347, longitude: 44.206, addressName: 'Destination' },
      vehicleType: 'ECONOMY',
      passengerCount: 1,
      airConditioningRequired: false,
      paymentMethod: 'CASH'
    }
  });
  assert(ride.status === 200 && ride.json.success, 'ride create failed');
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
    const financial = await request<{ signal: { id: string }; riskCase: { id: string; evidence: Array<{ type: string; id: string }> } }>(baseUrl, '/api/admin/risk/signals', {
      method: 'POST',
      role: 'FINANCE',
      uid: 'finance_01',
      body: {
        type: 'duplicate_refund_attempt',
        severity: 'high',
        userId: 'risk_customer',
        paymentId: 'payment_risk_01',
        financialRiskFlagId: 'financial_flag_01',
        source: 'financial',
        manualReviewRequired: true,
        metadata: { reason: 'duplicate refund smoke' }
      }
    });
    assert(financial.status === 200, 'financial risk signal failed');
    assert(financial.json.data.riskCase.evidence.some((item) => item.type === 'financial_risk_flag'), 'financial flag reference missing');

    const duplicate = await request<{ deduplicated: boolean; signal: { id: string } }>(baseUrl, '/api/admin/risk/signals', {
      method: 'POST',
      role: 'FINANCE',
      uid: 'finance_01',
      body: {
        type: 'duplicate_refund_attempt',
        severity: 'high',
        userId: 'risk_customer',
        paymentId: 'payment_risk_01',
        financialRiskFlagId: 'financial_flag_01',
        source: 'financial',
        manualReviewRequired: true
      }
    });
    assert(duplicate.status === 200 && duplicate.json.data.deduplicated, 'duplicate signal deduplication failed');

    const geo = await request<{ riskCase: { id: string } }>(baseUrl, '/api/admin/risk/signals', {
      method: 'POST',
      role: 'OPS_MANAGER',
      uid: 'ops_01',
      body: {
        type: 'suspicious_location_pattern',
        severity: 'medium',
        driverId: 'risk_driver',
        rideId: 'ride_geo_01',
        source: 'geo',
        metadata: { policy: 'pattern_review_not_confirmed_fraud' }
      }
    });
    assert(geo.status === 200, 'geo risk signal failed');

    for (let index = 0; index < 3; index += 1) {
      const rideId = await createRide(baseUrl, 'cancel_customer', `risk-cancel-${index}`);
      const cancelled = await request<Record<string, unknown>>(baseUrl, `/api/rides/${rideId}/cancel`, {
        method: 'POST',
        role: 'CUSTOMER',
        uid: 'cancel_customer',
        body: { reason: 'smoke cancellation' }
      });
      assert(cancelled.status === 200, `cancellation ${index} failed`);
    }

    const safetyRideId = await createRide(baseUrl, 'safety_reporter', 'risk-safety-ride');
    await request<Record<string, unknown>>(baseUrl, `/api/rides/${safetyRideId}/accept`, {
      method: 'POST',
      role: 'DRIVER',
      uid: 'reported_driver',
      body: { driverName: 'Reported Driver' }
    });
    const safety = await request<Record<string, unknown>>(baseUrl, `/api/rides/${safetyRideId}/safety/incidents`, {
      method: 'POST',
      role: 'CUSTOMER',
      uid: 'safety_reporter',
      body: { type: 'unsafe_driver', severity: 'high', description: 'reported subject smoke only' }
    });
    assert(safety.status === 200, 'safety integration failed');

    const unauthorized = await request<Record<string, unknown>>(baseUrl, '/api/admin/risk/cases', {
      role: 'CUSTOMER',
      uid: 'risk_customer'
    });
    assert(unauthorized.status === 403, 'unauthorized risk access should be rejected');

    const cases = await request<Array<{ id: string; subjectUserId: string; notes: unknown[]; actions: unknown[] }>>(baseUrl, '/api/admin/risk/cases', {
      role: 'OPS_MANAGER',
      uid: 'ops_01'
    });
    assert(cases.status === 200 && cases.json.data.length >= 4, 'risk cases list failed');
    assert(cases.json.data.some((item) => item.subjectUserId === 'cancel_customer'), 'repeated cancellation case missing');
    assert(cases.json.data.some((item) => item.subjectUserId === 'reported_driver'), 'reported subject risk case missing');
    assert(!cases.json.data.some((item) => item.subjectUserId === 'safety_reporter'), 'reporter should not be punished by safety integration');

    const caseId = financial.json.data.riskCase.id;
    const assigned = await request<Record<string, unknown>>(baseUrl, `/api/admin/risk/cases/${caseId}/assign`, {
      method: 'POST',
      role: 'OPS_MANAGER',
      uid: 'ops_01',
      body: { assignedTo: 'reviewer_01' }
    });
    assert(assigned.status === 200, 'reviewer assignment failed');

    const noted = await request<{ notes: unknown[] }>(baseUrl, `/api/admin/risk/cases/${caseId}/note`, {
      method: 'POST',
      role: 'OPS_MANAGER',
      uid: 'ops_01',
      body: { note: 'append-only smoke note' }
    });
    assert(noted.status === 200 && noted.json.data.notes.length === 1, 'append-only notes failed');

    for (const action of ['temporary_suspension', 'full_block', 'unblock']) {
      const enforced = await request<Record<string, unknown>>(baseUrl, `/api/admin/risk/cases/${caseId}/enforcement`, {
        method: 'POST',
        role: 'ADMIN',
        uid: 'admin_01',
        body: { action, reason: `smoke ${action}` }
      });
      assert(enforced.status === 200, `${action} enforcement failed`);
    }

    const resolved = await request<Record<string, unknown>>(baseUrl, `/api/admin/risk/cases/${caseId}/resolve`, {
      method: 'POST',
      role: 'OPS_MANAGER',
      uid: 'ops_01',
      body: { resolution: 'smoke reviewed' }
    });
    assert(resolved.status === 200, 'risk case resolve failed');

    const audit = await request<Array<{ eventType: string }>>(baseUrl, '/api/admin/risk/audit-events', {
      role: 'OPS_MANAGER',
      uid: 'ops_01'
    });
    assert(audit.status === 200 && audit.json.data.some((item) => item.eventType === 'RISK_SIGNAL_CREATED'), 'risk audit event missing');

    const metrics = await fetch(`${baseUrl}/metrics`);
    const metricsJson = await metrics.json() as { counters: Record<string, number> };
    assert(metricsJson.counters.risk_signals_total >= 4, 'risk signal metric missing');
    assert(metricsJson.counters.risk_actions_total >= 3, 'risk action metric missing');
    assert(metricsJson.counters.risk_cases_resolved_total >= 1, 'risk resolved metric missing');

    console.log('Risk smoke test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
