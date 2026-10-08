# Payments Core

Task 5A establishes the production-oriented payment foundation for MISHWAR.

## Scope

Implemented:

- Cash payment confirmation.
- Wallet payment debit.
- Digital provider adapter interface.
- Payment records.
- Financial ledger foundation.
- Platform commission entries.
- Driver earning entries.
- Financial idempotency.
- Provider webhook entry point.
- Financial audit events.

Not implemented in Task 5A:

- Full payouts.
- Full settlement operations.
- Reconciliation dashboards.
- Refund administration.

These remain for Task 5B.

## Source Of Truth

The backend is the source of truth for payments. Flutter sends only:

- `rideId`
- `paymentMethod`

Flutter must not send a trusted fare amount. The backend reads the ride, validates ownership and state, and uses the fare stored on the ride.

## Money Representation

YER amounts are represented as integers. Shared money utilities live in:

```text
backend/src/payments/money.ts
```

The utility layer validates non-negative integer amounts and centralizes commission calculation.

## Payment Methods

The production payment domain uses:

- `cash`
- `wallet`
- `digital_provider`

Legacy uppercase app values such as `CASH`, `WALLET`, and `DIGITAL_PROVIDER` are normalized at the backend boundary.

## Cash Flow

1. Ride is completed.
2. Assigned driver confirms cash received.
3. Backend validates the assigned driver.
4. Backend validates ride status is `TRIP_COMPLETED`.
5. Backend reads the trusted fare from the ride.
6. Backend creates a payment record.
7. Backend creates financial transactions for ride payment, platform commission, and driver earning.
8. Backend writes audit events.
9. Duplicate confirmation is handled through idempotency and deterministic payment IDs.

Endpoint:

```text
POST /api/payments/cash/confirm
```

## Wallet Flow

1. Customer requests wallet payment.
2. Backend validates Firebase/demo identity according to runtime mode.
3. Backend validates ride ownership and completed status.
4. Backend reads the trusted ride fare.
5. Backend debits the wallet in a Firestore transaction in persistent mode.
6. Backend creates payment, financial ledger, commission, and driver earning records.
7. Backend writes audit events.
8. Duplicate requests do not debit twice.

Endpoint:

```text
POST /api/payments
```

## Digital Provider Architecture

The backend defines a provider interface in:

```text
backend/src/payments/paymentProvider.ts
```

The interface supports:

- `createPayment`
- `getPaymentStatus`
- `verifyPayment`
- `cancelPayment`
- `verifyWebhookSignature`
- `processWebhook`

No real provider API has been invented. Until official provider documentation and credentials are supplied, digital provider calls return:

```text
PAYMENT_PROVIDER_NOT_CONFIGURED
```

Provider integration architecture is production-ready, but live provider activation is pending official provider documentation and credentials.

## Webhooks

Webhook endpoint:

```text
POST /api/payments/webhooks/:provider
```

Webhook security rules:

- Invalid signatures are rejected.
- Duplicate provider event IDs are ignored safely.
- Provider secrets are never logged.
- The current unconfigured adapter rejects all callbacks because no official signature specification exists yet.

## Idempotency

Every money mutation requires `x-idempotency-key`.

Protected operations:

- Payment creation.
- Cash confirmation.
- Wallet debit.
- Platform commission creation.
- Driver earning creation.
- Provider webhook processing.

The backend also uses deterministic payment IDs per ride and method to prevent duplicate ledger movement if the client sends a different idempotency key.

## Ledger Foundation

Financial ledger entries are written to:

```text
financialTransactions
```

Each entry records:

- `id`
- `type`
- `amount`
- `currency`
- `rideId`
- `paymentId`
- `customerId`
- `driverId`
- `status`
- `idempotencyKey`
- `requestId`
- `createdAt`
- `completedAt`
- `source`
- `destination`
- `metadata`

This ledger is the foundation for Task 5B settlement and reconciliation.

## Commission And Driver Earnings

Commission is centralized in the backend money utility. The default platform commission rate is 10%.

For a 2000 YER fare:

- Platform commission: 200 YER.
- Driver earning: 1800 YER.

The actual calculation uses the trusted ride fare and central utility, not Flutter.

## Firestore Security

Normal users cannot write:

- `payments`
- `financialTransactions`
- `wallets`
- `walletTransactions`
- `paymentWebhookEvents`

Money movement must go through the backend with Firebase Admin SDK.

## Flutter Flow

Customer Flutter app:

- Chooses cash, wallet, or digital provider.
- Shows payment status.
- Starts wallet or digital provider payment after trip completion.
- Does not calculate fare, commission, or earnings.

Driver Flutter app:

- Confirms cash received after completed cash rides.
- Does not update wallet balances or earnings locally.

## Environment Variables

```text
PAYMENT_PROVIDER=
PAYMENT_PROVIDER_BASE_URL=
PAYMENT_PROVIDER_CLIENT_ID=
PAYMENT_PROVIDER_CLIENT_SECRET=
PAYMENT_PROVIDER_WEBHOOK_SECRET=
```

No real secrets are committed.

## Production Vs Demo

Demo mode is kept for local testing only.

Production payment requirements:

- Firebase ID token.
- Trusted backend identity.
- Backend authorization.
- Firestore persistence.
- Audit.
- Idempotency.
- No mock provider success.
- No demo headers for real money movement.

## Task 5B Financial Operations

The payment core is extended by `backend/src/payments/financialOperationsService.ts`.

It adds reconciliation, payout reservations, driver finance summaries, settlement reports, full and partial refunds, financial adjustments, and financial risk flag foundations. See `docs/FINANCIAL_OPERATIONS.md` for operational details.
