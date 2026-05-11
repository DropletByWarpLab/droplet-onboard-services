# Default Android proguard rules already handle ~99% of cases. Project-specific
# rules go here.

# Kotlin Serialization — keep @Serializable classes' metadata so reflection-free
# (de)serialization still works after R8.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keep,includedescriptorclasses class ai.warplab.droplet.**$$serializer { *; }
-keepclassmembers class ai.warplab.droplet.** {
    *** Companion;
}
-keepclasseswithmembers class ai.warplab.droplet.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# ML Kit dynamic class loading
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }

# Keep WebView JS bridge class methods discoverable by name.
-keepclassmembers class ai.warplab.droplet.ui.dashboard.DropletJsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
