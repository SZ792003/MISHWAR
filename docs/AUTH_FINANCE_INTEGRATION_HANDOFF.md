# MISHWAR - AUTH & FINANCE INTEGRATION HANDOFF

تاريخ التسليم: 2026-10-11

## مبدأ عام

تم تجهيز الكود المحلي للمصادقة والمالية بدون نشر Firebase أو Backend وبدون تفعيل دفع حقيقي. أي تفعيل Production يجب أن يتم بواسطة مهندس السحابة بعد مراجعة القواعد والأسرار.

## Auth Contracts

### Flutter

- Demo mode يستخدم رؤوس:
  - `x-user-id`
  - `x-user-role`
- Pilot/Production يستخدم:
  - `Authorization: Bearer <Firebase ID Token>`
- مصدر التوكن:
  - `firebaseIdToken()` في `apps/mishwar_shared/lib/mobile_runtime.dart`
  - أو `MISHWAR_FIREBASE_ID_TOKEN` للاختبارات اليدوية فقط.

### Backend

- `POST /api/auth/passenger/complete`
- `GET /api/me`
- `PATCH /api/me`
- `GET /api/driver/me`
- `PATCH /api/driver/me`
- `POST /api/kyc/documents`
- `POST /api/admin/drivers/:uid/approve`
- `POST /api/admin/drivers/:uid/reject`
- `POST /api/admin/users/:uid/revoke-sessions`
- `POST /api/admin/users/:uid/block`
- `POST /api/admin/users/:uid/suspend`
- `POST /api/admin/users/:uid/unblock`

## Required Firebase Setup

- تفعيل Firebase Auth Phone Provider للتطبيقين.
- إضافة Android package IDs للتطبيقين وربط SHA-1/SHA-256.
- إنشاء Custom Claims من Backend فقط، وليس من Flutter.
- تفعيل Firestore collections المطلوبة:
  - `users`
  - `passengers`
  - `drivers`
  - `driverKyc`
  - `auditLogs`
  - `deviceTokens`
- مراجعة قواعد Firestore بحيث لا يقرأ مستخدم بيانات مستخدم آخر.
- اختبار session revocation بعد الحظر/الإيقاف.

## Finance API Endpoints

### Driver

- `GET /api/driver/finance`
- `GET /api/driver/earnings`
- `GET /api/driver/payouts`
- `POST /api/driver/payouts`

### Payments

- `POST /api/payments`
- `POST /api/payments/ride`
- `POST /api/payments/cash/confirm`
- `GET /api/rides/:rideId/payment`
- `GET /api/payments/:id`
- `POST /api/payments/:id/refunds`
- `POST /api/payments/webhooks/:provider`

### Admin Finance

- `GET /api/admin/finance/summary`
- `GET /api/admin/finance/settlements`
- `GET /api/admin/finance/drivers?driverId=...`
- `GET /api/admin/finance/drivers/:driverId`
- `POST /api/admin/finance/drivers/:driverId/commission-settlements`
- `POST /api/admin/finance/demo-digital-payments`
- `GET /api/admin/finance/reconciliation`
- `GET /api/admin/finance/payouts`
- `POST /api/admin/finance/payouts/:id/approve`
- `POST /api/admin/finance/payouts/:id/complete`
- `POST /api/admin/finance/refunds/:id/approve`
- `POST /api/admin/finance/adjustments`

## Required Headers

- كل العمليات المالية الحساسة تحتاج:
  - `Authorization: Bearer <Firebase ID Token>` في Pilot/Production.
  - `x-idempotency-key` في عمليات الدفع، cash confirm، settlement، refund، payout.
- Webhook المحاكى للاختبار فقط:
  - `x-mishwar-simulated-signature: SIMULATED-<PAYMENT_PROVIDER_WEBHOOK_SECRET>`

## Environment Variables

بدون أسرار حقيقية في Git:

```env
APP_MODE=pilot
USE_REAL_AUTH=true
USE_REAL_DATABASE=true
USE_REAL_PAYMENT=false
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
GOOGLE_APPLICATION_CREDENTIALS=
DIGITAL_PAYMENTS_ENABLED=false
PAYOUTS_ENABLED=false
PAYMENT_PROVIDER=
PAYMENT_PROVIDER_BASE_URL=
PAYMENT_PROVIDER_CLIENT_ID=
PAYMENT_PROVIDER_CLIENT_SECRET=
PAYMENT_PROVIDER_WEBHOOK_SECRET=
MIN_PAYOUT_AMOUNT=1000
MAX_PAYOUT_AMOUNT=500000
DAILY_PAYOUT_LIMIT=1000000
MAX_REFUND_AMOUNT=500000
```

للاختبارات المحلية فقط:

```env
APP_MODE=demo
USE_REAL_PAYMENT=false
PAYMENT_PROVIDER=mishwar_simulated
PAYMENT_PROVIDER_WEBHOOK_SECRET=local-test-only
```

## Firestore Collections المالية المتوقعة

- `payments`
- `financialTransactions`
- `wallets`
- `walletTransactions`
- `driverPayouts`
- `refunds`
- `idempotencyKeys`
- `paymentWebhookEvents`
- `settlements`
- `financialAdjustments`
- `financialRiskFlags`
- `reconciliationIssues`
- `driverCommissionAccounts`
- `auditLogs`

## قواعد أمان مطلوبة

- Flutter لا يكتب `financialTransactions`, `wallets`, `driverPayouts`, `refunds`, أو `driverCommissionAccounts` مباشرة.
- العملاء والكباتن يقرأون فقط بياناتهم المصرح بها.
- FINANCE/ADMIN فقط يملكون مسارات الإدارة المالية عبر Backend.
- Webhooks لا تقبل إلا بتوقيع موثق من المزود.
- لا يتم تفعيل `DIGITAL_PAYMENTS_ENABLED` أو `PAYOUTS_ENABLED` قبل اعتماد المزود وسياسة التشغيل.

## اختبارات يجب تنفيذها قبل Pilot الحقيقي

- OTP صحيح/خاطئ/منتهي على جهاز حقيقي.
- حظر/إيقاف حساب وسحب جلساته ثم التحقق من رفض API.
- اعتماد كابتن KYC ومنع غير المعتمد من قبول الرحلات.
- رحلة نقدية كاملة على جهازين مع Firestore persistence.
- تأكيد الدفع النقدي وظهور مديونية 10%.
- Settlement جزئية وكاملة على Firestore.
- Webhook provider حقيقي مع replay/duplicate.
- Reconciliation بعد بيانات فعلية في Firestore.

## قرار التسليم

الكود المحلي جاهز لتسليم مهندس السحابة والدفع. لا يوجد تفعيل دفع حقيقي أو نشر. جاهزية Pilot مشروطة بإكمال Firebase الحقيقي واختبارات الأجهزة وFirestore Transactions.
