package com.droplet.mobile.files

import com.droplet.mobile.CredentialStore
import com.droplet.mobile.DropletSession
import io.ktor.client.HttpClient
import io.ktor.http.ContentType
import io.ktor.utils.io.ByteReadChannel

/**
 * High-level façade over [WebDavClient] that reads the active session from
 * the [CredentialStore] on every call. If the user unpairs, the next call
 * throws [WebDavException.Unauthorized] — the UI layer surfaces that as
 * "you've been signed out."
 */
class FilesRepository(
    private val credentialStore: CredentialStore,
    private val httpClient: HttpClient,
) {

    suspend fun list(path: String, depth: Int = 1): List<WebDavEntry> =
        webdav().list(path, depth)

    suspend fun download(path: String): ByteReadChannel =
        webdav().download(path)

    suspend fun upload(
        path: String,
        body: ByteArray,
        contentType: ContentType? = null,
    ) {
        val client = webdav()
        // Best-effort parent-dir creation so the first photo of the
        // month doesn't 409 with "missing intermediate folders".
        val parent = path.substringBeforeLast('/', missingDelimiterValue = "")
        if (parent.isNotEmpty()) client.ensureDirectory(parent)
        client.upload(path = path, contentType = contentType, body = body)
    }

    suspend fun ensureDirectory(path: String) {
        webdav().ensureDirectory(path)
    }

    fun currentSessionOrNull(): DropletSession? = credentialStore.load()

    private fun webdav(): WebDavClient {
        val session = credentialStore.load()
            ?: throw WebDavException.Unauthorized
        return WebDavClient(
            webdavBaseUrl = session.webdavUrl,
            username = session.username,
            appPassword = session.appPassword,
            http = httpClient,
        )
    }
}
