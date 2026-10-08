# MISHWAR Financial Operations

This document covers the Task 5B financial layer. It extends the Task 5A payment core and does not replace it.

## Source of truth

The backend is the only trusted writer for production money movement. Flutter apps can request actions, but they do not compute balances or edit payment, ledger, refund, payout, settlement, or wallet balance documents directly.

The financial ledger is stored in `financialTransactions`. Wallet balances can exist as cached current balances, but reconciliation treats the ledger as the financial history.

## Ledger

Each financial movement should carry enough context for traceability:

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
- `source`
- `destination`
- `createdAt`
- `completedAt`
- `metadata`

## Driver balances

Driver finance is derived from ledger and payout records:

- `availableBalance`: completed driver earnings plus adjustments, minus paid payouts and active reservations.
- `pendingBalance`: pending driver earnings.
- `reservedBalance`: payout requests in `requested`, `approved`, or `processing`.
- `totalEarnings`: completed `driver_earning` ledger.
- `totalPlatformCommission`: completed `platform_commission` ledger.
- `totalPaidOut`: paid payout records.

This prevents a driver from requesting the same earnings twice.

## Payouts

Drivers request payouts through `POST /api/driver/payouts`. The backend verifies identity, driver role, account status, configured limits, trusted available balance, and idempotency.

Payout statuses:

- `requested`
- `approved`
- `processing`
- `paid`
- `failed`
- `cancelled`

Supported payout methods are adapter-safe only:

- `cash_office`
- `bank`
- `wallet`
- `digital_provider`

No bank API is invented here. Manual or provider completion is represented through admin finance APIs.

## Refunds

Customers can request refunds for their own payments. Finance admins approve and complete refunds.

Refund statuses:

- `requested`
- `approved`
- `processing`
- `completed`
- `failed`
- `rejected`

Refund reasons:

- `ride_cancelled`
- `duplicate_charge`
- `service_issue`
- `payment_error`
- `admin_adjustment`
- `other`

Full and partial refunds are supported. Payments store `refundedAmount`; the payment becomes `refunded` when fully refunded and `partially_refunded` when partly refunded.

Wallet refunds credit the customer wallet and write both a wallet transaction and a refund ledger transaction. Digital provider refunds use the provider adapter interface and fail safely when provider refund support is not configured.

## Reconciliation

`runFinancialReconciliation()` compares payments, ledger entries, wallet transactions and cached balances. It detects:

- paid payment without ledger
- ledger mismatch
- wallet balance mismatch
- duplicate transaction idempotency
- commission plus driver earning mismatch

Issues are written to `reconciliationIssues` for manual review. Sensitive mismatches are not auto-corrected.

## Settlements

Settlement reports can be generated for `daily`, `weekly`, or `custom` periods. Reports include:

- `grossRideAmount`
- `cashCollected`
- `walletCollected`
- `digitalCollected`
- `driverGrossEarnings`
- `platformCommission`
- `refunds`
- `payouts`
- `adjustments`
- `netSettlement`

## Financial adjustments

Admins must not directly edit `wallet.balance`. Adjustments are represented by `financialAdjustments` plus a `financialTransactions` ledger entry and audit event.

Adjustment types:

- `adjustment_credit`
- `adjustment_debit`

## Risk flags

Task 5B adds a foundation only, not a fraud engine. Supported flag types include:

- `duplicate_refund_attempt`
- `excessive_refund_attempt`
- `rapid_payout_requests`
- `repeated_failed_payment`
- `wallet_balance_mismatch`
- `provider_status_mismatch`
- `ledger_mismatch`

## APIs

Driver:

- `GET /api/driver/finance`
- `GET /api/driver/earnings`
- `GET /api/driver/payouts`
- `POST /api/driver/payouts`

Customer:

- `GET /api/payments/:id`
- `POST /api/payments/:id/refunds`

Admin finance:

- `GET /api/admin/finance/summary`
- `GET /api/admin/finance/settlements`
- `GET /api/admin/finance/reconciliation`
- `GET /api/admin/finance/payouts`
- `POST /api/admin/finance/payouts/:id/approve`
- `POST /api/admin/finance/payouts/:id/complete`
- `POST /api/admin/finance/refunds/:id/approve`
- `POST /api/admin/finance/adjustments`

## Compliance foundation

This is a technical compliance foundation only. Final legal/regulatory compliance requires review with the selected payment provider, bank, wallet operator, and applicable Yemeni legal/regulatory requirements before production launch.

Live digital payment provider activation is pending official API documentation, commercial agreement, and production credentials.
