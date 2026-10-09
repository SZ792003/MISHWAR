import java.io.FileInputStream
import java.util.Properties

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseKeystore = keystorePropertiesFile.exists()
if (hasReleaseKeystore) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

fun validateReleaseEnvironment() {
    val appMode = ((project.findProperty("mishwarReleaseAppMode") as String?)
        ?: System.getenv("MISHWAR_RELEASE_APP_MODE")
        ?: "").lowercase()
    val apiUrl = ((project.findProperty("mishwarReleaseApiUrl") as String?)
        ?: System.getenv("MISHWAR_RELEASE_API_URL")
        ?: "").lowercase()
    require(appMode == "pilot" || appMode == "production") {
        "Release builds require -PmishwarReleaseAppMode=pilot|production or MISHWAR_RELEASE_APP_MODE."
    }
    require(apiUrl.startsWith("https://") && !apiUrl.contains("localhost") && !apiUrl.contains("127.0.0.1") && !apiUrl.contains("demo")) {
        "Release builds require a real HTTPS backend via -PmishwarReleaseApiUrl or MISHWAR_RELEASE_API_URL."
    }
}

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
}

android {
    namespace = "com.mishwar.driver"
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.mishwar.driver"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = 36
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

gradle.taskGraph.whenReady {
    val buildingRelease = allTasks.any {
        it.name.contains("release", ignoreCase = true) &&
            (it.name.contains("bundle", ignoreCase = true) || it.name.contains("assemble", ignoreCase = true))
    }
    if (buildingRelease) {
        validateReleaseEnvironment()
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
