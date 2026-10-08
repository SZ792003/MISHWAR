const baseUrl = (process.env.SMOKE_BASE_URL || process.env.STAGING_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const getJson = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; json: T }> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const json = await response.json() as T;
  return { status: response.status, json };
};

const main = async (): Promise<void> => {
  const health = await getJson<{ status?: string }>('/health');
  assert(health.status === 200 && health.json.status === 'ok', '/health failed');

  const ready = await getJson<{ status?: string; checks?: Record<string, boolean> }>('/ready');
  assert(ready.status === 200 && ready.json.status === 'ready', '/ready failed');

  const version = await getJson<{ service?: string; version?: string }>('/version');
  assert(version.status === 200 && version.json.service === 'mishwar-backend', '/version failed');

  const protectedEndpoint = await getJson<{ success?: boolean; error?: { code?: string } }>('/api/admin/finance/summary');
  assert([401, 403].includes(protectedEndpoint.status), 'admin endpoint should reject missing privileged auth');

  console.log('Deployment smoke test passed');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
