# MISHWAR — TASK 10 Maps & GPS Mobile Experience

## النتيجة

تم تحسين تجربة الخرائط و GPS محلياً في تطبيق العميل والكابتن بدون تفعيل خدمات خرائط مدفوعة، وبدون تعديل Firebase أو السحابة أو Backend.

الحالة العامة: PASS لتطبيق العميل والكابتن، و BLOCKED لاختبارات حزمة `mishwar_shared` المباشرة بسبب قيود الوصول إلى Pub Cache/pub.dev.

## مزود الخرائط الحالي

- المزود الحالي: `flutter_map`.
- البلاطات: OpenStreetMap عبر `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.
- لا توجد مفاتيح API حالياً.
- المسار لا يُحسب داخل التطبيق؛ التطبيق يعرض `routePolyline` القادم من Backend أو خطاً تقريبياً بين الانطلاق والوجهة.
- يجب احترام سياسة استخدام OpenStreetMap عند الاختبار الميداني، وقد تحتاج المنصة لاحقاً إلى مزود Tiles مخصص للإنتاج لتجنب حدود الاستخدام.

## الملفات المعدلة

- `apps/mishwar_shared/lib/osm_ride_map.dart`
- `apps/mishwar_shared/lib/location_ui.dart`
- `apps/mishwar_shared/test/maps_gps_test.dart`
- `apps/customer_app/lib/main.dart`
- `apps/driver_app/lib/main.dart`
- `docs/TASK_10_MAPS_GPS.md`

## التحسينات المنفذة

- تحسين `MishwarMap`:
  - تقليل إعادة بناء الخريطة بإزالة `ValueKey` المتغير من `FlutterMap`.
  - عدم استدعاء `setState` عند `onMapReady` بلا حاجة.
  - عدم تحديث polyline إذا لم تتغير نقاط المسار فعلياً.
  - تصفية نقاط المسار غير الصالحة قبل عرضها.
  - إضافة fallback بصري عند فشل تحميل tiles بدلاً من ترك الخريطة فارغة.
  - استبدال `withOpacity` بـ `withValues`.
- تحسين تجربة GPS في تطبيق العميل:
  - حالة انتظار عند طلب GPS.
  - رسالة واضحة عند تعطيل خدمات الموقع.
  - رسالة واضحة عند رفض الإذن.
  - رسالة واضحة عند حظر الإذن نهائياً.
  - السماح بالاختيار اليدوي من الخريطة عند تعذر GPS.
- تحسين تجربة GPS في تطبيق الكابتن:
  - توحيد رسائل انتظار GPS ورفض الإذن وتعطيل خدمة الموقع.
  - الإبقاء على سياسة throttling الحالية لتقليل البطارية والتحديثات.
- إضافة اختبارات منطقية لمواقع وهمية:
  - رسائل حالات GPS.
  - تصفية إحداثيات route غير صالحة.

## Android Permissions

### تطبيق العميل

الموجود:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `POST_NOTIFICATIONS`

لا يوجد طلب `ACCESS_BACKGROUND_LOCATION`، وهذا مناسب لأن العميل يحتاج الموقع أثناء الاستخدام فقط.

### تطبيق الكابتن

الموجود:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `POST_NOTIFICATIONS`
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_LOCATION`

لا يوجد طلب `ACCESS_BACKGROUND_LOCATION`. هذا مناسب حالياً لأن التطبيق لا يثبت وظيفة خلفية حقيقية مكتملة، ومشاركة الموقع تتم أثناء الرحلة من التطبيق.

## الخصوصية ومنع تسرب الموقع

- تطبيق العميل لا يرسل موقع العميل إلى مستخدمين آخرين مباشرة من الواجهة.
- تطبيق العميل يعرض موقع الكابتن فقط من بيانات الرحلة/الاشتراك المرتبط بالرحلة الحالية.
- تطبيق الكابتن لا يبدأ مشاركة الموقع إلا بعد رحلة غير منتهية وليست `SEARCHING_DRIVER`.
- لم يتم تغيير قواعد Firestore أو Backend في هذه المهمة، لذلك التحقق النهائي من عدم التسرب يعتمد لاحقاً على Rules وCustom Claims وربط Pilot الحقيقي.

## البطارية وتقليل التحديثات

- تم الحفاظ على `DriverLocationThrottlePolicy`:
  - active trip: فلتر 10m وفاصل قصير.
  - arriving: فلتر 15m.
  - idle: فلتر 60m وفاصل أطول.
  - offline: لا يرفع الموقع.
- تم تقليل إعادة رسم الخريطة عند عدم تغير المسار.
- لم تتم إضافة تتبع خلفية جديد.

## نتائج الاختبارات

### Customer Analyze

النتيجة: PASS

```text
No issues found! (ran in 19.0s)
```

### Driver Analyze

النتيجة: PASS

```text
No issues found! (ran in 19.1s)
```

### Customer Flutter Test

النتيجة: PASS

```text
00:02 +1: All tests passed!
```

### Driver Flutter Test

النتيجة: PASS

```text
00:01 +1: All tests passed!
```

### mishwar_shared Flutter Test

النتيجة: BLOCKED

السبب:

- تشغيل `flutter test` احتاج الوصول إلى `pub.dev` لتنزيل/حل اعتماديات `mishwar_shared`.
- طلب السماح بالشبكة تم رفضه.
- محاولة `pub get --offline` فشلت بسبب:

```text
Creation failed, path = 'C:\Users\MahmoodCenter\AppData\Local\Pub\Cache\active_roots\30' (OS Error: Access is denied, errno = 5)
```

تمت إعادة `apps/mishwar_shared/pubspec.lock` لحالته السابقة بعد فشل المحاولة.

## مفاتيح API المطلوبة

- لا توجد مفاتيح API مطلوبة حالياً للخرائط لأن OpenStreetMap لا يستخدم مفتاحاً في الإعداد الحالي.
- إذا تم اعتماد مزود خرائط إنتاجي لاحقاً مثل Mapbox أو Google Maps، يجب توثيق المفتاح في `.env.example` أو إعدادات CI/Store بدون وضع السر داخل Git.
- لم يتم إنشاء أو نشر أي مفتاح.

## المخاطر المتبقية

- OpenStreetMap العام مناسب للتطوير، لكنه ليس مضموناً للإنتاج عالي الاستخدام.
- اختبار GPS الحقيقي يحتاج جهاز Android فعلي أو محاكي مع موقع وهمي.
- اختبار عدم تسرب الموقع بشكل نهائي يحتاج Firebase/Firestore Rules وBackend Pilot حقيقي.
- `mishwar_shared` tests لم تعمل بسبب قيود الشبكة/الصلاحيات، رغم أن تطبيق العميل والكابتن حللا ونجحا بعد التعديلات.

## تقييم TASK 10

TASK 10 جاهز محلياً من ناحية تطبيق العميل والكابتن. يلزم لاحقاً اختبار جهازين حقيقيين مع Backend شغال، ثم اختبار Firebase Rules للتأكد من عزل بيانات الموقع بين المستخدمين.
