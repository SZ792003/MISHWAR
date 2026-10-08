"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logEvent = exports.sanitizeLogMetadata = void 0;
const sensitiveKeyHints = [
    'authorization',
    'token',
    'otp',
    'password',
    'privatekey',
    'private_key',
    'serviceaccount',
    'credential',
    'card',
    'cvv',
    'secret',
    'nationalid',
    'documenturl',
    'imageurl'
];
const isSensitiveKey = (key) => {
    const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
    return sensitiveKeyHints.some((hint) => normalized.includes(hint));
};
const sanitizeLogMetadata = (value) => {
    if (Array.isArray(value))
        return value.map(exports.sanitizeLogMetadata);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !isSensitiveKey(key))
        .map(([key, entry]) => [key, (0, exports.sanitizeLogMetadata)(entry)]));
};
exports.sanitizeLogMetadata = sanitizeLogMetadata;
const logEvent = (level, event, metadata = {}) => {
    const safeMetadata = (0, exports.sanitizeLogMetadata)(metadata);
    const payload = {
        timestamp: new Date().toISOString(),
        level,
        event,
        ...safeMetadata
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
        console.error(line);
        return;
    }
    if (level === 'warn') {
        console.warn(line);
        return;
    }
    console.log(line);
};
exports.logEvent = logEvent;
