# Kotlinx Serialization — keep generated $serializer classes
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class com.droplet.mobile.**$$serializer { *; }
-keepclassmembers class com.droplet.mobile.** {
    *** Companion;
}
-keepclasseswithmembers class com.droplet.mobile.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Ktor uses reflection in a few corners
-dontwarn io.netty.**
-dontwarn org.slf4j.**

# ML Kit
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.** { *; }
