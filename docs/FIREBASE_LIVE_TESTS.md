# MISHWAR — Firebase Live Test Plan

هذه الوثيقة تخص TASK 07A. لم يتم تشغيل Firebase حقيقي في هذه المهمة. هذه خطة اختبار مغلق يجب تنفيذها بعد إعداد Firebase وBackend السحابي.

## المتطلبات قبل بدء الاختبار

- مشروع Firebase الحالي `MISHWAR Pilot` جاهز.
- التطبيقان مسجلان:
  - `com.mishwar.customer`
  - `com.mishwar.driver`
- ملفات Firebase موجودة محلياً في التطبيقين.
- Backend منشور على HTTPS.
- Backend يعمل بـ:
  - `APP_MODE=pilot`
  - `USE_REAL_AUTH=true`
  - `USE_REAL_DATABASE=true`
  - `USE_REAL_PAYMENT=false`
- `/ready` يرجع `ready`.
- Firestore Rules و Indexes راجعتها على Emulator أو staging.
- لا توجد أسرار داخل Git.

## بيانات الاختبار

استخدم مستخدمين حقيقيين في Firebase Auth:

- عميل اختبار.
- كابتن اختبار غير معتمد.
- كابتن اختبار معتمد.
- مستخدم KYC Reviewer أو Admin.
- مستخدم Finance إن احتجت فحص الحسابات.

لا تستخدم:

- demo headers.
- `API_TOKEN`.
- أرصدة وهمية كأموال حقيقية.
- دفع إلكتروني حقيقي.

## أوامر بناء التطبيقات للاختبار

```powershell
cd apps/customer_app
flutter build apk --debug --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

```powershell
cd apps/driver_app
flutter build apk --debug --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

لـ Google Play closed testing استخدم AAB release:

```powershell
cd apps/customer_app
flutter build appbundle --release --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

```powershell
cd apps/driver_app
flutter build appbundle --release --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

## اختبارات Backend قبل الأجهزة

```powershell
cd backend
npm run validate:config
npm run typecheck
npm run lint
npm run scan:secrets
```

اختبار URL السحابي:

```powershell
$env:SMOKE_BASE_URL="https://<pilot-api-domain>"
npm run test:deploy-smoke
```

معايير القبول:

- `/health` يعمل.
- `/ready` يعمل.
- `/version` يعمل.
- endpoint إداري بدون صلاحية يرفض الطلب.

## اختبار 1: تسجيل عميل

الخطوات:

1. افتح تطبيق العميل.
2. تأكد أن التطبيق ليس في Demo.
3. سجل دخول برقم هاتف Firebase.
4. أكمل OTP.
5. افتح التطبيق بعد إعادة التشغيل.

المتوقع:

- Firebase Auth ينشئ user.
- ID Token يرسل إلى Backend.
- Backend لا يقبل demo headers.
- العميل يرى شاشة الحجز.
- لا يستطيع قراءة بيانات مستخدم آخر.

PASS إذا:

- تسجيل الدخول تم.
- `/api/rides/active` يعمل للمستخدم.
- Firestore لا يسمح بقراءة `users/{uid آخر}`.

## اختبار 2: تسجيل كابتن غير معتمد

الخطوات:

1. افتح تطبيق الكابتن.
2. سجل دخول برقم Firebase.
3. حاول استقبال/قبول رحلة قبل KYC.

المتوقع:

- Backend يرفض عمليات DRIVER الحساسة.
- الكود المتوقع: `DRIVER_KYC_NOT_APPROVED` أو رفض صلاحية مناسب.

PASS إذا:

- الكابتن غير المعتمد لا يقبل رحلة.
- لا يتم إنشاء `driverOperational.currentRideId`.

## اختبار 3: اعتماد كابتن

الخطوات:

1. أنشئ/راجع KYC للكابتن.
2. نفذ approval من Backend أو لوحة الإدارة.
3. امنح claim `DRIVER` عبر Backend فقط.
4. اطلب من الكابتن تسجيل الخروج والدخول.

المتوقع:

- ID Token الجديد يحتوي role `DRIVER`.
- `driverKyc/{uid}.kycStatus = approved`.
- الكابتن يستطيع استقبال الطلبات.

PASS إذا:

- `/api/dispatch/incoming` يعمل للكابتن المعتمد.
- الكابتن غير المعتمد ما زال مرفوضاً.

## اختبار 4: رحلة FAST كاملة

الخطوات:

1. العميل يحدد نقطة الانطلاق.
2. العميل يحدد الوجهة.
3. العميل يختار سيارة أو دراجة.
4. العميل يختار `مشوار سريع`.
5. العميل يضغط `اطلب مشواراً`.
6. الكابتن المعتمد يستقبل الطلب.
7. الكابتن يقبل.
8. الكابتن يرسل تحديثات موقع.
9. الكابتن يصل.
10. الكابتن يبدأ الرحلة.
11. الكابتن ينهي الرحلة.
12. الكابتن يؤكد الدفع النقدي.

المتوقع:

- الرحلة تنشأ عبر Backend.
- Firestore يعرض الحالة للطرفين.
- القبول الذري يمنع قبول كابتن ثان.
- الدفع النقدي لا يعتبر دفعاً إلكترونياً.
- عمولة 10% تسجل كمديونية/قيد مالي حسب نظام TASK 04.

PASS إذا:

- الحالة النهائية `TRIP_COMPLETED`.
- `paymentStatus` مناسب بعد تأكيد النقد.
- `platform_commission = round(finalFare * 0.10)`.
- لا يوجد قيد مالي مكرر عند إعادة إرسال تأكيد الدفع بنفس idempotency key.

## اختبار 5: BIDDING كامل

الخطوات:

1. العميل يختار `مشوار بالعروض`.
2. العميل يضع سعراً مقترحاً.
3. العميل يرسل الطلب.
4. كابتن A يرسل عرضاً.
5. كابتن B يرسل عرضاً.
6. العميل يشاهد العروض.
7. العميل يختار عرضاً واحداً.
8. حاول اختيار عرض ثان.
9. أكمل الرحلة.
10. أكد الدفع النقدي.

المتوقع:

- العروض تحفظ في `rideBids`.
- اختيار عرض واحد فقط ينجح.
- الاختيار الثاني يرجع `409`.
- `finalFare` يساوي سعر العرض المختار فقط.
- العميل لا يستطيع تعديل `finalFare` من التطبيق.
- العمولة 10% من `finalFare`.

PASS إذا:

- `selectedBidId` موجود.
- `driverId` هو صاحب العرض المختار.
- duplicate selection مرفوض.
- `platform_commission = round(finalFare * 0.10)`.

## اختبار 6: منع التلاعب بالسعر

الخطوات:

1. أنشئ رحلة BIDDING.
2. اختر عرضاً.
3. حاول من العميل إرسال طلب معدل يحتوي `finalFare` أو `platformCommission`.
4. حاول تعديل وثيقة Firestore مباشرة من client SDK.

المتوقع:

- Backend يتجاهل سعر العميل غير الموثوق.
- Firestore Rules تمنع تعديل المفاتيح المالية.

PASS إذا:

- لا يتغير `finalFare` إلا من Backend.
- لا تتغير `platformCommission`.
- لا توجد عملية مالية بدون Backend.

## اختبار 7: انقطاع الإنترنت

الخطوات:

1. ابدأ رحلة.
2. افصل الإنترنت عن جهاز الكابتن.
3. حاول تحديث الموقع.
4. أعد الاتصال.
5. افتح الرحلة من جديد.

المتوقع:

- تحديثات الموقع فقط يمكن التعامل معها كحالة offline/retry حسب السياسة.
- العمليات الحرجة مثل قبول الرحلة، بدء الرحلة، إنهائها، الدفع، اختيار العرض لا تدخل Offline Queue.
- بعد عودة الاتصال يتم استرجاع حالة الرحلة من Backend.

PASS إذا:

- لا يوجد قبول أو دفع مكرر.
- حالة الرحلة متطابقة بين الجهازين.

## اختبار 8: Firestore Rules

استخدم Emulator أو مشروع staging.

حالات يجب اختبارها:

- عميل لا يقرأ رحلة عميل آخر.
- كابتن لا يقرأ رحلة غير مسندة إليه إلا عبر Backend dispatch.
- مستخدم لا يكتب `payments`.
- مستخدم لا يكتب `financialTransactions`.
- مستخدم لا يكتب `driverCommissionAccounts`.
- مستخدم لا يكتب `rideBids`.
- Admin فقط يكتب السجلات المالية.

ملاحظة مهمة:

القواعد الحالية تسمح ببعض إنشاء/تحديث `rides` من العميل/الكابتن. إذا قررت أن Pilot Backend-only بالكامل، يجب تعديل القواعد قبل النشر.

## اختبار 9: FCM

الخطوات:

1. سجل دخول في العميل.
2. سجل دخول في الكابتن.
3. تحقق من إنشاء/تحديث `deviceTokens`.
4. أنشئ رحلة.
5. تحقق من وصول إشعار للكابتن.
6. اقبل الرحلة.
7. تحقق من وصول إشعار للعميل.

PASS إذا:

- token مربوط بالمستخدم الصحيح.
- لا يمكن لمستخدم تسجيل token لمستخدم آخر.
- الإشعارات لا تكشف بيانات مستخدم آخر.

## اختبار 10: Metrics و Logging

الخطوات:

1. افتح `/metrics` بدون token.
2. افتحه مع token صحيح.
3. نفذ رحلة.
4. راقب logs.

PASS إذا:

- بدون token يرجع `403`.
- مع token يرجع `200`.
- تظهر counters للرحلات والدفعات والتعارضات.
- لا تظهر أسرار أو ID Tokens كاملة في logs.

## تقرير الاختبار المطلوب بعد التنفيذ

سجل لكل حالة:

- الجهاز.
- رقم build.
- Firebase project id.
- Backend URL.
- UID للعميل.
- UID للكابتن.
- Ride ID.
- Payment ID إن وجد.
- النتيجة PASS/FAIL.
- صورة أو فيديو عند الفشل.
- مقتطف log بدون أسرار.

## تقييم الجاهزية الحالي من TASK 07A

جاهز للتجهيز اليدوي، وليس جاهزاً بعد للاختبار الميداني الحقيقي حتى يتم:

- إضافة ملفات Firebase للتطبيقين.
- تشغيل Backend سحابي HTTPS.
- تفعيل `APP_MODE=pilot`.
- نجاح `/ready` ضد Firebase الحقيقي.
- اختبار Firestore Rules.
- حل قرار Backend-only للكتابة على `rides`.
- تنفيذ الاختبارات أعلاه على جهازين حقيقيين.

