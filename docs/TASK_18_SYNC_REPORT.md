# MISHWAR - TASK 18: Customer Driver Real-Time Synchronization

تاريخ التنفيذ: 2026-10-10

## 1. نطاق الفحص

تم فحص تزامن تطبيق العميل والكابتن عبر طبقة API الحالية بدون تعديل Firebase أو Backend أو عقود REST.

الملفات الأساسية التي تمت مراجعتها:

- `apps/customer_app/lib/main.dart`
- `apps/driver_app/lib/main.dart`
- `apps/mishwar_shared/lib/mishwar_api.dart`
- `backend/src/server.ts`
- `apps/customer_app/test/widget_test.dart`
- `apps/driver_app/test/widget_test.dart`

## 2. خريطة حالات الرحلة

| الحالة | المعنى | الانتقالات المسموحة |
|---|---|---|
| `SEARCHING_DRIVER` | العميل أنشأ الطلب والبحث/العروض مفتوحة | قبول كابتن، رفض عرض من كابتن مع بقاء البحث، انتهاء المهلة، إلغاء العميل |
| `DRIVER_ASSIGNED` | تم إسناد الرحلة لكابتن | وصول الكابتن، إلغاء طرف مصرح |
| `DRIVER_ARRIVING` / `DRIVER_ON_THE_WAY` | الكابتن في الطريق للعميل | وصول الكابتن، إلغاء طرف مصرح |
| `DRIVER_ARRIVED` | الكابتن وصل نقطة الانطلاق | بدء الرحلة، إلغاء طرف مصرح |
| `TRIP_STARTED` | الرحلة بدأت | إنهاء الرحلة، إلغاء حسب سياسة الخادم |
| `TRIP_COMPLETED` | الرحلة اكتملت | حالة نهائية، بعدها الدفع/التقييم |
| `CANCELLED_BY_CUSTOMER` / `CANCELLED_BY_PASSENGER` | إلغاء من العميل | حالة نهائية |
| `CANCELLED_BY_DRIVER` | إلغاء من الكابتن | حالة نهائية |
| `NO_DRIVER_FOUND` / `NO_DRIVER_AVAILABLE` | لم يتوفر كابتن | حالة نهائية أو يعاد الطلب من العميل |

ملاحظة: وضع `BIDDING` يستخدم نفس حالات الرحلة العامة مع حقول إضافية مثل `bookingMode`, `biddingStatus`, `customerProposedFare`, `biddingExpiresAt` وعروض الكباتن.

## 3. جدول الأحداث والطلبات والاستجابات

| الحدث | التطبيق | API | الاستجابة المتوقعة | الحالة المتوقعة |
|---|---|---|---|---|
| إنشاء رحلة FAST | العميل | `POST /api/rides` مع `x-idempotency-key` | Ride JSON | `SEARCHING_DRIVER` |
| إنشاء رحلة BIDDING | العميل | `POST /api/rides` مع `bookingMode=BIDDING` | Ride JSON | `SEARCHING_DRIVER` وفتح العروض |
| استرجاع حالة العميل بعد الاتصال | العميل | `GET /api/rides/active` | Ride أو null | آخر حالة نشطة موثوقة |
| مشاهدة طلب مخصص للكابتن | الكابتن | `GET /api/dispatch/incoming` | Ride أو null | طلب FAST أو BIDDING مرشح |
| قبول FAST | الكابتن | `POST /api/rides/:id/accept` | Ride محدث | `DRIVER_ASSIGNED` |
| رفض FAST | الكابتن | `POST /api/rides/:id/decline` | Ride محدث | يبقى البحث لغيره أو يفشل عند عدم التوفر |
| إرسال عرض BIDDING | الكابتن | `POST /api/rides/:id/bids` | Bid JSON | العرض يظهر للعميل |
| سحب عرض BIDDING | الكابتن | `POST /api/rides/:id/bids/:bidId/withdraw` | Bid/Ride محدث | العرض لا يعود متاحاً |
| قراءة عروض BIDDING | العميل | `GET /api/rides/:id/bids` | قائمة مرتبة | العميل يختار عرضاً |
| اختيار عرض | العميل | `POST /api/rides/:id/bids/:bidId/select` | Ride محدث | `DRIVER_ASSIGNED` وسعر نهائي من الخادم |
| إلغاء عروض | العميل | `POST /api/rides/:id/bidding/cancel` | Ride محدث | إلغاء نهائي أو حسب الخادم |
| وصول الكابتن | الكابتن | `POST /api/rides/:id/arrived` | Ride محدث | `DRIVER_ARRIVED` |
| بدء الرحلة | الكابتن | `POST /api/rides/:id/start` | Ride محدث | `TRIP_STARTED` |
| إنهاء الرحلة | الكابتن | `POST /api/rides/:id/complete` | Ride محدث | `TRIP_COMPLETED` |
| تحديث موقع الكابتن | الكابتن | `POST /api/rides/:id/location` | Ride/Location محدثة | موقع موثوق إذا قبل الخادم |
| تأكيد الدفع النقدي | الكابتن | `POST /api/payments/cash/confirm` | Payment/Ledger result | احتساب العمولة حسب الخادم |

## 4. ما يعمل حالياً في Flutter

- تطبيق العميل ينشئ الرحلة عبر `MishwarApi.requestRide` ولا ينشئ نظام اتصال موازياً.
- تطبيق الكابتن يجلب الطلبات عبر `MishwarApi.incomingRide` ويستخدم `rideAction` لحالات القبول والوصول والبدء والإنهاء.
- العميل والكابتن يستخدمان polling كل 5 ثوان لاسترجاع الحالة عند التشغيل المحلي.
- عند الرجوع من الخلفية يتم تشغيل `syncOfflineQueue()` ثم تحديث حالة الرحلة.
- في الوضع غير التجريبي توجد listeners على `rides/{rideId}`، والعميل يستمع أيضاً إلى `driverLocations/{driverId}` عند وجود كابتن.
- العمليات الحساسة تمر عبر `_postCritical` ولا تدخل Offline Queue؛ المسموح بإعادة الإرسال محلياً محدود بمسارات آمنة مثل الموقع وتسجيل الجهاز.
- في Demo تستخدم الطبقة رؤوس `x-user-id` و`x-user-role`، وفي Pilot/Live تستخدم `Authorization: Bearer <Firebase ID Token>`.

## 5. المشاكل المثبتة التي تم إصلاحها

| المشكلة | الخطورة | الإصلاح |
|---|---|---|
| عند ضعف الاتصال، إعادة الضغط على طلب الرحلة قد ترسل `x-idempotency-key` جديداً، ما قد يسمح بطلبين إذا وصل الطلب الأول متأخراً. | High | إضافة `idempotencyKey` اختياري إلى `MishwarApi.requestRide`، وحفظ مفتاح الطلب المعلق في تطبيق العميل حتى ينجح الطلب أو يرجع الخادم بخطأ HTTP واضح. |
| زر القبول في الكابتن يحتاج إثبات أنه لا يرسل قبولين سريعاً من الواجهة. | High | إضافة اختبار Widget يضغط زر القبول مرتين بسرعة ويتحقق أن استدعاء `accept` تم مرة واحدة. |
| عروض BIDDING من الكابتن تحتاج إثبات عدم تكرار العرض من الواجهة. | Medium | إضافة اختبار Widget يتحقق أن الكابتن لا يستطيع إرسال عرض ثان لنفس الطلب قبل سحب العرض الأول. |

## 6. الملفات المعدلة في TASK 18

- `apps/mishwar_shared/lib/mishwar_api.dart`
  - إضافة معامل `idempotencyKey` اختياري إلى `requestRide`.
  - إبقاء رأس `x-idempotency-key` كما هو، مع السماح للعميل بإعادة استخدام نفس المفتاح عند retry.
- `apps/customer_app/lib/main.dart`
  - إضافة `_pendingRideRequestKey`.
  - إعادة استخدام نفس idempotency key عند فشل الشبكة/timeout.
  - تصفير المفتاح بعد نجاح إنشاء الرحلة أو عند خطأ HTTP موثوق من Backend.
- `apps/customer_app/test/widget_test.dart`
  - إضافة اختبار إعادة استخدام idempotency key بعد ضعف الاتصال.
  - تحديث fake ride response ليتوافق مع شكل الرحلة الذي تعرضه الواجهة.
- `apps/driver_app/test/widget_test.dart`
  - إضافة اختبار منع تكرار عرض BIDDING.
  - إضافة اختبار منع النقر المكرر على قبول FAST.
- `docs/TASK_18_SYNC_REPORT.md`
  - هذا التقرير.

## 7. نتائج الاختبارات

| الاختبار | النتيجة | ملاحظات |
|---|---|---|
| `flutter analyze` - customer_app | PASS | `No issues found!` |
| `flutter test` - customer_app | PASS | 4 اختبارات نجحت. ظهرت رسائل OSM tile 400 داخل بيئة الاختبار فقط بدون فشل. |
| `flutter analyze` - driver_app | PASS | `No issues found!` |
| `flutter test` - driver_app | PASS | 4 اختبارات نجحت. |
| `flutter analyze --no-pub` - mishwar_shared | PASS | `No issues found!` |
| `flutter test --no-pub` - mishwar_shared | PASS | 8 اختبارات نجحت. |
| `npm.cmd run typecheck` - backend | PASS | TypeScript typecheck ناجح. |
| `npm.cmd run test:dispatch` - backend | PASS | smoke test أكد قبول كابتن واحد ورفض قبول ثان بـ 409 محلياً. |
| `npm.cmd run test:bidding` - backend | PASS | smoke test أكد اختيار عرض واحد ورفض اختيار مكرر بـ 409 محلياً. |

ملاحظة تشغيل: `flutter.bat` و`dart.bat` من مسار `C:\development` احتاجا كتابة lock/telemetry خارج مساحة العمل. لذلك تم تشغيل Flutter عبر snapshot داخل `.codex/flutter-sdk` مع تعطيل telemetry وتوجيه `APPDATA/LOCALAPPDATA` إلى مجلد مؤقت داخل المشروع. هذا لا يثبت Firebase أو Production.

## 8. نقاط تحتاج مهندس Backend/Firebase

| الأولوية | المطلوب | السبب |
|---|---|---|
| Critical | تأكيد أن idempotency لـ `POST /api/rides` محفوظ persistent في بيئة السحابة وليس في الذاكرة فقط. | منع تكرار الرحلات عند retry أو إعادة تشغيل أكثر من instance. |
| Critical | إضافة/اعتماد `stateVersion` أو `serverUpdatedAt` موحد في كل Ride response وFirestore snapshot. | منع استجابة Backend متأخرة من استبدال حالة أحدث في تطبيق العميل أو الكابتن. |
| Critical | مراجعة Firestore Rules لـ `rides/{rideId}` و`driverLocations/{driverId}`. | Flutter يستمع لهذه الوثائق في non-demo، ويجب منع أي مستخدم من قراءة رحلة أو موقع لا يخصه. |
| High | توحيد حقول انتهاء المهلة والفشل مثل `failureReason`, `offerExpiresAt`, `biddingExpiresAt`, `biddingStatus`. | الواجهة تحتاج عرض سبب واضح عند انتهاء FAST/BIDDING أو عدم وصول عروض. |
| High | التأكد من أن `/api/rides/active` يرجع آخر حالة نشطة صحيحة للعميل والكابتن بعد reconnect. | هذا هو مسار الاسترجاع الأساسي عند ضعف الإنترنت. |
| High | اختبار FCM/Push في الخلفية على جهاز فعلي. | Flutter حالياً يعتمد محلياً على polling/listeners، ولا يوجد إثبات عملي لاستقبال إشعارات الخلفية في TASK 18. |
| Medium | توثيق schema النهائي لموقع الكابتن وstaleness fields. | الواجهة تعرض الموقع فقط عند توفر بيانات موثوقة، وتحتاج حقول عمر/دقة ثابتة. |

## 9. تقييم المتطلبات

| البند | الحالة | الدليل |
|---|---|---|
| خريطة حالات الرحلة | PASS | موثقة في هذا التقرير. |
| العميل ينشئ الطلب عبر Backend | PASS | `MishwarApi.requestRide` يستخدم `POST /api/rides`. |
| الكابتن يرى الطلب المخصص | PASS محلياً | `incomingRide` وbackend dispatch smoke test. |
| قبول الكابتن يظهر عند العميل | PASS محلياً/Mock | polling/listeners موجودة، واختبارات backend تؤكد التحديث. يحتاج تحقق جهازين مع Firebase. |
| رفض الطلب أو انتهاء المهلة | PARTIAL | decline مدعوم؛ انتهاء المهلة يحتاج حقول failure/expiry موحدة من Backend. |
| منع تكرار إنشاء الرحلة عند ضعف الاتصال | PASS Flutter | تم إصلاح idempotency retry في العميل واختباره. |
| منع قبول الرحلة بواسطة كابتنين | PASS Backend محلياً | `test:dispatch` أعاد 409 للقبول الثاني. |
| حالات الوصول والبدء والإنهاء والإلغاء | PASS API | endpoints موجودة ومستخدمة من الكابتن/العميل. |
| استرجاع الحالة بعد إعادة الاتصال | PASS محلياً | `activeRide`, `incomingRide`, polling, app resume sync. يحتاج اختبار جهازين. |
| التعامل مع استجابة Backend المتأخرة | PARTIAL | أزرار busy وidempotency تقلل الخطر؛ يلزم `stateVersion/serverUpdatedAt` من Backend. |
| عرض موقع الكابتن عند توفر بيانات موثوقة | PASS UI جزئياً | listener موجود، لكن schema/staleness النهائي يحتاج تثبيت سحابي. |
| استخدام API الحالية فقط | PASS | لم يتم إنشاء نظام اتصال مواز. |
| الحفاظ على FAST وBIDDING | PASS | اختبارات العميل والكابتن والـ backend smoke نجحت. |
| التحقق من الهوية في API | PASS بنيوياً | Demo headers وBearer token موجودة؛ التحقق الحقيقي يحتاج Firebase live. |
| اختبارات Integration بم mocks/local backend | PASS | Flutter Widget + backend smoke tests. |

## 10. قرار الجاهزية

TASK 18 جاهز للدمج المحلي واختبار رحلة Demo بين تطبيق العميل والكابتن عبر Backend محلي.

ليس جاهزاً كإثبات Production نهائي حتى ينهي مهندس السحابة:

- Firebase Auth وFirestore Rules على المشروع الحقيقي.
- تأكيد persistent idempotency وdispatch في الاستضافة السحابية.
- اختبار جهازين حقيقيين مع FCM/Firestore listeners.
- إضافة أو تثبيت `stateVersion/serverUpdatedAt` في عقد Ride لمنع تعارض الاستجابات المتأخرة.
