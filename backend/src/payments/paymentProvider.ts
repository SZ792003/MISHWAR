import { backendConfig } from '../config';
import { PaymentDomainError } from './paymentErrors';

export type ProviderCreatePaymentInput = {
  paymentId: string;
  rideId: string;
  amount: number;
  currency: string;
  customerId: string;
  idempotencyKey: string;
  requestId?: string;
};

export type ProviderRefundInput = {
  paymentId: string;
  refundId: string;
  providerTransactionId?: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  requestId?: string;
};

export type ProviderPaymentResult = {
  provider: string;
  providerTransactionId?: string;
  providerReference?: string;
  status: 'processing' | 'authorized' | 'paid' | 'failed';
  metadata?: Record<string, unknown>;
};

export type ProviderWebhookResult = {
  providerEventId: string;
  providerTransactionId?: string;
  providerReference?: string;
  status: 'paid' | 'failed' | 'cancelled' | 'processing';
  metadata?: Record<string, unknown>;
};

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: ProviderCreatePaymentInput): Promise<ProviderPaymentResult>;
  getPaymentStatus(providerTransactionId: string): Promise<ProviderPaymentResult>;
  verifyPayment(providerTransactionId: string): Promise<ProviderPaymentResult>;
  cancelPayment(providerTransactionId: string): Promise<ProviderPaymentResult>;
  refundPayment(input: ProviderRefundInput): Promise<ProviderPaymentResult>;
  verifyWebhookSignature(headers: Record<string, unknown>, body: unknown): Promise<boolean>;
  processWebhook(headers: Record<string, unknown>, body: unknown): Promise<ProviderWebhookResult>;
}

class NotConfiguredPaymentProvider implements PaymentProvider {
  readonly name = backendConfig.paymentProvider || 'unconfigured';

  async createPayment(): Promise<ProviderPaymentResult> {
    throw new PaymentDomainError(
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      'Payment provider credentials and official integration docs are required',
      503
    );
  }

  async getPaymentStatus(): Promise<ProviderPaymentResult> {
    throw new PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured', 503);
  }

  async verifyPayment(): Promise<ProviderPaymentResult> {
    throw new PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured', 503);
  }

  async cancelPayment(): Promise<ProviderPaymentResult> {
    throw new PaymentDomainError('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured', 503);
  }

  async refundPayment(): Promise<ProviderPaymentResult> {
    throw new PaymentDomainError('PAYMENT_PROVIDER_REFUND_NOT_CONFIGURED', 'Provider refund is not configured', 503);
  }

  async verifyWebhookSignature(): Promise<boolean> {
    return false;
  }

  async processWebhook(): Promise<ProviderWebhookResult> {
    throw new PaymentDomainError('INVALID_WEBHOOK_SIGNATURE', 'Webhook signature cannot be verified', 401);
  }
}

export const paymentProvider: PaymentProvider = new NotConfiguredPaymentProvider();
