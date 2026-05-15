package com.droplet.mobile

import kotlinx.serialization.Serializable

/**
 * Everything the app needs to keep talking to a paired Droplet across launches.
 *
 * Persisted on Android via [CredentialStore] backed by EncryptedSharedPreferences
 * (Tink AES-GCM keyed in the AndroidKeyStore). The `appPassword` field is the
 * single-use plaintext returned by `/api/devices/pair/claim` — once the user
 * unpairs, it must be revoked and removed.
 */
@Serializable
data class DropletSession(
    val serverUrl: String,
    val username: String,
    val displayName: String,
    val deviceId: String,
    val deviceName: String,
    val webdavUrl: String,
    val appPassword: String,
)
