# MISHWAR — Firebase Live Setup

هذه الوثيقة تخص TASK 07A. الهدف هو تجهيز تطبيق العميل والكابتن للعمل مع مشروع Firebase الحالي `MISHWAR Pilot` وخادم Backend آمن. لا تنشئ مشروع Firebase جديداً، ولا تحفظ أي سر داخل Git.

## نتيجة التدقيق الحالية

### موجود وجاهز مبدئياً

- تطبيق العميل موجود في `apps/customer_app`.
- تطبيق الكابتن موجود في `apps/driver_app`.
- الحزمة المشتركة موجودة في `apps/mishwar_shared`.
- Android و iOS موجودان للتطبيقين.
- Firebase SDK موجود في Flutter:
  - `firebase_core`
  - `firebase_auth`
  - `cloud_firestore`
  - `firebase_messaging`
  - `firebase_crashlytics`
  - `firebase_analytics`
- Backend يستخدم Firebase Admin SDK عبر `backend/src/auth.ts`.
- Backend يدعم Application Default Credentials أو Service Account من متغيرات بيئة.
- `MISHWAR_APP_MODE=pilot` و `MISHWAR_API_BASE_URL=https://...` مفروضان في الحزمة المشتركة.
- وضع Pilot/Production يرفض `localhost` و `demo` كرابط API في `apps/mishwar_shared/lib/mishwar_api.dart`.
- العمليات المالية الحساسة في Firestore Rules محمية بكتابة Admin فقط.

### ناقص قبل Pilot حقيقي

- لا توجد ملفات Android Firebase:
  - `apps/customer_app/android/app/google-services.json`
  - `apps/driver_app/android/app/google-services.json`
- لا توجد ملفات iOS Firebase:
  - `apps/customer_app/ios/Runner/GoogleService-Info.plist`
  - `apps/driver_app/ios/Runner/GoogleService-Info.plist`
- لا يوجد `firebase_options.dart` مولد للتطبيقات.
- لم يتم تشغيل اختبار Firebase حقيقي في هذه المهمة.
- `apps/mishwar_shared` لم يكتمل تحليلها سابقاً بسبب حظر الوصول إلى `pub.dev`.
- Firestore Rules تسمح حالياً ببعض إنشاء/تحديث الرحلات من العملاء والكباتن. هذا مناسب لبعض نماذج Firestore المباشرة، لكنه مخاطرة عالية إذا كان Pilot يجب أن يجعل كل عمليات الرحلات عبر Backend فقط.

## Android Application IDs

تم التحقق من ملفات Gradle:

- تطبيق العميل:
  - `applicationId = "com.mishwar.customer"`
  - `namespace = "com.mishwar.customer"`
- تطبيق الكابتن:
  - `applicationId = "com.mishwar.driver"`
  - `namespace = "com.mishwar.driver"`

يجب تسجيل التطبيقين داخل نفس مشروع Firebase `MISHWAR Pilot` بهذه القيم بالضبط.

## خطوات Firebase اليدوية

نفذ هذه الخطوات بنفسك من Firebase Console:

1. افتح مشروع Firebase الحالي `MISHWAR Pilot`.
2. فعّل Authentication.
3. فعّل Phone Sign-in.
4. أضف أرقام اختبار مؤقتة فقط إن احتجت اختباراً مغلقاً بدون SMS حقيقي.
5. فعّل Cloud Firestore.
6. أنشئ قاعدة البيانات في المنطقة المناسبة للعمليات.
7. فعّل Cloud Messaging.
8. فعّل Crashlytics و Analytics للتطبيقين.
9. لا تفعّل دفعاً إلكترونياً حقيقياً.

## تسجيل تطبيق العميل Android

1. من Firebase Console اختر Add app ثم Android.
2. استخدم package name:

```text
com.mishwar.customer
```

3. أدخل SHA-1 و SHA-256 الخاصة بتوقيع Debug/Release.
4. نزّل `google-services.json`.
5. ضعه يدوياً هنا:

```text
apps/customer_app/android/app/google-services.json
```

## تسجيل تطبيق الكابتن Android

1. من Firebase Console اختر Add app ثم Android.
2. استخدم package name:

```text
com.mishwar.driver
```

3. أدخل SHA-1 و SHA-256 الخاصة بتوقيع Debug/Release.
4. نزّل `google-services.json`.
5. ضعه يدوياً هنا:

```text
apps/driver_app/android/app/google-services.json
```

## أوامر SHA

من كل تطبيق:

```powershell
cd apps/customer_app/android
.\gradlew signingReport
```

```powershell
cd apps/driver_app/android
.\gradlew signingReport
```

استخدم قيم SHA-1 و SHA-256 المناسبة للحزمة التي سترفعها إلى Google Play. إذا استخدمت Play App Signing، أضف أيضاً شهادات Play Console.

## FlutterFire

بعد تنزيل ملفات Firebase، يمكن توليد `firebase_options.dart` لكل تطبيق إذا قررت استخدام FlutterFire CLI:

```powershell
cd apps/customer_app
flutterfire configure --project=<MISHWAR_PILOT_PROJECT_ID> --platforms=android,ios --out=lib/firebase_options.dart
```

```powershell
cd apps/driver_app
flutterfire configure --project=<MISHWAR_PILOT_PROJECT_ID> --platforms=android,ios --out=lib/firebase_options.dart
```

ملاحظة: الكود الحالي يستخدم `Firebase.initializeApp()` بدون `DefaultFirebaseOptions`. هذا يعمل عادةً على Android/iOS عند وجود ملفات Firebase الأصلية، لكن وجود `firebase_options.dart` أوضح وأفضل للاختبار المتعدد.

## إعدادات تشغيل Flutter في Pilot

لا تستخدم `localhost` في Pilot. استخدم Backend HTTPS حقيقي:

```powershell
cd apps/customer_app
flutter run --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

```powershell
cd apps/driver_app
flutter run --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

لبناء APK/AAB مغلق:

```powershell
cd apps/customer_app
flutter build appbundle --release --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

```powershell
cd apps/driver_app
flutter build appbundle --release --dart-define=MISHWAR_APP_MODE=pilot --dart-define=MISHWAR_API_BASE_URL=https://<pilot-api-domain>
```

## Custom Claims المطلوبة

يجب ألا يحصل تطبيق العميل أو الكابتن على صلاحية ADMIN. الصلاحيات الموثوقة تأتي من Backend فقط عبر Firebase Admin SDK.

الأدوار:

- `CUSTOMER`
- `DRIVER`
- `KYC_REVIEWER`
- `FINANCE`
- `ADMIN`
- `SUPER_ADMIN`

أول Admin يتم تعيينه يدوياً من Backend بعد إعداد Firebase Admin:

```powershell
cd backend
npm run set-admin -- <firebase-admin-uid>
```

بعد ضبط claim يجب على المستخدم تسجيل الخروج والدخول من جديد حتى يحصل على ID Token محدث.

## KYC للكابتن

قبل قبول الرحلات في Pilot:

1. الكابتن يسجل عبر Firebase Phone Auth.
2. Backend أو لوحة الإدارة تنشئ/تحدّث سجل `driverKyc/{uid}`.
3. مراجع KYC يوافق على الكابتن.
4. Backend يمنح `DRIVER` claim فقط بعد الموافقة.
5. Backend يتحقق من KYC قبل عمليات DRIVER الحساسة.

الكود الحالي يحتوي حماية `requireApprovedDriverAccount` للكباتن أصحاب `authSource=firebase`.

## Firestore Rules

الملفات:

- `firebase/firestore.rules`
- `firebase/firestore.indexes.json`

قبل النشر:

```powershell
firebase emulators:start --only firestore
```

ثم شغّل اختبارات القواعد المطلوبة في `firebase/rules-tests`.

لا تنشر القواعد تلقائياً من هذه المهمة. عند الجاهزية فقط:

```powershell
firebase deploy --only firestore:rules,firestore:indexes --project <MISHWAR_PILOT_PROJECT_ID>
```

## مراجعة أمنية مهمة للقواعد الحالية

PASS:

- المستخدم لا يقرأ `users/{uid}` إلا لنفسه أو Admin.
- المستخدم لا يقرأ wallets إلا لنفسه أو Admin.
- العملاء والكباتن لا يكتبون `payments`.
- العملاء والكباتن لا يكتبون `financialTransactions`.
- العملاء والكباتن لا يكتبون `driverCommissionAccounts`.
- `rideBids` كتابة Admin فقط.

HIGH RISK قبل Pilot:

- `rides` تسمح بإنشاء رحلة من العميل مباشرة.
- `rides` تسمح بتحديث بعض حالات الرحلة من العميل أو الكابتن مباشرة.
- `rideOffers` تسمح للكابتن بتحديث حالة العرض.

إذا كان قرار Pilot هو "كل الرحلات عبر Backend فقط"، فيجب تعديل القواعد بحيث تصبح كتابة `rides`, `rideOffers`, `rideBids`, `payments`, `financialTransactions`, `driverCommissionAccounts` بواسطة Admin SDK فقط، مع السماح للعميل/الكابتن بالقراءة حسب المشاركة.

## FCM

الكود الحالي يسجل Device Token عبر:

- `apps/mishwar_shared/lib/mobile_runtime.dart`
- `MishwarApi.registerDeviceToken`
- Backend notification service

المطلوب يدوياً:

1. تأكد أن FCM مفعل في Firebase.
2. أضف إعدادات Android/iOS الصحيحة.
3. اختبر توكن من جهاز حقيقي.
4. لا تحفظ APNs أو مفاتيح خاصة داخل Git.

## معايير الجاهزية

PASS قبل Pilot فقط إذا:

- التطبيقان مسجلان في نفس مشروع Firebase.
- ملفات Firebase الأصلية موجودة محلياً وغير منشورة كأسرار إذا كانت سياسة المشروع تمنع ذلك.
- Backend يعمل بـ `APP_MODE=pilot`.
- `USE_REAL_AUTH=true`.
- `USE_REAL_DATABASE=true`.
- `/ready` يرجع `ready`.
- Firestore Rules مختبرة على Emulator.
- كابتن غير معتمد لا يستطيع قبول رحلة.
- العمليات المالية لا يمكن تعديلها من العميل أو الكابتن.

