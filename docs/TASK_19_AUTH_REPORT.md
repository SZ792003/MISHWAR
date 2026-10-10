# MISHWAR - TASK 19 AUTH REPORT

تاريخ التقرير: 2026-10-11

## ما كان موجوداً قبل التنفيذ

- Backend يدعم Firebase Admin عبر `backend/src/auth.ts` مع `verifyIdToken(..., true)` للتحقق من صلاحية ID Token ومنع التوكنات الملغاة.
- الأدوار الموثوقة موجودة في `backend/src/trustedRoles.ts`، مع مسارات اعتماد/رفض الكابتن ومنح/سحب claim `DRIVER`.
- حماية الأدوار في Backend موجودة عبر `requireApiAuth`/`requireRole`، ولا تعتمد على الدور القادم من Flutter في وضع Firebase.
- إدارة حظر/إيقاف الحسابات وسحب الجلسات موجودة في `backend/src/accountSecurity.ts`.
- تطبيقات Flutter تحتوي `AuthGate` وواجهة OTP عبر Firebase Phone Auth في `apps/mishwar_shared/lib/mobile_runtime.dart`.
- تسجيل الخروج ينظف offline queue ويزيل FCM token عند توفر Firebase.

## النواقص المؤكدة

- OTP الحقيقي يحتاج إعداد Firebase Console وتفعيل Phone Auth من مهندس Firebase.
- لا يوجد Google Sign-In مفعل في تطبيقات Flutter الحالية؛ لم أضفه لأن الحزم والإعدادات غير موجودة.
- لا توجد تجربة استكمال ملف العميل/الكابتن كاملة بعد OTP داخل Flutter؛ الموجود حالياً بوابة دخول ثم التطبيق.
- اختبار OTP صحيح/خاطئ فعلي BLOCKED لأنه يحتاج Firebase حقيقي أو Emulator معد مسبقاً.
- واجهات KYC في تطبيق الكابتن ترسل metadata/رابط مستند فقط، ورفع الملفات الحقيقي يعتمد على إعداد Storage/Firebase لاحقاً.

## ما تمت إضافته أو إصلاحه

- تقوية واجهة OTP في `apps/mishwar_shared/lib/mobile_runtime.dart`:
  - التحقق من رقم يمني بصيغة `+967` أو `967` أو رقم محلي يبدأ بـ `0`.
  - قبول نطاقات أرقام يمنية للجوال: `70`, `71`, `73`, `77`, `78`.
  - منع إرسال OTP قبل صحة الرقم.
  - منع إعادة إرسال الرمز أثناء مهلة 60 ثانية.
  - التحقق من شكل رمز OTP رقمياً قبل محاولة Firebase.

## الملفات المعدلة

- `apps/mishwar_shared/lib/mobile_runtime.dart`

ملحوظة: توجد تعديلات سابقة من TASK 16-18 في ملفات Flutter أخرى ولم يتم التراجع عنها.

## الاختبارات المنفذة

| الاختبار | النتيجة | الملاحظات |
|---|---|---|
| `npm.cmd run typecheck` | PASS | Backend TypeScript ناجح. |
| `npm.cmd run test:ride-auth` | PASS | تحقق محلي من رفض token ناقص/خاطئ، رفض الدور الخطأ، منع قراءة رحلة لا تخص المستخدم، ومنع انتقالات رحلة غير صحيحة. |
| `flutter analyze --no-pub` في `apps/mishwar_shared` | PASS | لا توجد مشاكل تحليل. |
| `flutter test --no-pub` في `apps/mishwar_shared` | PASS | 8 اختبارات نجحت. |
| `flutter analyze` في العميل والكابتن | PASS | لا توجد مشاكل تحليل. |
| `flutter test` في العميل والكابتن | PASS | 4 اختبارات لكل تطبيق نجحت. |
| OTP Firebase الحقيقي | BLOCKED | يحتاج إعداد Firebase/Phone Auth أو Emulator. |
| Google Sign-In | BLOCKED | غير موجود حالياً في الحزم والإعدادات. |

## مشاكل تحتاج مهندس السحابة

- تفعيل Firebase Phone Auth للتطبيقين وربط SHA-1/SHA-256 وحزم Android النهائية.
- تعريف Custom Claims للأدوار: `CUSTOMER`, `DRIVER`, `FINANCE`, `KYC_REVIEWER`, `ADMIN`, `SUPER_ADMIN`.
- تأكيد سياسة ربط الهاتف وGoogle لاحقاً لمنع إنشاء حسابين لنفس الشخص.
- نشر Firestore Rules بعد مراجعتها فقط، خصوصاً `users`, `drivers`, `driverKyc`.
- تفعيل سحب الجلسات عند الحظر/الإيقاف واختباره على جهاز فعلي.

## المخاطر المتبقية

- لا يجوز اعتبار واجهة OTP دليلاً على نجاح المصادقة حتى تعمل Firebase Phone Auth فعلياً.
- اعتماد الكابتن لا يثبت بالـ OTP وحده؛ يجب اكتمال KYC ومنح claim `DRIVER` من Backend/Admin.
- في Demo ما زالت رؤوس `x-user-id` و`x-user-role` مستخدمة للاختبارات فقط؛ يجب منع Demo fallback في Pilot/Production.

## جاهزية TASK 19

جاهز محلياً من ناحية الكود والواجهات الأساسية، لكنه غير جاهز كـ Production Auth حتى يكتمل إعداد Firebase الحقيقي واختبارات OTP والجلسات على جهازين فعليين.
