package com.droplet.mobile

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * EncryptedSharedPreferences-backed store. Master key is generated and
 * sealed by the AndroidKeyStore so the prefs file is meaningless without
 * the device's hardware-backed key material.
 *
 * The session is serialised as a single JSON blob under one key to keep
 * the read/write API atomic at the prefs level.
 */
actual class CredentialStore(context: Context) {
    private val masterKey = MasterKey.Builder(context.applicationContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context.applicationContext,
        PREFS_FILE,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val json = Json {
        ignoreUnknownKeys = true
    }

    actual fun save(session: DropletSession) {
        prefs.edit()
            .putString(KEY_SESSION, json.encodeToString(session))
            .apply()
    }

    actual fun load(): DropletSession? {
        val raw = prefs.getString(KEY_SESSION, null) ?: return null
        return runCatching { json.decodeFromString<DropletSession>(raw) }.getOrNull()
    }

    actual fun clear() {
        prefs.edit().remove(KEY_SESSION).apply()
    }

    private companion object {
        const val PREFS_FILE = "droplet_session"
        const val KEY_SESSION = "session_v1"
    }
}
