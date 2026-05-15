package com.droplet.mobile

import com.liftric.kvault.KVault
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Keychain Services-backed store via Liftric's KVault. Items live as
 * `kSecClassGenericPassword` entries scoped to a per-service Keychain
 * partition. Accessibility defaults to
 * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — the item survives
 * across launches once the device has been unlocked after reboot, but
 * never leaves the device (no iCloud Keychain sync).
 *
 * The whole [DropletSession] is serialised as a single JSON blob to keep
 * read/write atomic at the entry level.
 */
actual class CredentialStore {
    private val vault = KVault(serviceName = "com.droplet.mobile.session")
    private val json = Json { ignoreUnknownKeys = true }

    actual fun save(session: DropletSession) {
        vault.set(KEY_SESSION, json.encodeToString(session))
    }

    actual fun load(): DropletSession? {
        val raw = vault.string(KEY_SESSION) ?: return null
        return runCatching { json.decodeFromString<DropletSession>(raw) }.getOrNull()
    }

    actual fun clear() {
        vault.deleteObject(KEY_SESSION)
    }

    private companion object {
        const val KEY_SESSION = "session_v1"
    }
}
