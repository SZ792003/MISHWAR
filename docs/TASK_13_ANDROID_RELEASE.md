# MISHWAR — TASK 13 Android Release Preparation

تاريخ المراجعة: 2026-10-10 بتوقيت Asia/Aden.

## النتيجة المختصرة

تم تجهيز أساس Android Release لتطبيق العميل والكابتن بدون نشر وبدون تغيير Firebase Credentials. لم يتم إنشاء AAB لأن المتطلبات الآمنة غير مكتملة: لا توجد ملفات `google-services.json`، لا يوجد `key.properties` حقيقي للتوقيع، وتم رفض تنزيل Gradle wrapper المطلوب للتحقق/البناء.

الحالة العامة: PARTIAL / BLOCKED للبناء.

## الملفات المعدلة

- `apps/customer_app/android/app/build.gradle.kts`
- `apps/customer_app/android/app/src/main/AndroidManifest.xml`
- `apps/customer_app/android/app/src/main/res/drawable/launch_background.xml`
- `apps/customer_app/android/app/src/main/res/drawable-v21/launch_background.xml`
- `apps/customer_app/android/app/src/main/res/values/strings.xml`
- `apps/customer_app/android/app/src/main/res/values/colors.xml`
- `apps/driver_app/android/app/build.gradle.kts`
- `apps/driver_app/android/app/src/main/AndroidManifest.xml`
- `apps/driver_app/android/app/src/main/res/drawable/launch_background.xml`
- `apps/driver_app/android/app/src/main/res/drawable-v21/launch_background.xml`
- `apps/driver_app/android/app/src/main/res/values/strings.xml`
- `apps/driver_app/android/app/src/main/res/values/colors.xml`
- `docs/TASK_13_ANDROID_RELEASE.md`

## Application IDs

| التطبيق | Application ID | الحالة |
|---|---|---|
| العميل | `com.mishwar.customer` | PASS |
| الكابتن | `com.mishwar.driver` | PASS |

## أسماء التطبيقات

تم نقل اسم التطبيق من hardcoded manifest label إلى `@string/app_name`.

| التطبيق | الاسم النهائي |
|---|---|
| العميل | `مشوار` |
| الكابتن | `مشوار كابتن` |

## SDK وGoogle Play

حسب متطلبات Google Play الحالية، ابتداءً من 31 أغسطس 2026 يجب أن تستهدف التطبيقات الجديدة والتحديثات Android 16 / API 36 أو أعلى.

تم ضبط:

- `compileSdk = 37`
- `targetSdk = 36`
- Android SDK محلي موجود: `android-37.0`
- Android Gradle Plugin: `9.1.0`
- Kotlin plugin: `2.4.0`
- Java: يوجد JBR داخل Android Studio في:
  - `C:\Program Files\Android\Android Studio\jbr`

## versionCode وversionName

الإعداد الحالي من `pubspec.yaml` في التطبيقين:

- `versionName = 1.0.0`
- `versionCode = 1`

هذا صالح كإصدار أولي، لكن قبل كل رفع لاحق يجب زيادة `versionCode`.

## حواجز Release الآمنة

تمت إضافة تحقق Gradle يمنع build release إذا لم يتم توفير:

- `mishwarReleaseAppMode=pilot|production`
- `mishwarReleaseApiUrl=https://...`

ويرفض:

- `localhost`
- `127.0.0.1`
- أي URL يحتوي `demo`
- أي URL غير HTTPS

هذا الحاجز لا يضع أسراراً ولا يغير Firebase. هدفه منع بناء Release بالخطأ على Demo أو localhost.

## التوقيع

موجود مسبقاً:

- `android/key.properties.example`
- `.gitignore` يمنع:
  - `key.properties`
  - `*.jks`
  - `*.keystore`

لم يتم إنشاء مفاتيح توقيع. يجب على صاحب المشروع إنشاء Upload Key خارج Git.

أوامر مقترحة:

```powershell
keytool -genkeypair -v `
  -keystore release-keystores/mishwar-customer-upload.jks `
  -storetype JKS `
  -keyalg RSA `
  -keysize 2048 `
  -validity 10000 `
  -alias mishwar-customer-upload
```

```powershell
keytool -genkeypair -v `
  -keystore release-keystores/mishwar-driver-upload.jks `
  -storetype JKS `
  -keyalg RSA `
  -keysize 2048 `
  -validity 10000 `
  -alias mishwar-driver-upload
```

ثم انسخ `key.properties.example` إلى `key.properties` داخل مجلد `android` لكل تطبيق، وضع القيم الحقيقية محلياً فقط.

## Firebase المطلوب قبل AAB

الملفات غير موجودة حالياً:

- `apps/customer_app/android/app/google-services.json`
- `apps/driver_app/android/app/google-services.json`

يجب أن تكون التطبيقات مسجلة في نفس Firebase Project، مع package names:

- `com.mishwar.customer`
- `com.mishwar.driver`

لا تضع Firebase credentials أو service account داخل Git.

## أوامر إنشاء AAB بعد اكتمال المتطلبات

### العميل

```powershell
cd apps/customer_app
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:MISHWAR_RELEASE_APP_MODE='pilot'
$env:MISHWAR_RELEASE_API_URL='https://YOUR_BACKEND_DOMAIN'
..\..\.codex\flutter-sdk\bin\flutter.bat build appbundle --release `
  --dart-define=MISHWAR_APP_MODE=pilot `
  --dart-define=MISHWAR_API_BASE_URL=https://YOUR_BACKEND_DOMAIN
```

الناتج المتوقع:

```text
apps/customer_app/build/app/outputs/bundle/release/app-release.aab
```

### الكابتن

```powershell
cd apps/driver_app
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:MISHWAR_RELEASE_APP_MODE='pilot'
$env:MISHWAR_RELEASE_API_URL='https://YOUR_BACKEND_DOMAIN'
..\..\.codex\flutter-sdk\bin\flutter.bat build appbundle --release `
  --dart-define=MISHWAR_APP_MODE=pilot `
  --dart-define=MISHWAR_API_BASE_URL=https://YOUR_BACKEND_DOMAIN
```

الناتج المتوقع:

```text
apps/driver_app/build/app/outputs/bundle/release/app-release.aab
```

## حالة إنشاء AAB

لم يتم إنشاء AAB.

الأسباب:

- تم رفض تنزيل Gradle wrapper من `services.gradle.org`.
- لا توجد ملفات `google-services.json`.
- لا يوجد `key.properties` حقيقي.
- لم يتم توفير Backend HTTPS نهائي.
- لم يتم توفير `MISHWAR_RELEASE_APP_MODE` و`MISHWAR_RELEASE_API_URL`.

فحص الملفات الناتجة:

```text
لا توجد ملفات *.aab داخل apps/customer_app/build أو apps/driver_app/build
```

## نتائج الاختبارات

### Flutter Analyze

| التطبيق | النتيجة |
|---|---|
| العميل | PASS — `No issues found!` |
| الكابتن | PASS — `No issues found!` |

### Flutter Test

| التطبيق | النتيجة |
|---|---|
| العميل | PASS — `00:03 +2: All tests passed!` |
| الكابتن | PASS — `00:04 +2: All tests passed!` |

### Gradle DSL / Tasks

الحالة: BLOCKED

السبب:

```text
Downloading https://services.gradle.org/distributions/gradle-9.3.1-all.zip
java.net.SocketException: Permission denied: connect
```

تم طلب السماح الشبكي، وتم رفضه.

## الأذونات وسياسات المتجر

### تطبيق العميل

الأذونات:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `POST_NOTIFICATIONS`

التقييم: مناسبة لتطبيق حجز مشاوير. لا يوجد `ACCESS_BACKGROUND_LOCATION`.

### تطبيق الكابتن

الأذونات:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `POST_NOTIFICATIONS`
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_LOCATION`

التقييم: تحتاج تبريراً واضحاً في Play Console لأن الكابتن يشارك الموقع أثناء الرحلة. لا يوجد `ACCESS_BACKGROUND_LOCATION`، وهذا يقلل خطر الرفض.

## الأيقونات وشاشة البداية

- تم تحسين لون شاشة البداية إلى لون داكن متوافق مع هوية مشوار.
- الأيقونة الحالية ما زالت شعار Flutter الافتراضي، وهذا غير جاهز للمتجر.

المطلوب يدوياً:

- تصميم Launcher Icon للعميل.
- تصميم Launcher Icon للكابتن.
- إنتاج adaptive icons لكل الكثافات.
- مراجعة splash screen بصورة نهائية تحمل هوية مشوار.

## Google Play Store Listing Checklist

لكل تطبيق:

- اسم التطبيق.
- وصف قصير.
- وصف كامل.
- Screenshots للهاتف.
- App icon نهائي.
- Feature graphic.
- تصنيف الفئة: Maps & Navigation أو Travel/Transport حسب قرار النشر.
- بيانات التواصل والدعم.
- رابط سياسة الخصوصية.
- رابط حذف الحساب أو تعليمات حذف الحساب.
- حساب اختبار للمراجعة إن احتاج Google.
- شرح أذونات الموقع والإشعارات.

## Privacy / Data Safety

يجب تجهيز إجابات Data Safety بصدق، خصوصاً:

- الموقع التقريبي والدقيق.
- رقم الهاتف أو معرف المستخدم.
- بيانات الرحلات.
- بيانات الدفع النقدي/المالي داخلياً.
- الإشعارات وFCM token.
- الدعم والشكاوى.
- KYC للكابتن عند تفعيله.

يجب توفير:

- Privacy Policy URL.
- Terms URL.
- Account deletion flow URL أو تعليمات داخل التطبيق/الموقع.
- Support URL أو email.

## المتطلبات اليدوية الناقصة

- إضافة `google-services.json` لكل تطبيق.
- إعداد Upload Key لكل تطبيق خارج Git.
- إنشاء `key.properties` حقيقي محلياً فقط.
- توفير Backend HTTPS نهائي.
- تمرير `--dart-define` الصحيح عند build.
- توفير `MISHWAR_RELEASE_APP_MODE` و`MISHWAR_RELEASE_API_URL`.
- تصميم أيقونات متجر نهائية.
- تجهيز Store Listing وData Safety.
- السماح بتنزيل Gradle wrapper أو توفيره مسبقاً في cache.

## جاهزية الرفع التجريبي

| التطبيق | الجاهزية |
|---|---|
| العميل | NOT READY لرفع AAB حتى تكتمل Firebase/signing/icons/backend HTTPS |
| الكابتن | NOT READY لرفع AAB حتى تكتمل Firebase/signing/icons/backend HTTPS وتبرير أذونات foreground location |

## الخلاصة

تم تجهيز أساس Release الآمن وضبط target SDK المطلوب وحواجز منع demo/localhost. لكن إنشاء AAB والرفع التجريبي ما زالا محجوبين حتى تكتمل المتطلبات اليدوية أعلاه.
