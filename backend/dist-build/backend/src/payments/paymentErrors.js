"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asPaymentError = exports.PaymentDomainError = void 0;
class PaymentDomainError extends Error {
    code;
    statusCode;
    details;
    constructor(code, message = code, statusCode = 400, details) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}
exports.PaymentDomainError = PaymentDomainError;
const asPaymentError = (error) => {
    if (error instanceof PaymentDomainError)
        return error;
    const code = error instanceof Error ? error.message : 'PAYMENT_ERROR';
    const statusByCode = {
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
exports.asPaymentError = asPaymentError;
