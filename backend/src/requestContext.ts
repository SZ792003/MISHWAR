import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { logEvent } from './logger';

const validRequestId = /^[A-Za-z0-9_.:-]{8,80}$/;

export type RequestWithContext = Request & {
  requestId?: string;
};

export const requestContextMiddleware = (req: RequestWithContext, res: Response, next: NextFunction): void => {
  const incoming = req.headers['x-request-id'];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = candidate && validRequestId.test(candidate) ? candidate : randomUUID();
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);
    logEvent(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
      requestId,
      method: req.method,
      route: req.route?.path || req.path,
      statusCode: res.statusCode,
      durationMs
    });
  });

  next();
};

