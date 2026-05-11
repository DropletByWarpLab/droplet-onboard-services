plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    // FCM is wired but opt-in: enable by uncommenting and dropping
    // google-services.json into app/.
    // alias(libs.plugins.google.services)
}

android {
    namespace = "ai.warplab.droplet"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.warplab.droplet"
        minSdk = 26          // Android 8.0 — covers >97% of devices in 2026, gets us EncryptedSharedPreferences + WebView modernity
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
    }

    signingConfigs {
        // Release signing is intentionally NOT committed. CI fills these from
        // GitHub Actions secrets (DROPLET_ANDROID_KEYSTORE_B64 +
        // DROPLET_ANDROID_KEYSTORE_PASSWORD + DROPLET_ANDROID_KEY_ALIAS +
        // DROPLET_ANDROID_KEY_PASSWORD). Locally, debug builds work without
        // any keystore config at all.
        create("release") {
            val keystoreFile = System.getenv("DROPLET_ANDROID_KEYSTORE_PATH")
            if (!keystoreFile.isNullOrBlank()) {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("DROPLET_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DROPLET_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("DROPLET_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
            isDebuggable = true
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Only sign if keystore env is provided — otherwise leave unsigned
            // so CI fails loud rather than silently shipping a debug-signed
            // release APK.
            if (System.getenv("DROPLET_ANDROID_KEYSTORE_PATH") != null) {
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
        freeCompilerArgs += listOf(
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
            "-opt-in=androidx.compose.foundation.ExperimentalFoundationApi",
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi"
        )
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Compose BOM — versions for every androidx.compose.* artifact below are
    // resolved from this single coordinate.
    implementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(platform(libs.androidx.compose.bom))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)

    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.webkit)

    // CameraX + ML Kit for QR pair-URL scanner
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)

    implementation(libs.accompanist.permissions)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    // Firebase (push). Activate by uncommenting the google-services plugin
    // above + adding google-services.json. Without those, the dependency is
    // dead weight — that's why FCM is gated behind BuildConfig.PUSH_ENABLED.
    // implementation(platform(libs.firebase.bom))
    // implementation(libs.firebase.messaging)

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.truth)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
