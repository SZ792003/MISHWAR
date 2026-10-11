# MISHWAR - TASK 17 Maps and GPS Report

تاريخ التنفيذ: 2026-10-10  
النطاق: خرائط Flutter، GPS، عرض المسارات، وموقع الكابتن في تطبيق العميل والكابتن.  
القيود: لم يتم تعديل Backend أو Firebase أو Authentication، ولم يتم تفعيل أي خدمة خرائط مدفوعة، ولم يتم تنفيذ commit أو push.

## الفحص الفني

- مزود الخريطة الحالي هو `flutter_map` مع tiles من OpenStreetMap:
  - `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- بيانات البحث والعكس الجغرافي والمسارات تأتي من Backend عبر:
  - `/api/geo/search`
  - `/api/geo/reverse`
  - `/api/geo/route`
- الإحداثيات مستخدمة بصيغة صحيحة داخل Flutter:
  - `latitude`
  - `longitude`
- مركز عدن الافتراضي موجود حول:
  - `12.7855, 45.0187`
- أذونات Android:
  - العميل: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `POST_NOTIFICATIONS`.
  - الكابتن: نفس العميل مع `FOREGROUND_SERVICE` و`FOREGROUND_SERVICE_LOCATION`.

## المشاكل المثبتة

1. `MishwarMap` كان يرسم خطاً مستقيماً بين الانطلاق والوجهة عند غياب `routePolyline`.
   - هذا يعطي انطباعاً بوجود مسار حقيقي رغم فشل خدمة Routing.
2. Attribution كان يعرض `Route by MISHWAR backend` حتى عند عدم وجود مسار موثوق.
3. تطبيق العميل كان يحتفظ بـ route preview حتى لو رجع Backend بمسار fallback أو polyline غير صالحة.
4. تطبيق الكابتن كان قد يعرض معاينة مسار للكابتن إلى العميل حتى لو كانت route response غير موثوقة.
5. اختبارات الخريطة كانت تحتاج طريقة لتعطيل تحميل tiles من الإنترنت داخل Widget tests.

## الإصلاحات المنفذة

### منع المسارات الوهمية

- أضيفت دوال مشتركة في `osm_ride_map.dart`:
  - `usableRoutePoints`
  - `hasUsableRoutePolyline`
  - `hasTrustedRouteModel`
- لم يعد `MishwarMap` يرسم خطاً بين الانطلاق والوجهة إلا عند وجود `routePolyline` صالحة من Backend.
- عند غياب المسار الحقيقي، تعرض الخريطة رسالة:
  - `المسار غير متاح حالياً`

### Attribution أوضح

- عند وجود مسار حقيقي فقط يظهر:
  - `Route by MISHWAR backend`
- عند غياب المسار، يبقى attribution خاصاً بـ OpenStreetMap فقط.

### تطبيق العميل

- `_refreshRoutePreview` صار يقبل المسار فقط إذا:
  - `fallback != true`
  - `polyline` صالحة وبها أكثر من نقطة متحركة.
- عند فشل أو غياب Routing حقيقي لا يتم عرض مسافة/وقت تقديري كأنه مؤكد.
- `_routePolylineFromRide` صار يفلتر routePolyline القادمة من الرحلة ولا يستخدم fallback غير موثوق.

### تطبيق الكابتن

- معاينة مسار الكابتن إلى العميل لا تحفظ إلا إذا كانت route response موثوقة.
- routePolyline من الرحلة تمر عبر نفس فلترة `usableRoutePoints`.
- موقع الكابتن القديم أو غير المتاح ما زال مميزاً عبر `liveLocationStatus`، ولا يعرض كموقع حي عند تجاوزه حد freshness.

### اختبارات الخرائط

- أضيف خيار `loadTiles` إلى `MishwarMap`، قيمته الافتراضية `true`.
- في الاختبارات فقط يتم تمرير `loadTiles: false` لمنع طلب tiles من الإنترنت.
- هذا لا يغير سلوك التطبيقين في التشغيل الحقيقي.

## الملفات المعدلة ضمن TASK 17

- `apps/mishwar_shared/lib/osm_ride_map.dart`
- `apps/mishwar_shared/test/maps_gps_test.dart`
- `apps/customer_app/lib/main.dart`
- `apps/driver_app/lib/main.dart`
- `apps/mishwar_shared/lib/production_tasks.dart`

ملاحظة: `production_tasks.dart` عُدّل فقط لإزالة تحذيرات `withOpacity` أثناء تحليل الحزمة المشتركة.

## نتائج الاختبارات

| الاختبار | النتيجة |
|---|---|
| `apps/mishwar_shared` - `flutter test --no-pub` | PASS - 8 اختبارات |
| `apps/mishwar_shared` - `flutter analyze --no-pub` | PASS - No issues found |
| `apps/customer_app` - `flutter analyze` | PASS - No issues found |
| `apps/customer_app` - `flutter test` | PASS - 3 اختبارات |
| `apps/driver_app` - `flutter analyze` | PASS - No issues found |
| `apps/driver_app` - `flutter test` | PASS - 3 اختبارات |

ملاحظة: أول محاولة `flutter test` للحزمة المشتركة بدون `--no-pub` فشلت بسبب محاولة الوصول إلى `pub.dev`. أُعيد التشغيل بـ `--no-pub` ونجح.

## Android والبطارية

- لا يوجد طلب `ACCESS_BACKGROUND_LOCATION`، وهذا جيد حالياً لأن مشاركة الموقع مرتبطة بسياق الرحلة.
- تطبيق الكابتن يستخدم `FOREGROUND_SERVICE_LOCATION`، وسيحتاج تبريراً واضحاً في Google Play لأنه يشارك موقع الكابتن أثناء الرحلة.
- سياسة رفع موقع الكابتن تستخدم throttling:
  - أثناء الرحلة: تحديث أسرع.
  - أثناء الوصول: تحديث متوسط.
  - أثناء الخمول: تحديث أبطأ.
- يتم رفض نقاط GPS الضعيفة أو القفزات غير المنطقية عبر `evaluateDisplayLocation`.

## المتطلبات الخارجية غير المفعلة

لا توجد خدمة مدفوعة مفعلة في هذه المهمة.

المطلوب لاحقاً من Backend/Cloud:

1. خدمة Routing حقيقية ترجع:
   - `polyline`
   - `distanceMeters`
   - `durationSeconds`
   - `provider`
   - `fallback=false` عند المسار الحقيقي فقط.
2. عند فشل Routing يجب أن يرجع Backend خطأ واضح أو `fallback=true`، ولا يرسل مساراً خطياً كمسار حقيقي.
3. خدمة Places/Reverse Geocoding موثوقة للمناطق المدعومة في اليمن.
4. سياسة rate limit/cache للخرائط والبحث لتقليل استهلاك الشبكة.
5. عند استخدام OSM tiles في Production يجب الالتزام بسياسة الاستخدام أو توفير tile provider مناسب تجارياً.

## ما بقي خارج نطاق هذه المهمة

- اختبار GPS فعلي على جهاز Android.
- اختبار قيادة حقيقي في عدن مع ضعف الإنترنت.
- اختبار FCM مع موقع الكابتن في الخلفية.
- بناء APK/AAB.
- تفعيل أي مزود خرائط مدفوع أو إنشاء مفاتيح API.

## تقييم TASK 17

TASK 17 مكتمل محلياً. تم إصلاح أهم خطر UX في الخرائط: عدم اختراع مسار أو وقت ضمني عند فشل Routing. الخرائط الآن تعرض نقاط الانطلاق والوجهة والكابتن، ولا ترسم مساراً إلا عند وصول polyline موثوقة من Backend.

جاهزية الخرائط للاختبار المحلي: PASS.  
جاهزية الخرائط للـ Pilot الحقيقي: BLOCKED حتى يتم اختبار GPS وRouting على أجهزة فعلية وBackend سحابي.
