package com.droplet.mobile

/**
 * Platform-specific encrypted blob store.
 *
 * Android: AndroidX Security EncryptedSharedPreferences (Tink AES-GCM,
 * AndroidKeyStore-backed master key).
 * iOS (future): Keychain Services, kSecAttrAccessibleAfterFirstUnlock.
 */
expect class CredentialStore {
    fun save(session: DropletSession)
    fun load(): DropletSession?
    fun clear()
}
