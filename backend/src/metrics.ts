import { Request, Response, NextFunction } from 'express';

type HttpMetric = {
  method: string;
  route: string;
  statusClass: string;
  count: number;
  errorCount: number;
  durationMs: {
    count: number;
    total: number;
    max: number;
  };
};

const counters: Record<string, number> = {};
const httpMetrics = new Map<string, HttpMetric>();
const startedAt = new Date().toISOString();

const incrementCounter = (name: string, value = 1): void => {
  counters[name] = (counters[name] || 0) + value;
};

const routeLabel = (req: Request): string => {
  const route = req.route as { path?: string } | undefined;
  if (route?.path) return String(route.path);
  return req.path.replace(/[A-Za-z0-9_-]{12,}/g, ':id');
};

export const metrics = {
  increment: incrementCounter,
  observeHttp(req: Request, res: Response, durationMs: number): void {
    const method = req.method;
    const route = routeLabel(req);
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    const key = `${method} ${route} ${statusClass}`;
    const existing = httpMetrics.get(key) || {
      method,
      route,
      statusClass,
      count: 0,
      errorCount: 0,
      durationMs: { count: 0, total: 0, max: 0 }
    };
    existing.count += 1;
    if (res.statusCode >= 400) existing.errorCount += 1;
    existing.durationMs.count += 1;
    existing.durationMs.total += durationMs;
    existing.durationMs.max = Math.max(existing.durationMs.max, durationMs);
    httpMetrics.set(key, existing);

    incrementCounter('http_requests_total');
    if (res.statusCode >= 400) incrementCounter('http_errors_total');
    if (res.statusCode >= 400 && res.statusCode < 500) incrementCounter('http_4xx_total');
    if (res.statusCode >= 500) incrementCounter('http_5xx_total');
  },
  snapshot() {
    return {
      service: 'mishwar-backend',
      startedAt,
      generatedAt: new Date().toISOString(),
      counters: { ...counters },
      http: Array.from(httpMetrics.values()).map((metric) => ({
        ...metric,
        durationMs: {
          count: metric.durationMs.count,
          avg: metric.durationMs.count === 0 ? 0 : Math.round(metric.durationMs.total / metric.durationMs.count),
          max: metric.durationMs.max
        }
      }))
    };
  }
};

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    metrics.observeHttp(req, res, Math.round(durationMs));
  });
  next();
};

