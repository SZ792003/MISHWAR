# MISHWAR - TASK 20 FINANCE, WALLET & BANKING REPORT

تاريخ التقرير: 2026-10-11

## ما كان موجوداً قبل التنفيذ

- `PaymentService` يحسب الدفع من أجرة الرحلة المعتمدة من Backend، ولا يقبل مبلغاً من العميل كمرجع نهائي.
- `FinancialOperationsService` يحتوي كشف حساب للكابتن، تسويات عمولة، طلبات سحب، Refund، Reconciliation، Adjustments، وDemo digital payment.
- العمولة 10% موجودة عبر `calculateCommission` باستخدام أعداد صحيحة للريال اليمني.
- Ledger يستخدم `FinancialTransaction` بأنواع مثل `ride_payment`, `platform_commission`, `driver_earning`, `commission_settlement`, `commission_offset`, `refund`, `adjustment`.
- الدفع الحقيقي غير مفعل افتراضياً، و`NotConfiguredPaymentProvider` يمنع أي محاولة بلا إعداد رسمي.

## النواقص المؤكدة

- لا يوجد مزود دفع بنكي/محفظة يمنية حقيقي موثق أو مفعل.
- لا توجد Webhooks حقيقية لأن المزود الرسمي غير متوفر.
- Firestore Transactions للمالية تحتاج اختبار Emulator/مشروع Firebase حقيقي قبل Pilot.
- Admin finance في الواجهة web الحالية ما زالت تعتمد جزئياً على بيانات/حسابات محلية وقد تحتاج ربطاً كاملاً مع endpoints الحديثة.
- لا يوجد زر سحب أموال حقيقي مفعل، وهذا صحيح حتى اعتماد مزود مالي وسياسة تشغيل.

## ما تمت إضافته أو إصلاحه

- إصلاح فجوة Demo محلية: عند تأكيد الدفع النقدي أو دفع wallet في الذاكرة، يتم الآن إدخال payment ledger أيضاً إلى `FinancialOperationsService` حتى تظهر في شاشة حساب الكابتن المالية.
- إضافة `recordMemoryPaymentLedger` داخل `FinancialOperationsService` بدل إنشاء نظام مالي جديد.
- إضافة اختبار في `paymentCoreSmokeTest.ts` يؤكد أن رحلة نقدية بقيمة 2,000 ريال تظهر في كشف الكابتن وأن مديونية العمولة تصبح 200 ريال.
- إضافة `SimulatedPaymentProvider` داخل adapter الحالي:
  - يعمل فقط إذا كان `PAYMENT_PROVIDER` من قيم mock/simulated وكان `APP_MODE` غير strict و`USE_REAL_PAYMENT=false`.
  - يضع metadata `simulationOnly: true`.
  - لا يحفظ أسراراً ولا يتصل بأي خدمة خارجية.
  - يدعم create/verify/cancel/refund/webhook بشكل محاكى للاختبارات المستقبلية.
- تحديث `.env.example` بتوضيح غير سري للمزود المحاكى.

## الملفات المعدلة

- `.env.example`
- `backend/src/payments/paymentService.ts`
- `backend/src/payments/financialOperationsService.ts`
- `backend/src/payments/paymentProvider.ts`
- `backend/scripts/paymentCoreSmokeTest.ts`

## الاختبارات المنفذة

| الاختبار | النتيجة | الملاحظات |
|---|---|---|
| `npm.cmd run typecheck` | PASS | TypeScript ناجح. |
| `npm.cmd run test:payments` | PASS | Payment core + financial operations smoke tests نجحت. |
| `npm.cmd run test:dispatch` | PASS | لم تتأثر حماية قبول الرحلات. |
| `npm.cmd run test:bidding` | PASS | لم تتأثر عروض الأسعار. |
| `npm.cmd run scan:secrets` | PASS | لا توجد أسرار مكتشفة. |
| Firestore Transaction tests | BLOCKED | تحتاج Emulator/مشروع Firebase معد. |
| Webhook provider حقيقي | BLOCKED | لا يوجد مزود رسمي أو مفاتيح. |

## السيناريوهات المالية المغطاة محلياً

- رحلة نقدية تسجل عمولة كمديونية على الكابتن.
- عشر رحلات نقدية ومديونية مجمعة.
- تسوية جزئية وكاملة.
- رفض تسوية أكبر من الدين.
- Idempotency للتسويات وطلبات السحب والRefund.
- دفع إلكتروني تجريبي موسوم `simulationOnly`.
- مقاصة جزئية من مستحق الكابتن ضد دين قديم في المحاكاة.
- Refund وReconciliation mismatch وduplicate ledger.
- رفض الكابتن الموقوف/المحظور من طلب السحب.

## المخاطر المالية المتبقية

- يجب عدم اعتبار الرصيد التجريبي أو المزود المحاكى أموالاً حقيقية.
- يجب اختبار Firestore persistence والـ transactions قبل أي Pilot مالي.
- أي مزود دفع يمني حقيقي يحتاج عقد API رسمي، توقيع Webhook، سياسة تسوية، وحدود تشغيل ومراجعة قانونية.
- لا يجب تنفيذ تحويل خارجي داخل Firestore Transaction قابلة لإعادة المحاولة.

## جاهزية TASK 20

جاهز محلياً للاختبار المالي غير الحقيقي، وجاهز لتسليم عقود التكامل لمهندس السحابة/الدفع. غير جاهز لتفعيل مدفوعات أو سحوبات حقيقية.
