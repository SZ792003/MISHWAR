# MISHWAR — TASK 11 UX, Accessibility & Client Security

## النتيجة

تمت مراجعة وتحسين تطبيق العميل والكابتن من ناحية UX و RTL وسلوك العمليات الحساسة وحماية الجلسة على مستوى Flutter فقط.

الحالة: PASS محلياً.

## الملفات المعدلة

- `apps/customer_app/lib/main.dart`
- `apps/customer_app/test/widget_test.dart`
- `apps/driver_app/lib/main.dart`
- `apps/driver_app/test/widget_test.dart`
- `apps/mishwar_shared/lib/mishwar_api.dart`
- `apps/mishwar_shared/lib/mobile_runtime.dart`
- `docs/TASK_11_UX_SECURITY.md`

## التحسينات المنفذة

- إضافة زر تسجيل خروج واضح في تطبيق العميل والكابتن.
- تسجيل الخروج ينفذ:
  - إلغاء/تنظيف FCM device token عند توفر Firebase.
  - تنظيف offline queue المحلي.
  - `FirebaseAuth.signOut()` عند توفر Firebase.
- إضافة `clearLocalSessionData()` في API المشترك لتنظيف بيانات الجلسة المحلية.
- تحسين سلوك الرجوع من الخلفية:
  - العميل يعيد مزامنة queue ويحدث الرحلة والمسار.
  - الكابتن يعيد مزامنة queue ويحدث الرحلة والمالية، ويعيد تشغيل تتبع الموقع للرحلة النشطة عند الحاجة.
- تحسين رسائل HealthCard حتى لا تعرض raw exception أو تفاصيل داخلية للمستخدم.
- الحفاظ على منع النقر المتكرر في العمليات الحساسة عبر busy flags الموجودة:
  - طلب رحلة.
  - اختيار عرض.
  - قبول/رفض/إلغاء رحلة.
  - إرسال وسحب عرض.
  - تأكيد النقد.
  - الدفع/الاسترجاع.
  - SOS.
- إضافة اختبارات Widget/Navigation للتطبيقين.

## مراجعة RTL والشاشات

- التطبيقات تعمل بـ `Locale('ar', 'YE')`.
- الواجهات الأساسية عربية وRTL.
- تمت مراجعة التبويبات الرئيسية:
  - العميل: الرئيسية، الرحلات، حسابي.
  - الكابتن: الرئيسية، الرحلات، المالية، حسابي.
- تم اختبار التنقل بينها عبر Widget Tests.
- لا توجد أخطاء `flutter analyze` حالياً في تطبيق العميل أو الكابتن.

## مراجعة الحماية على مستوى العميل

- لا توجد `print` أو `debugPrint` تعرض Tokens في كود التطبيقات.
- Authorization header يتم بناؤه داخل `MishwarApi` ولا يتم طباعته.
- Analytics filter في `mobile_runtime.dart` يستبعد مفاتيح حساسة مثل:
  - phone
  - name
  - coordinate
  - location
  - token
  - payment
  - wallet
  - kyc
- التخزين المحلي الحالي هو `SharedPreferences` للـ offline queue فقط.
- العمليات الحساسة غير مسموح بإعادة تشغيلها Offline إلا للمسارات المسموحة:
  - location updates.
  - device registration.
- عند تسجيل الخروج يتم حذف offline queue المحلي.

## ما لم يتم تغييره

- لم يتم تغيير Firebase Authentication.
- لم يتم تغيير Firestore Rules.
- لم يتم تغيير Backend.
- لم يتم تنفيذ commit أو push.

## نتائج الاختبارات

### Customer Analyze

الأمر:

```powershell
cd apps/customer_app
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics analyze
```

النتيجة: PASS

```text
No issues found! (ran in 20.4s)
```

### Driver Analyze

النتيجة: PASS

```text
No issues found! (ran in 20.2s)
```

### Customer Widget/Navigation Tests

الأمر:

```powershell
cd apps/customer_app
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$env:DART_SUPPRESS_ANALYTICS='true'
..\..\.codex\flutter-sdk\bin\flutter.bat --no-version-check --suppress-analytics test
```

النتيجة: PASS

```text
00:04 +2: All tests passed!
```

### Driver Widget/Navigation Tests

النتيجة: PASS

```text
00:03 +2: All tests passed!
```

## ملاحظات وثغرات متبقية للمهندس

- تنظيف الجلسة المحلي يحذف offline queue، لكنه لا يحذف أي بيانات قد تكون محفوظة مستقبلاً في caches جديدة. أي تخزين حساس لاحق يجب أن يستخدم secure storage أو لا يخزن أصلاً.
- التحقق النهائي من منع وصول مستخدم لبيانات مستخدم آخر يحتاج Firestore Rules وBackend Authorization tests في Pilot الحقيقي.
- حذف الحساب والخصوصية والدعم موجودة كطلبات API للمراجعة اليدوية، لكن سياسة التنفيذ النهائية يجب أن تكون في Backend/Admin وليس من التطبيق مباشرة.
- في وضع Demo لا يوجد Firebase Auth فعلي، لذلك زر الخروج ينظف البيانات المحلية فقط ولا يثبت خروجاً سحابياً.
- يجب عدم إرسال raw backend errors إلى الواجهة مستقبلاً؛ الأفضل أن يعيد Backend أكواد خطأ مترجمة/مصنفة.

## تقييم TASK 11

تطبيق العميل والكابتن جاهزان محلياً من ناحية UX الأساسية، RTL، منع التكرار، تنظيف الجلسة، واختبارات التنقل. الجاهزية الأمنية النهائية تحتاج اختبار Pilot حقيقي مع Firebase Auth وFirestore Rules وBackend Authorization.
