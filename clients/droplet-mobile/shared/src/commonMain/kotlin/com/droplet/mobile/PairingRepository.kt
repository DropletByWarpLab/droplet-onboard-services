package com.droplet.mobile

/**
 * Two-step orchestration of the pair flow:
 *
 *  1. [signIn]      → calls /api/auth/login. Cookie jar inside the api client
 *                     captures the session cookie for subsequent calls.
 *  2. [claim]       → calls /api/devices/pair/claim using the scanned URI's
 *                     server + code, then persists the returned credentials
 *                     to the encrypted [credentialStore].
 *
 * The repository is constructed per-server because the [DropletApiClient]
 * binds its base URL up-front. [forServer] mints a fresh instance once the
 * user has scanned the pair URI (or selected a server manually).
 */
class PairingRepository(
    private val api: DropletApiClient,
    private val credentialStore: CredentialStore,
    private val deviceInfo: DeviceInfo,
    private val serverUrl: String,
) {
    suspend fun signIn(username: String, password: String): LoginResponse =
        api.login(username, password)

    suspend fun claim(pairUri: DropletPairUri, signedInUser: LoginResponse.User): DropletSession {
        require(pairUri.server.trimEnd('/') == serverUrl.trimEnd('/')) {
            "Pair URI server (${pairUri.server}) does not match repository server ($serverUrl)"
        }
        val claim = api.claimPairingCode(
            code = pairUri.code,
            deviceName = deviceInfo.deviceName,
            appVersion = deviceInfo.appVersion,
        )
        val session = DropletSession(
            serverUrl = serverUrl,
            username = claim.ncUsername,
            displayName = signedInUser.displayName,
            deviceId = claim.deviceId,
            deviceName = deviceInfo.deviceName,
            webdavUrl = claim.webdavUrl,
            appPassword = claim.appPassword,
        )
        credentialStore.save(session)
        return session
    }

    fun currentSession(): DropletSession? = credentialStore.load()

    fun forget() {
        credentialStore.clear()
        api.close()
    }
}
