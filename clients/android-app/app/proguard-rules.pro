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

# NOTE: No JavaScript bridge yet — the dashboard runs in WebView without
# addJavascriptInterface. If we add one later, restore a -keepclassmembers
# rule keyed on @android.webkit.JavascriptInterface so R8 doesn't strip the
# bridge methods (which are called by name from JS, not from Kotlin).
