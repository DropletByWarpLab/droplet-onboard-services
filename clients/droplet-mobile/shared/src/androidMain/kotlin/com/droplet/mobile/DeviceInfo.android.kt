package com.droplet.mobile

import android.os.Build

/**
 * Produces the "deviceName" the orchestrator stores against the paired
 * device, e.g. "Pixel 8 (Stefan)". Falls back to the OEM/model when no
 * user-provided owner name is supplied.
 */
actual class DeviceInfo actual constructor(
    ownerName: String?,
    actual val appVersion: String,
) {
    actual val deviceName: String = buildString {
        append(Build.MODEL.takeIf { it.isNotBlank() } ?: Build.DEVICE ?: "Android device")
        if (!ownerName.isNullOrBlank()) {
            append(" (")
            append(ownerName.trim())
            append(')')
        }
    }

    actual val platform: String = "android"
}
