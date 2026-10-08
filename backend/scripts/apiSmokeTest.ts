process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'demo';

export {};

type ApiResponse<T> = {
  success?: boolean;
  data?: T;
  status?: string;
  checks?: Record<string, boolean>;
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const main = async (): Promise<void> => {
  const { default: app } = await import('../src/server');
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${baseUrl}/health`);
    const healthJson = await health.json() as ApiResponse<Record<string, unknown>>;
    assert(health.status === 200, '/health should return 200');
    assert(healthJson.status === 'ok', '/health status should be ok');

    const ready = await fetch(`${baseUrl}/ready`);
    const readyJson = await ready.json() as ApiResponse<Record<string, unknown>>;
    assert(ready.status === 200, '/ready should return 200 in demo test mode');
    assert(readyJson.status === 'ready', '/ready status should be ready');
    assert(readyJson.checks?.geoProviderConfig === true, '/ready should validate geo config');

    console.log('API smoke test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
