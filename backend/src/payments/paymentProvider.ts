import { backendConfig, isStrictBackend } from '../config';
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
  status: 'processing' | 'authorized' | 'paid' | 'failed' | 'cancelled';
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

class SimulatedPaymentProvider implements PaymentProvider {
  readonly name = 'mishwar_simulated';

  async createPayment(input: ProviderCreatePaymentInput): Promise<ProviderPaymentResult> {
    return {
      provider: this.name,
      providerTransactionId: `sim_tx_${input.paymentId}`,
      providerReference: `SIMULATED-${input.idempotencyKey}`,
      status: 'processing',
      metadata: {
        simulationOnly: true,
        amount: input.amount,
        currency: input.currency,
        rideId: input.rideId
      }
    };
  }

  async getPaymentStatus(providerTransactionId: string): Promise<ProviderPaymentResult> {
    return {
      provider: this.name,
      providerTransactionId,
      status: 'processing',
      metadata: { simulationOnly: true }
    };
  }

  async verifyPayment(providerTransactionId: string): Promise<ProviderPaymentResult> {
    return {
      provider: this.name,
      providerTransactionId,
      status: 'paid',
      metadata: { simulationOnly: true, verifiedBy: 'mock_provider' }
    };
  }

  async cancelPayment(providerTransactionId: string): Promise<ProviderPaymentResult> {
    return {
      provider: this.name,
      providerTransactionId,
      status: 'cancelled',
      metadata: { simulationOnly: true }
    };
  }

  async refundPayment(input: ProviderRefundInput): Promise<ProviderPaymentResult> {
    return {
      provider: this.name,
      providerTransactionId: input.providerTransactionId,
      providerReference: `SIMULATED-REFUND-${input.idempotencyKey}`,
      status: 'processing',
      metadata: {
        simulationOnly: true,
        refundId: input.refundId,
        amount: input.amount,
        currency: input.currency
      }
    };
  }

  async verifyWebhookSignature(headers: Record<string, unknown>): Promise<boolean> {
    const expectedSecret = backendConfig.paymentProviderWebhookSecret;
    if (!expectedSecret) return false;
    const signature = String(
      headers['x-mishwar-simulated-signature'] ||
        headers['X-Mishwar-Simulated-Signature'] ||
        ''
    );
    return signature === `SIMULATED-${expectedSecret}`;
  }

  async processWebhook(_headers: Record<string, unknown>, body: unknown): Promise<ProviderWebhookResult> {
    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const providerEventId = String(payload.providerEventId || payload.eventId || '');
    const status = String(payload.status || 'processing').toLowerCase();
    if (!providerEventId) {
      throw new PaymentDomainError('INVALID_WEBHOOK_PAYLOAD', 'Simulated webhook event id is required', 400);
    }
    if (!['paid', 'failed', 'cancelled', 'processing'].includes(status)) {
      throw new PaymentDomainError('INVALID_WEBHOOK_PAYLOAD', 'Unsupported simulated webhook status', 400);
    }
    return {
      providerEventId,
      providerTransactionId: typeof payload.providerTransactionId === 'string' ? payload.providerTransactionId : undefined,
      providerReference: typeof payload.providerReference === 'string' ? payload.providerReference : undefined,
      status: status as ProviderWebhookResult['status'],
      metadata: { simulationOnly: true }
    };
  }
}

const canUseSimulatedProvider = (): boolean => {
  const provider = backendConfig.paymentProvider.trim().toLowerCase();
  return ['mock', 'simulated', 'mock_simulated', 'mishwar_simulated'].includes(provider) &&
    !backendConfig.useRealPayment &&
    !isStrictBackend();
};

export const paymentProvider: PaymentProvider = canUseSimulatedProvider()
  ? new SimulatedPaymentProvider()
  : new NotConfiguredPaymentProvider();
