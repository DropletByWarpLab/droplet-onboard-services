package com.droplet.mobile

import platform.UIKit.UIDevice

actual class DeviceInfo actual constructor(
    ownerName: String?,
    actual val appVersion: String,
) {
    actual val deviceName: String = buildString {
        append(UIDevice.currentDevice.name)
        if (!ownerName.isNullOrBlank()) {
            append(" (")
            append(ownerName.trim())
            append(')')
        }
    }

    actual val platform: String = "ios"
}
