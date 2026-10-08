# MISHWAR Production Operations

This runbook covers the backend operational endpoints added for production
persistence readiness.

## Endpoints

### `GET /health`

Liveness check. It only confirms that the backend process is running.
It does not query Firestore or any heavy dependency.

Use this for external uptime tools such as UptimeRobot, Cloud Monitoring,
Render, or Railway.

### `GET /ready`

Readiness check. It confirms that the backend can accept production traffic.

In strict modes (`pilot`, `staging`, `production`) or when real auth/database is
enabled, it checks:

- required Firebase Admin configuration is present
- Firebase Admin can initialize
- Firestore can read `system/schema`

If a required dependency is unavailable, the endpoint returns HTTP `503`.
Responses do not include credentials or private error details.

### `GET /metrics`

Returns JSON metrics. In demo/development it is public for local diagnostics.
In strict backend modes it requires `METRICS_TOKEN` via either:

```text
Authorization: Bearer <token>
```

or:

```text
X-Metrics-Token: <token>
```

Metrics intentionally avoid names, phone numbers, UID lists, ride coordinates,
wallet balances, KYC data, tokens, and document URLs.

## Important Metrics

- `http_requests_total`
- `http_errors_total`
- `http_4xx_total`
- `http_5xx_total`
- `rides_created_total`
- `rides_accepted_total`
- `rides_completed_total`
- `rides_cancelled_total`
- `ride_assignment_conflicts_total`
- `payment_operations_total`
- `wallet_operation_failures_total`
- `persistence_errors_total`
- `database_unavailable_total`

Driver online/offline counters are reserved for the future driver availability
API. They should not be inferred from realtime listeners in Task 3.

## Logs

The backend emits structured JSON logs to stdout/stderr. Hosting providers and
container platforms should collect those streams.

Example safe log:

```json
{"timestamp":"2026-10-04T12:00:00.000Z","level":"info","event":"http_request","requestId":"req-12345678","method":"GET","route":"/health","statusCode":200,"durationMs":4}
```

Sensitive keys are removed from structured log metadata. Do not log
authorization headers, Firebase ID tokens, OTPs, passwords, private keys, service
accounts, card/CVV details, KYC image URLs, or full national ID values.

## Request IDs

Every request receives an `X-Request-Id` response header. If the client sends a
valid `X-Request-Id`, the backend keeps it as a correlation ID. Otherwise, the
backend generates one.

The request ID is used in request logs and audit logs where applicable.

## If Readiness Fails

1. Check the `/ready` JSON `checks` object.
2. Verify `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and
   `FIREBASE_PRIVATE_KEY` are configured in the backend environment.
3. Verify the Firebase service account has Firestore access.
4. Run `cd backend && npm run migrate -- --dry-run` with Firebase Admin
   credentials available.
5. Confirm `system/schema` exists after migrations.
6. Check backend logs by `requestId` for `readiness_check_failed`.

## Firestore Check

The readiness endpoint reads `system/schema`. It does not scan a large
collection and does not create new documents during each check.

## Startup Checklist

- Firebase Admin configured
- Firestore available
- Migrations applied
- Backup plan configured
- `/health` returns `200`
- `/ready` returns `200`
- `/metrics` is available and protected in strict modes
- Audit logging writes to `auditLogs`

## Related Docs

- `docs/DATABASE_MIGRATIONS.md`
- `docs/BACKUP_RESTORE.md`
- `docs/AUDIT_LOGGING.md`

