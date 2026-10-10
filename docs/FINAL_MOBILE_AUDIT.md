# MISHWAR - Final Mobile Development Audit

تاريخ التدقيق: 2026-10-10  
النطاق: تطبيق العميل، تطبيق الكابتن، الحزمة المشتركة Flutter، وواجهات الربط المحلية مع Backend.  
القيود: لم يتم تعديل كود التطبيقين أو Backend أو Firebase أو الاستضافة. التعديل الوحيد في هذه المهمة هو إنشاء هذا التقرير.

## القرار التنفيذي

تطبيق العميل وتطبيق الكابتن ليسا جاهزين للإطلاق العام على Google Play الآن.

الحالة الحالية جيدة لاختبار محلي وديمو مغلق، وفيها أساس قوي لتدفقات FAST وBIDDING والرحلة والمحاسبة. لكن الإطلاق العام يحتاج إكمال Firebase الحقيقي، Backend السحابي، إشعارات FCM على أجهزة حقيقية، تحقق GPS ميداني، توقيع Release، أيقونات نهائية، وبناء APK/AAB فعلي.

قرار الجاهزية:

| التطبيق | محلي Demo | Pilot مغلق | إطلاق عام |
|---|---:|---:|---:|
| تطبيق العميل | PASS | BLOCKED | FAIL |
| تطبيق الكابتن | PASS | BLOCKED | FAIL |

## الاختبارات المنفذة فعلياً

| البند | الأمر | النتيجة |
|---|---|---|
| Customer Flutter Analyze | `flutter analyze` داخل `apps/customer_app` | PASS - `No issues found! (ran in 48.6s)` |
| Driver Flutter Analyze | `flutter analyze` داخل `apps/driver_app` | PASS - `No issues found! (ran in 48.6s)` |
| Customer Flutter Test | `flutter test` داخل `apps/customer_app` | PASS - `+2: All tests passed!` |
| Driver Flutter Test | `flutter test` داخل `apps/driver_app` | PASS - `+2: All tests passed!` |
| Backend Critical QA | `npm run qa:critical` داخل `backend` | PASS |
| Secret Scan | ضمن `npm run qa:critical` | PASS - `Secret scan passed` |
| FAST/BIDDING المحلي | ضمن `test:dispatch` و`test:bidding` | PASS |
| الرحلة والصلاحيات | ضمن `test:ride-auth` | PASS |
| المحاسبة والعمولة | ضمن `test:payments` | PASS |
| FCM Backend hardening | ضمن `test:fcm` | PASS |
| Geo/Safety/Risk | ضمن `test:geo`, `test:safety`, `test:risk` | PASS |
| فحص APK/AAB موجودة | `Get-ChildItem -Include *.apk,*.aab` | PASS كفحص، لا توجد ملفات ناتجة |
| Gradle Customer | `gradlew tasks --no-daemon` | BLOCKED - فشل تنزيل Gradle من `services.gradle.org` بسبب الشبكة |
| Gradle Driver | `gradlew tasks --no-daemon` | BLOCKED - `Permission denied: connect` أثناء تنزيل Gradle |

ملاحظة مهمة: لم يتم تشغيل اختبار Firebase حقيقي أو اختبار على جهاز Android فعلي في هذه المهمة.

## المميزات المكتملة

### تطبيق العميل

- واجهة عربية RTL مع هوية مشوار وشاشة رئيسية تعتمد على الخريطة.
- اختيار نقطة الانطلاق والوجهة يدوياً أو عبر GPS.
- اختيار نوع المركبة، عدد الركاب، والمكيف.
- دعم وضعين للحجز: `FAST` و`BIDDING`.
- عرض السعر الاسترشادي، اقتراح سعر في وضع العروض، وعرض عروض الكباتن.
- اختيار عرض واحد وتأكيده عبر Backend API abstraction.
- عرض حالة الرحلة، بيانات الكابتن، موقعه، الفاتورة، والدفع.
- سجل الرحلات والفواتير.
- التقييم، الدعم، الخصوصية، طلب البيانات، وطلب حذف الحساب.
- رسائل انقطاع الإنترنت ووجود `OfflineSyncCard` للعمليات المسموح بمزامنتها.
- منع عمليات حساسة من Offline Queue في طبقة API المشتركة.

### تطبيق الكابتن

- واجهة عربية RTL لتطبيق الكابتن.
- تسجيل دخول عبر `AuthGate` عند الخروج من Demo.
- حالة متاح/غير متاح.
- استقبال طلبات FAST وطلبات BIDDING.
- إرسال عرض سعر، سحب العرض، قبول/رفض الطلب.
- انتقالات الرحلة: الوصول للعميل، بدء الرحلة، إنهاء الرحلة، إلغاء الرحلة.
- مشاركة موقع الكابتن، تهدئة تحديثات GPS، ورسائل جودة الموقع.
- تأكيد استلام النقد.
- شاشة "المحفظة والأرباح" تعرض عمولة مشوار 10% والمديونية والتسويات.
- واجهة KYC مبدئية، دعم، خصوصية، مساعدة وطوارئ.

### الحزمة المشتركة والتكامل المحلي

- `MishwarApi` يدعم Demo headers محلياً وFirebase ID Token في أوضاع غير Demo.
- يوجد تحقق Runtime يمنع `localhost` و`demo` و`http` في أوضاع `staging/pilot/production`.
- يوجد FCM setup: foreground, background handler, token registration/unregistration.
- Crashlytics/Analytics مهيأة مع فلترة بيانات حساسة من analytics parameters.
- `MishwarMap` يعتمد على خرائط محلية/OSM عبر `flutter_map`.
- Backend المحلي أثبت تدفقات Dispatch وBidding والرحلة والدفع والمالية عبر smoke tests.

## المميزات الناقصة أو غير المكتملة

### Critical

- Firebase الحقيقي غير مكتمل على مستوى التطبيقات: `google-services.json` غير موجود في تطبيق العميل ولا تطبيق الكابتن.
- لم يتم اختبار تسجيل الدخول الحقيقي عبر OTP على جهاز Android فعلي.
- لم يتم اختبار استقبال إشعارات الرحلات عبر FCM في الخلفية/التطبيق مغلق على جهاز فعلي.
- لم يتم بناء APK أو AAB فعلياً بسبب حجب تنزيل Gradle في البيئة الحالية.
- لا توجد حزمة Release موقعة ولا `key.properties` محلي جاهز، وهذا صحيح أمنياً لكنه يمنع AAB حتى يتم توفيره يدوياً.
- لا يوجد تحقق ميداني لاتصال التطبيقات بـ Backend HTTPS سحابي حقيقي.

### High

- أيقونات التطبيقين ما زالت بحاجة مراجعة نهائية؛ ملفات `ic_launcher.png` موجودة، لكن لم يتم إثبات أنها أيقونة مشوار النهائية وليست الأيقونة الافتراضية.
- KYC في تطبيق الكابتن واجهة مبدئية تعتمد على رابط مستند؛ تحتاج ربط آمن بتخزين ملفات ومراجعة إدارية وCustom Claims.
- شاشة الأرباح تعتمد على API موجودة، لكن لم يتم التحقق من Firestore/Production ledger الحقيقي على أجهزة فعلية.
- تجربة GPS والملاحة لم تختبر على أجهزة منخفضة ومتوسطة، ولا في ظروف ضعف الإنترنت الحقيقي.
- صلاحيات `FOREGROUND_SERVICE_LOCATION` في تطبيق الكابتن تحتاج تبرير واضح في Play Console لأنها صلاحية حساسة.
- لا يوجد إثبات عملي أن FCM يوقظ شاشة الطلب للكابتن من الخلفية في Android الحقيقي.

### Medium

- اختبارات Widget الحالية محدودة: تتحقق من التشغيل والتنقل الأساسي، ولا تغطي كل حالات FAST/BIDDING بصرياً.
- لا توجد اختبارات Golden/لقطات شاشة للشاشات العربية الصغيرة والمتوسطة.
- اعتماد `google_maps_flutter` موجود في التطبيقين رغم أن الخريطة الفعلية المشتركة تستخدم `flutter_map`; يحتاج مراجعة قبل الإطلاق لتقليل الحجم والتعقيد إذا كان غير مستخدم.
- `versionName/versionCode` حالياً من `pubspec.yaml` بقيمة `1.0.0+1`; مناسب كبداية لكن يحتاج سياسة إصدارات واضحة قبل الرفع.
- واجهات الدعم والخصوصية وحذف الحساب ترسل طلبات مراجعة، لكنها تحتاج روابط وسياسة منشورة خارج التطبيق.

### Low

- Splash screen أساسي ويحتاج اعتماد بصري نهائي.
- بعض رسائل Demo المحلية تذكر الخادم المحلي، وهذا مقبول في Demo لكن يجب التأكد من عدم ظهورها في Pilot/Production.
- لم يتم قياس حجم التطبيق أو زمن بدء التشغيل.

## الأخطاء المثبتة

| الخطورة | المشكلة | الدليل | الأثر |
|---|---|---|---|
| Critical | تعذر فحص/بناء Gradle | `UnknownHostException: services.gradle.org` و`Permission denied: connect` | لا يمكن تأكيد APK/AAB داخل هذه البيئة |
| Critical | إعداد Firebase Android ناقص | `google-services.json` غير موجود للتطبيقين | لا يمكن تشغيل Firebase Auth/FCM الحقيقي على Android |
| High | لا توجد APK/AAB ناتجة | فحص `*.apk,*.aab` لم يرجع ملفات | لا يوجد artifact قابل للتثبيت/الرفع من هذه الجلسة |
| High | إشعارات الخلفية غير مثبتة على جهاز | الكود موجود، لكن لا يوجد اختبار جهاز حقيقي | خطر ضياع طلبات الكباتن في Pilot |
| High | KYC غير إنتاجي بالكامل | واجهة رابط مستند فقط في التطبيق | لا يكفي لاعتماد كباتن فعلياً قبل ربط تخزين ومراجعة |

## مشكلات تجربة المستخدم

- التطبيقان يغطيان التدفقات الأساسية، لكن يلزم اختبار يدوي على شاشات صغيرة للتأكد من عدم ضغط بطاقات الرحلة والعروض والمالية.
- وضع BIDDING واضح، لكن يحتاج اختبار مستخدم فعلي للتأكد من فهم العميل لنهائية اختيار عرض واحد.
- رسائل انقطاع الإنترنت جيدة، لكن تحتاج تجربة حقيقية عند الرجوع من الخلفية وتبديل الشبكة.
- شاشة الكابتن المالية تعرض البيانات المطلوبة، لكنها تحتاج تدقيق UX للقراءة السريعة أثناء العمل اليومي.
- واجهات حذف الحساب والخصوصية موجودة كطلب مراجعة، لكنها تحتاج ربط بروابط قانونية منشورة قبل Google Play.

## Android وGoogle Play

الموجود:

- `applicationId` مستقل:
  - العميل: `com.mishwar.customer`
  - الكابتن: `com.mishwar.driver`
- `compileSdk = 37`
- `targetSdk = 36`
- أسماء التطبيقات:
  - `مشوار`
  - `مشوار كابتن`
- صلاحيات Android موجودة:
  - العميل: Internet, Network State, Fine/Coarse Location, Notifications.
  - الكابتن: نفس العميل + Foreground Service + Foreground Service Location.
- Release guard يمنع بناء Release إذا كان `MISHWAR_RELEASE_API_URL` غير HTTPS أو يحتوي `localhost/127.0.0.1/demo`.

الناقص:

- تنزيل Gradle أو توفيره في cache محلي.
- `google-services.json` لكل تطبيق من مشروع Firebase نفسه.
- توقيع Release خارج Git.
- بناء AAB فعلي وفحصه.
- أيقونات Adaptive/Store نهائية.
- Privacy Policy URL وDelete Account URL وData Safety.
- اختبار أجهزة حقيقية وتقرير Play Pre-launch.

## PASS/FAIL/BLOCKED

| المجال | الحالة | السبب |
|---|---|---|
| شاشات العميل | PASS محلي | موجودة وتنجح اختبارات Widget الأساسية |
| شاشات الكابتن | PASS محلي | موجودة وتنجح اختبارات Widget الأساسية |
| FAST محلي | PASS | Backend `test:dispatch` و`test:ride-auth` نجحت |
| BIDDING محلي | PASS | Backend `test:bidding` نجح |
| إشعارات الخلفية | BLOCKED | تحتاج Firebase config وجهاز Android حقيقي |
| GPS والتتبع | PARTIAL | الكود موجود وGeo tests نجحت، لكن لا يوجد اختبار جهاز |
| انقطاع الإنترنت | PARTIAL | Offline queue موجودة للعمليات المسموحة، لكن لم يختبر على جهاز |
| Login/Logout | PARTIAL | AuthGate موجود، OTP الحقيقي محجوب بدون Firebase |
| الأرباح والمحاسبة | PASS محلي | Payment/Finance smoke tests نجحت |
| الشكاوى والطوارئ | PASS محلي | Safety/Support smoke tests نجحت |
| Android permissions | PASS مراجعة | الصلاحيات موجودة، وتحتاج تبرير للكابتن |
| APK/AAB | BLOCKED | Gradle download محجوب ولا توجد artifacts |
| Google Play readiness | FAIL | لا يوجد AAB موقّع ولا Firebase فعلي ولا سياسة متجر |

## أولويات التنفيذ

### Critical

1. توفير Firebase Android config للتطبيقين دون وضع أسرار غير مناسبة في Git.
2. تشغيل التطبيقين على جهازين Android حقيقيين مع Backend HTTPS سحابي.
3. اختبار FCM: foreground, background, terminated, token refresh.
4. بناء APK/AAB بعد حل Gradle network/cache وتوقيع Release.
5. تنفيذ رحلة Pilot كاملة: عميل يطلب، كابتن يستقبل، يقبل، يصل، يبدأ، ينهي، يؤكد النقد، وتظهر العمولة.

### High

1. اعتماد أيقونات وسplash نهائية للتطبيقين.
2. تثبيت KYC الإنتاجي: رفع ملفات آمن، مراجعة، claims، ومنع استقبال الرحلات قبل الاعتماد.
3. اختبار GPS على أجهزة حقيقية مع ضعف الإنترنت والتنقل بين الخلفية والمقدمة.
4. مراجعة Play Console لصلاحيات الموقع والإشعارات والخدمة الأمامية.
5. إضافة اختبارات Widget/Integration أعمق لسيناريوهات FAST وBIDDING.

### Medium

1. مراجعة الاعتماديات غير المستخدمة مثل `google_maps_flutter` إذا لم تعد مطلوبة.
2. تحسين تغطية الشاشات الصغيرة واللغات واتجاه RTL باختبارات Golden أو لقطات.
3. إعداد سياسة الإصدارات `versionCode/versionName`.
4. قياس الأداء وحجم التطبيق وزمن الإقلاع.

### Low

1. تحسين نصوص بعض حالات Demo.
2. صقل تفاصيل واجهة المالية والدعم بعد أول اختبار مستخدم حقيقي.

## مهام يمكن تنفيذها دون مهندس السحابة

- تحسين أيقونات التطبيقين وAdaptive Icons وSplash.
- إضافة اختبارات Widget/Navigation أعمق لتدفقات FAST/BIDDING.
- اختبار responsive UI على أحجام شاشة متعددة.
- تنظيف الاعتماديات غير المستخدمة بعد التحقق.
- تحسين UX لشاشة المالية وKYC والدعم.
- تجهيز ملفات Play Store listing والنصوص واللقطات.
- إعداد تعليمات بناء Release محلية بعد توفر Gradle cache والتوقيع.

## مهام يجب تحويلها لمهندس السحابة/Firebase

- إنشاء/تزويد `google-services.json` لكل تطبيق من مشروع Firebase نفسه.
- تفعيل Firebase Auth Phone OTP وتحديد أرقام اختبار آمنة.
- ضبط FCM topic/device-token routing للعميل والكابتن.
- نشر Backend على HTTPS مع CORS وready/health/metrics.
- ضبط Firestore Rules وIndexes وCustom Claims للأدوار وKYC.
- التحقق من أن Pilot لا يستخدم Demo fallback.
- اختبار الرحلات والمالية على Firestore الحقيقي بدون بيانات وهمية.
- تجهيز روابط Privacy Policy وDelete Account وSupport للإنتاج.

## الخلاصة

تطبيقات Flutter وصلت إلى مرحلة قوية من حيث الشكل والتدفقات المحلية: التحليل والاختبارات المحلية وBackend QA نجحت، وFAST/BIDDING والرحلة والمالية تعمل محلياً.  

لكن المشروع غير جاهز للإطلاق العام لأن طبقة Firebase/FCM/Backend السحابي والبناء الموقّع على Android لم تثبت بعد. أفضل قرار الآن هو الانتقال إلى Pilot تقني مغلق بعد أن ينجز مهندس السحابة الربط الحقيقي، ثم تشغيل اختبار جهازين حقيقيين قبل التفكير في Google Play.
