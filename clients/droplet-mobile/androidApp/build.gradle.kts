plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.kotlinAndroid)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.composeCompiler)
}

val applicationIdProp: String = project.findProperty("droplet.applicationId") as? String ?: "com.droplet.android"
val versionNameProp: String = project.findProperty("droplet.versionName") as? String ?: "0.1.0"
val versionCodeProp: Int = (project.findProperty("droplet.versionCode") as? String)?.toIntOrNull() ?: 1

/**
 * Release signing config sources, in order of precedence:
 *   1. Environment variables (CI: DROPLET_KEYSTORE_PATH, DROPLET_KEYSTORE_PASSWORD,
 *      DROPLET_KEY_ALIAS, DROPLET_KEY_PASSWORD).
 *   2. ~/.gradle/gradle.properties (recommended for local dev — outside the repo).
 *   3. droplet-mobile/local.properties (gitignored).
 *
 * If none of the three are populated, the release build skips signing and
 * produces an unsigned APK — useful for compile-checks in CI without
 * leaking a keystore.
 */
val signingKeystorePath: String? = System.getenv("DROPLET_KEYSTORE_PATH")
    ?: (project.findProperty("droplet.keystore.path") as? String)
val signingKeystorePassword: String? = System.getenv("DROPLET_KEYSTORE_PASSWORD")
    ?: (project.findProperty("droplet.keystore.password") as? String)
val signingKeyAlias: String? = System.getenv("DROPLET_KEY_ALIAS")
    ?: (project.findProperty("droplet.key.alias") as? String)
val signingKeyPassword: String? = System.getenv("DROPLET_KEY_PASSWORD")
    ?: (project.findProperty("droplet.key.password") as? String)

val releaseSigningConfigured: Boolean = !signingKeystorePath.isNullOrBlank()
    && !signingKeystorePassword.isNullOrBlank()
    && !signingKeyAlias.isNullOrBlank()
    && !signingKeyPassword.isNullOrBlank()

android {
    namespace = "com.droplet.mobile.android"
    compileSdk = 35

    defaultConfig {
        applicationId = applicationIdProp
        minSdk = 26
        targetSdk = 35
        versionCode = versionCodeProp
        versionName = versionNameProp

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(signingKeystorePath!!)
                storePassword = signingKeystorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            buildConfigField("boolean", "ALLOW_SELF_SIGNED", "true")
        }
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            buildConfigField("boolean", "ALLOW_SELF_SIGNED", "false")
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
    }
}

dependencies {
    implementation(project(":shared"))

    implementation(libs.core.ktx)

    // Compose
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    // Lifecycle + Navigation
    implementation(libs.activity.compose)
    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)

    // DI
    implementation(libs.koin.android)
    implementation(libs.koin.androidx.compose)

    // CameraX + ML Kit
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.accompanist.permissions)

    // Coroutines on Android
    implementation(libs.kotlinx.coroutines.android)

    // Tests
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.test.junit)
}
