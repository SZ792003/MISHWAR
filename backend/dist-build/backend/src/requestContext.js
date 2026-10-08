"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestContextMiddleware = void 0;
const node_crypto_1 = require("node:crypto");
const logger_1 = require("./logger");
const validRequestId = /^[A-Za-z0-9_.:-]{8,80}$/;
const requestContextMiddleware = (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = candidate && validRequestId.test(candidate) ? candidate : (0, node_crypto_1.randomUUID)();
    req.requestId = requestId;
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);
        (0, logger_1.logEvent)(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
            requestId,
            method: req.method,
            route: req.route?.path || req.path,
            statusCode: res.statusCode,
            durationMs
        });
    });
    next();
};
exports.requestContextMiddleware = requestContextMiddleware;
