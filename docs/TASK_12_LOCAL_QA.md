# MISHWAR — TASK 12 Local QA & Regression Testing

تاريخ التنفيذ: 2026-10-10 بتوقيت Asia/Aden.

## النتيجة المختصرة

تم تشغيل QA محلي شامل للعميل والكابتن والـ Backend بدون Firebase حقيقي. لم تظهر أخطاء محلية جديدة تحتاج إصلاحاً ضمن TASK 12.

الحالة العامة: PASS محلياً، مع عناصر BLOCKED تحتاج Firebase حقيقي أو جهاز Android فعلي.

## بيئة الاختبار

- Flutter محلي عبر `.codex/flutter-sdk`.
- Backend محلي في وضع `APP_MODE=demo` داخل smoke tests.
- لا يوجد Firestore حقيقي.
- لا يوجد جهاز Android فعلي.
- لم يتم تنفيذ commit أو push.

## أوامر Flutter

### Customer App

```powershell
cd apps/customer_app
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics analyze
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics test
```

النتائج:

```text
No issues found! (ran in 12.5s)
00:02 +2: All tests passed!
```

### Driver App

```powershell
cd apps/driver_app
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics analyze
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics test
```

النتائج:

```text
No issues found! (ran in 12.7s)
00:03 +2: All tests passed!
```

### mishwar_shared

```powershell
cd apps/mishwar_shared
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics test
```

النتيجة: BLOCKED

```text
Got socket error trying to find package firebase_messaging at https://pub.dev.
Failed to update packages.
```

السبب: اختبار الحزمة المشتركة يحتاج حل اعتماديات عبر `pub.dev`، والشبكة مقيدة. لم أعتبر هذا فشل اختبار منطقي.

## أوامر Backend

تم تشغيل:

```powershell
cd backend
npm.cmd run qa:critical
```

النتيجة: PASS

الأمر شغّل فعلياً:

- `typecheck`
- `lint`
- `validate:config`
- `scan:secrets`
- `test:api-smoke`
- `test:ride-auth`
- `test:dispatch`
- `test:bidding`
- `test:stage11a`
- `test:payments`
- `test:fcm`
- `test:geo`
- `test:safety`
- `test:risk`

مخرجات مهمة:

```text
Configuration validation passed
Secret scan passed
API smoke test passed
Ride and auth smoke test passed
Dispatch smoke test passed
Bidding smoke test passed
Stage 11A smoke test passed
PASS ... financial operations
PASS FCM notification hardening smoke tests
PASS geo service smoke tests
Safety smoke test passed
Risk smoke test passed
```

## جدول PASS/FAIL/BLOCKED

| البند | الحالة | الدليل |
|---|---:|---|
| تطبيق العميل يبدأ محلياً | PASS | Customer widget test |
| تطبيق الكابتن يبدأ محلياً | PASS | Driver widget test |
| تنقل العميل | PASS | اختبار تبويبات الرحلات وحسابي |
| تنقل الكابتن | PASS | اختبار تبويبات الرحلات والمالية وحسابي |
| Flutter analyze للعميل | PASS | No issues found |
| Flutter analyze للكابتن | PASS | No issues found |
| FAST | PASS | `test:bidding` ينشئ FAST ويؤكد أنه ما زال يعمل |
| BIDDING | PASS | `test:bidding` ينشئ BIDDING ويختار عرضاً واحداً |
| دورة رحلة Backend كاملة | PASS | `test:ride-auth` يقبل، يصل، يبدأ، يكمل |
| منع قبول مكرر | PASS | `test:dispatch` و`test:ride-auth` يرجعان 409 للقبول الثاني |
| تكرار الطلبات المالية | PASS | `test:payments` يغطي idempotency |
| انقطاع الإنترنت في Flutter | PARTIAL | واجهة OfflineSync موجودة، لكن لا يوجد اختبار شبكة جهاز حقيقي |
| انقطاع الإنترنت Backend/local | PASS | Offline queue يسمح فقط بالمسارات الآمنة؛ اختبار مباشر للجوال BLOCKED |
| عدم وجود كباتن | PARTIAL | UI يعرض حالات انتظار/لا يوجد كابتن، لكن لا يوجد smoke test مستقل لحالة no-driver النهائية |
| شاشة حسابي المالي | PASS | Driver widget navigation يصل إلى المالية |
| ظهور العمولات | PASS | `test:payments` و`financialOperationsSmokeTest` يغطيان عمولة 10% ومديونية الكابتن |
| KYC | PARTIAL | واجهة موجودة، لكن رفع/مراجعة حقيقية تحتاج Backend/Firebase/ملفات حقيقية |
| الدعم والخصوصية | PASS | `test:stage11a` يغطي support/privacy requests |
| أذونات GPS | BLOCKED | تحتاج جهاز Android أو emulator بإذن موقع فعلي |
| أخطاء الاتصال بالـ Backend | PARTIAL | HealthCard ورسائل Flutter موجودة، لكن فصل شبكة فعلي يحتاج جهاز/بيئة تشغيل |
| Secret Scan | PASS | `Secret scan passed` |
| Firebase الحقيقي | BLOCKED | خارج نطاق TASK 12 |
| Firestore الحقيقي | BLOCKED | خارج نطاق TASK 12 |
| تجربة جهازين حقيقيين | BLOCKED | تحتاج أجهزة/Backend عنوانه متاح للجوال |

## تغطية الوظائف المطلوبة

### العميل

- تشغيل الشاشة الرئيسية: PASS.
- واجهة الحجز والتنقل: PASS.
- FAST/BIDDING محلياً عبر Backend smoke: PASS.
- اختيار عرض واحد ومنع التكرار: PASS.
- أخطاء الاتصال وحالات الانتظار: PARTIAL لأن الاختبار الفعلي يحتاج قطع شبكة/Backend runtime.

### الكابتن

- تشغيل الشاشة الرئيسية: PASS.
- التنقل للرحلات والمالية والحساب: PASS.
- قبول/رفض/استرجاع رحلة نشطة عبر Backend smoke: PASS.
- شاشة حسابي المالي: PASS بالواجهة، وPASS منطقياً في Backend finance tests.
- KYC والدعم: PARTIAL للواجهة، وPASS للدعم/الخصوصية عبر Backend.

### الرحلات

- FAST: PASS.
- BIDDING: PASS.
- قبول ذري ومنع كابتنين: PASS.
- إعادة استرجاع الرحلة بعد reconnect على مستوى Backend: PASS في `test:dispatch`.
- دورة رحلة كاملة: PASS في `test:ride-auth`.

### المالية

- عمولة 10%: PASS.
- ديون الكباتن للرحلات النقدية: PASS.
- التسويات الجزئية/الكاملة: PASS.
- تكرار العمليات المالية: PASS.
- لا توجد أموال حقيقية مفعلة.

## ملاحظات مهمة

- كل نتائج Backend smoke تعمل في demo/local mode ولا تثبت جاهزية Production أو Firebase.
- نتائج Flutter widget tests تستخدم mocks ولا تثبت رحلة Firebase حقيقية.
- `mishwar_shared` tests بقيت BLOCKED بسبب قيود الشبكة/الاعتماديات.
- لم أعدل Firebase أو إعدادات الاستضافة.
- لم أجد خطأ محلياً مؤكداً يحتاج إصلاحاً ضمن TASK 12.

## اختبارات تحتاج Firebase أو جهاز حقيقي

- تسجيل دخول Firebase Phone Auth الحقيقي.
- Firestore Rules وعزل بيانات المستخدمين.
- FCM الحقيقي على جهاز Android.
- أذونات GPS الحقيقية وسيناريو رفض الإذن من إعدادات النظام.
- تجربة رحلة بين جوال عميل وجوال كابتن.
- اختبار Backend URL غير localhost على شبكة الجوال.
- اختبار KYC بملفات/روابط حقيقية وسياسة مراجعة Admin.

## تقييم TASK 12

TASK 12 مكتمل محلياً. النظام يجتاز اختبارات Flutter المتاحة واختبارات Backend الحرجة وSecret Scan. لا يجوز اعتبار هذه النتائج إثبات Production؛ المرحلة التالية تحتاج Pilot حقيقي مع Firebase وAndroid devices.
