"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentProvider = void 0;
const config_1 = require("../config");
const paymentErrors_1 = require("./paymentErrors");
class NotConfiguredPaymentProvider {
    name = config_1.backendConfig.paymentProvider || 'unconfigured';
    async createPayment() {
        throw new paymentErrors_1.PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider credentials and official integration docs are required', 503);
    }
    async getPaymentStatus() {
        throw new paymentErrors_1.PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured', 503);
    }
    async verifyPayment() {
        throw new paymentErrors_1.PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured', 503);
    }
    async cancelPayment() {
        throw new paymentErrors_1.PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured', 503);
    }
    async refundPayment() {
        throw new paymentErrors_1.PaymentDomainError('PAYMENT_PROVIDER_REFUND_NOT_CONFIGURED', 'Provider refund is not configured', 503);
    }
    async verifyWebhookSignature() {
        return false;
    }
    async processWebhook() {
        throw new paymentErrors_1.PaymentDomainError('INVALID_WEBHOOK_SIGNATURE', 'Webhook signature cannot be verified', 401);
    }
}
exports.paymentProvider = new NotConfiguredPaymentProvider();
