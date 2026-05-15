package com.droplet.mobile

/**
 * Identity the app reports to the orchestrator when claiming a pairing code.
 * `deviceName` ends up in the dashboard's connected-clients list, so it
 * should be recognisable to the owner ("Pixel 8 (Stefan)" rather than "P8").
 */
expect class DeviceInfo(ownerName: String?, appVersion: String) {
    val deviceName: String
    val appVersion: String

    /** One of the orchestrator's `platformSchema` enum values. */
    val platform: String
}
