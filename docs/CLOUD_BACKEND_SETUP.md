# MISHWAR — Cloud Backend Setup

هذه الوثيقة تخص TASK 07A. الهدف هو تجهيز Backend للاستضافة السحابية الآمنة بدون نشر فعلي من هذه المهمة.

## نتيجة التدقيق الحالية

### موجود

- Backend موجود في `backend`.
- Express + TypeScript.
- Firebase Admin SDK موجود.
- Dockerfile موجود في `backend/Dockerfile`.
- `/health` موجود.
- `/ready` موجود.
- `/metrics` موجود ومحمي في الأوضاع الصارمة عبر `METRICS_TOKEN`.
- CORS يعتمد على `ALLOWED_ORIGINS`.
- `TRUST_PROXY` مدعوم.
- Graceful shutdown موجود لـ `SIGTERM` و `SIGINT`.
- Logging موجود عبر `backend/src/logger.ts`.
- Metrics middleware موجود.
- Firestore persistence موجود في `backend/src/persistence.ts`.
- Dispatch persistent موجود للرحلات والعروض عند تفعيل Firestore.
- BIDDING persistent موجود لـ `rideBids` عند استخدام Firestore.
- Idempotency موجود للعمليات الحساسة.

### ناقص أو يحتاج ضبط قبل الاستضافة

- لا يوجد ملف إعداد خاص بمزود استضافة محدد مثل Cloud Run أو Render أو Railway.
- يجب إدخال Environment Variables في منصة الاستضافة يدوياً.
- يجب منع `ALLOWED_ORIGINS` من احتواء localhost في Pilot.
- يجب ضبط Service Account بصلاحيات محدودة.
- يجب اختبار `/ready` على بيئة Cloud قبل ربط التطبيقات.
- يجب مراجعة حدود الموارد والـ concurrency حسب مزود الاستضافة.

## المتغيرات المطلوبة في Pilot

لا تحفظ هذه القيم في Git. ضعها في Secret Manager أو إعدادات الاستضافة.

```env
NODE_ENV=production
APP_MODE=pilot
PORT=4000

USE_REAL_AUTH=true
USE_REAL_DATABASE=true
USE_REAL_PAYMENT=false
DIGITAL_PAYMENTS_ENABLED=false
PAYOUTS_ENABLED=false

FIREBASE_PROJECT_ID=<MISHWAR_PILOT_PROJECT_ID>
FIREBASE_STORAGE_BUCKET=<MISHWAR_PILOT_PROJECT_ID>.appspot.com

ALLOWED_ORIGINS=https://<customer-web-origin>,https://<driver-web-origin>
METRICS_TOKEN=<long-random-token>
TRUST_PROXY=1

MAP_PROVIDER=osm
GEOCODING_PROVIDER=<approved-provider>
ROUTING_PROVIDER=<approved-provider>
MAPS_API_KEY=
GEOCODING_API_KEY=<server-secret-if-required>
ROUTING_API_KEY=<server-secret-if-required>

SUPPORT_URL=
SUPPORT_EMAIL=
PRIVACY_POLICY_URL=
TERMS_URL=
```

مهم:

- لا تستخدم `API_TOKEN` كبديل للمصادقة في Pilot.
- لا تستخدم demo headers في Pilot.
- لا تستخدم `USE_REAL_DATABASE=false` في Pilot.
- لا تستخدم `USE_REAL_AUTH=false` في Pilot.
- لا تفعّل `USE_REAL_PAYMENT=true` قبل مراجعة دفع مستقلة.

## Firebase Admin Credentials

الأفضل في السحابة:

1. شغّل Backend على Cloud Run أو خدمة تدعم runtime service account.
2. اربط Service Account بالمشروع.
3. اترك `GOOGLE_APPLICATION_CREDENTIALS` فارغاً.
4. سيستخدم Firebase Admin SDK Application Default Credentials.

محلياً فقط:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\secure\mishwar\mishwar-pilot-service-account.json"
```

لا تضع ملف JSON داخل المشروع.

## صلاحيات Service Account المقترحة

ابدأ بأقل صلاحيات ممكنة:

- Firebase Authentication Admin للـ verify/set claims.
- Cloud Datastore User أو صلاحيات Firestore اللازمة للقراءة والكتابة.
- Firebase Cloud Messaging Sender إن كان إرسال الإشعارات من Admin SDK مطلوباً.

لا تعطِ Owner إلا مؤقتاً وبموافقة صريحة.

## تشغيل محلي يحاكي Pilot

بعد إعداد ADC محلياً:

```powershell
cd backend
$env:APP_MODE="pilot"
$env:NODE_ENV="production"
$env:USE_REAL_AUTH="true"
$env:USE_REAL_DATABASE="true"
$env:USE_REAL_PAYMENT="false"
$env:FIREBASE_PROJECT_ID="<MISHWAR_PILOT_PROJECT_ID>"
$env:FIREBASE_STORAGE_BUCKET="<MISHWAR_PILOT_PROJECT_ID>.appspot.com"
$env:ALLOWED_ORIGINS="https://<pilot-app-domain>"
$env:METRICS_TOKEN="<metrics-token>"
npm run validate:config
npm run typecheck
npm run build
npm run start:prod
```

تحقق:

```powershell
Invoke-WebRequest https://<pilot-api-domain>/health
Invoke-WebRequest https://<pilot-api-domain>/ready
Invoke-WebRequest https://<pilot-api-domain>/metrics -Headers @{ Authorization = "Bearer <metrics-token>" }
```

## Docker Build

الأمر المحلي:

```powershell
docker build -f backend/Dockerfile -t mishwar-backend:pilot .
```

تشغيل محلي للحاوية:

```powershell
docker run --rm -p 4000:4000 `
  -e NODE_ENV=production `
  -e APP_MODE=pilot `
  -e USE_REAL_AUTH=true `
  -e USE_REAL_DATABASE=true `
  -e USE_REAL_PAYMENT=false `
  -e FIREBASE_PROJECT_ID=<MISHWAR_PILOT_PROJECT_ID> `
  -e ALLOWED_ORIGINS=https://<pilot-origin> `
  -e METRICS_TOKEN=<metrics-token> `
  mishwar-backend:pilot
```

إذا احتجت ADC محلياً داخل Docker، استخدم mount لملف خارجي خارج Git.

## HTTPS

التطبيقات في وضع Pilot ترفض API غير HTTPS. يجب أن يكون Backend خلف:

- Cloud Run HTTPS URL، أو
- Load Balancer HTTPS، أو
- مزود استضافة يدعم TLS تلقائياً.

لا تستخدم HTTP في Pilot.

## CORS

في Pilot:

- لا تضف `localhost`.
- لا تضف `*`.
- أضف فقط أصول الويب الحقيقية إن وجدت.
- تطبيقات Android/iOS لا تعتمد على CORS بنفس طريقة المتصفح، لكن Web/لوحة الإدارة تحتاجه.

## Health / Ready / Metrics

- `/health`: فحص حياة بسيط.
- `/ready`: فحص Firebase/Auth/Firestore/Geo/Config.
- `/metrics`: محمي في الأوضاع الصارمة ويتطلب `METRICS_TOKEN`.

معيار القبول:

- `/health` يرجع `200`.
- `/ready` يرجع `200` و `status=ready`.
- `/metrics` بدون token يرجع `403` في Pilot.
- `/metrics` مع token صحيح يرجع `200`.

## Crash Recovery

الموجود حالياً:

- Graceful shutdown.
- Error middleware.
- Logging.

المطلوب من مزود الاستضافة:

- Auto restart.
- Health checks.
- Log retention.
- Alerting عند ارتفاع 5xx أو فشل `/ready`.
- حد أدنى instance واحد أثناء الاختبار المغلق إذا كان وقت الاستجابة مهماً.

## Persistent Dispatch

في Pilot يجب أن تكون الرحلات والعروض في Firestore:

- `APP_MODE=pilot`
- `USE_REAL_AUTH=true`
- `USE_REAL_DATABASE=true`
- المستخدمون يأتون من Firebase Auth وليس demo.

مؤشر جاهزية مهم:

- عند إعادة تشغيل الخادم لا تختفي الرحلات قيد البحث أو عروض الكباتن.
- القبول المزدوج يرجع `409`.
- اختيار عرضين في BIDDING يرجع نجاحاً واحداً فقط ورفضاً للثاني.

## حدود الموارد المقترحة للاختبار المغلق

ابدأ صغيراً:

- CPU: 1 vCPU.
- Memory: 512MiB إلى 1GiB.
- Max instances: 2 إلى 3.
- Concurrency: 20 إلى 40.
- Request timeout: 30s.
- Min instances: 0 أو 1 حسب الميزانية.

راقب:

- latency.
- Firestore reads/writes.
- 4xx/5xx.
- dispatch conflicts.
- payment/finance idempotency conflicts.

## أوامر تحقق قبل ربط التطبيقات

```powershell
cd backend
npm run typecheck
npm run lint
npm run validate:config
npm run scan:secrets
npm run build
```

اختبارات smoke محلية لا تثبت Firebase الحقيقي لأنها تعمل Demo غالباً:

```powershell
npm run qa:critical
```

اختبار نشر على Backend سحابي:

```powershell
$env:SMOKE_BASE_URL="https://<pilot-api-domain>"
npm run test:deploy-smoke
```

لا تعتبر الاختبار الحقيقي ناجحاً إلا إذا كان `APP_MODE=pilot` و `/ready` يؤكد Firestore/Auth.

## Go / No-Go

Go للاختبار المغلق فقط إذا:

- Backend HTTPS.
- `/ready` جاهز.
- Firebase Auth يعمل.
- Firestore persistence يعمل.
- لا يوجد demo fallback.
- القواعد والفهارس راجعتها ولم تنشرها عشوائياً.
- تطبيق العميل والكابتن مبنيان بـ `MISHWAR_APP_MODE=pilot`.
- كابتن غير معتمد لا يستطيع قبول أو إرسال عرض.

