# MISHWAR Production Audit Logging

## What Is Logged

Audit logs are written by the trusted backend only to `auditLogs/{auditId}`.

`auditLogs` is the canonical production collection. `audit_logs` may appear in
Firestore rules only as a legacy deny/protect block so older clients cannot
write there; application code writes only to `auditLogs`.

Current production events:

- `RIDE_CREATED`
- `RIDE_ACCEPTED`
- `RIDE_DECLINED`
- `RIDE_CANCELLED`
- `RIDE_ARRIVED`
- `RIDE_STARTED`
- `RIDE_COMPLETED`
- `DRIVER_KYC_APPROVED`
- `DRIVER_KYC_REJECTED`
- `USER_BLOCKED`
- `USER_SUSPENDED`
- `USER_UNBLOCKED`
- `SESSION_REVOKED`
- `WALLET_DEBIT`
- `WALLET_CREDIT`
- `PAYMENT_RECORDED`

## Log Shape

Example:

```json
{
  "id": "audit_1790000000000_ab12cd",
  "eventType": "RIDE_ACCEPTED",
  "actorUid": "driver_123",
  "actorRole": "DRIVER",
  "targetType": "RIDE",
  "targetId": "ride_123",
  "rideId": "ride_123",
  "source": "BACKEND",
  "metadata": {
    "driverId": "driver_123",
    "previousStatus": "SEARCHING_DRIVER",
    "nextStatus": "DRIVER_ARRIVING"
  }
}
```

## Secrets Policy

Audit metadata is sanitized before writing. Do not log:

- Firebase ID tokens
- Authorization headers
- OTP codes
- private keys or service account credentials
- card secrets
- full national ID values
- sensitive document or image URLs

Use IDs or document references instead.

## Failure Policy

For production persistence, ride assignment and wallet/payment audit entries are written in the same Firestore transaction as the operation. If the audit write fails, the operation fails too.

Admin security and KYC actions also await audit logging. If audit logging is unavailable, the endpoint returns an error so operators do not silently perform sensitive actions without traceability.

Demo mode does not write production audit logs.
