type LogLevel = 'info' | 'warn' | 'error';

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

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return sensitiveKeyHints.some((hint) => normalized.includes(hint));
};

export const sanitizeLogMetadata = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeLogMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, entry]) => [key, sanitizeLogMetadata(entry)])
  );
};

export const logEvent = (
  level: LogLevel,
  event: string,
  metadata: Record<string, unknown> = {}
): void => {
  const safeMetadata = sanitizeLogMetadata(metadata) as Record<string, unknown>;
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

