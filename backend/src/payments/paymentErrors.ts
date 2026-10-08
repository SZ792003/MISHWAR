export class PaymentDomainError extends Error {
  constructor(
    public code: string,
    message = code,
    public statusCode = 400,
    public details?: unknown
  ) {
    super(message);
  }
}

export const asPaymentError = (error: unknown): PaymentDomainError => {
  if (error instanceof PaymentDomainError) return error;
  const code = error instanceof Error ? error.message : 'PAYMENT_ERROR';
  const statusByCode: Record<string, number> = {
    PAYMENT_PROVIDER_NOT_CONFIGURED: 503,
    PAYMENT_NOT_FOUND: 404,
    RIDE_NOT_FOUND: 404,
    PAYMENT_FORBIDDEN: 403,
    RIDE_FORBIDDEN: 403,
    CASH_CONFIRM_FORBIDDEN: 403,
    RIDE_NOT_COMPLETED: 409,
    PAYMENT_ALREADY_COMPLETED: 409,
    INSUFFICIENT_FUNDS: 402,
    INVALID_WEBHOOK_SIGNATURE: 401,
    DUPLICATE_WEBHOOK: 200,
    TRUSTED_FARE_UNAVAILABLE: 409,
    NEGATIVE_BALANCE_PREVENTED: 409
  };
  return new PaymentDomainError(code, code, statusByCode[code] || 400);
};
