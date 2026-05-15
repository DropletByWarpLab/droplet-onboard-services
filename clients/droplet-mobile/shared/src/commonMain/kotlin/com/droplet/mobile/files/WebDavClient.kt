package com.droplet.mobile.files

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.client.request.put
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.utils.io.ByteReadChannel
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Minimal Nextcloud-flavoured WebDAV client.
 *
 * Speaks Basic auth using the `appPassword` minted at pair time (NEVER the
 * user's login password — that one only goes over `/api/auth/login`). The
 * username + appPassword are scoped to this device and revoked when the
 * user removes the device from the dashboard.
 *
 * All paths are user-relative — `Photos/IMG_1.jpg`, not the full WebDAV URL.
 * The client appends them to [webdavBaseUrl] and percent-encodes each path
 * segment so spaces and Unicode in filenames round-trip safely.
 */
@OptIn(ExperimentalEncodingApi::class)
class WebDavClient(
    private val webdavBaseUrl: String,
    private val username: String,
    private val appPassword: String,
    private val http: HttpClient,
) {

    private val authHeader: String = "Basic ${Base64.encode("$username:$appPassword".encodeToByteArray())}"

    suspend fun list(path: String, depth: Int = 1): List<WebDavEntry> {
        val response = http.request(buildUrl(path)) {
            method = HttpMethod("PROPFIND")
            headers {
                append(HttpHeaders.Authorization, authHeader)
                append("Depth", depth.toString())
            }
            contentType(ContentType.Application.Xml)
            setBody(PROPFIND_BODY)
        }
        if (response.status.value !in 200..299) {
            throw WebDavException.from(response)
        }
        val xml = response.bodyAsText()
        val entries = PropFindParser.parse(xml, webdavBaseUrl)
        // Drop the "self" entry whose path is empty after stripping the base
        // — that's the directory itself, not one of its children.
        return entries.filter { it.path.isNotEmpty() }
    }

    suspend fun download(path: String): ByteReadChannel {
        val response = http.get(buildUrl(path)) {
            headers.append(HttpHeaders.Authorization, authHeader)
        }
        if (response.status.value !in 200..299) {
            throw WebDavException.from(response)
        }
        return response.bodyAsChannel()
    }

    suspend fun upload(
        path: String,
        contentType: ContentType?,
        body: ByteArray,
    ) {
        val response = http.put(buildUrl(path)) {
            headers {
                append(HttpHeaders.Authorization, authHeader)
            }
            if (contentType != null) contentType(contentType)
            setBody(body)
        }
        if (response.status.value !in 200..299) {
            throw WebDavException.from(response)
        }
    }

    /**
     * Create a directory (collection). Idempotent: a 405 ("method not
     * allowed") is treated as success since Nextcloud returns that when
     * the collection already exists.
     */
    suspend fun mkdir(path: String) {
        val response = http.request(buildUrl(path)) {
            method = HttpMethod("MKCOL")
            headers.append(HttpHeaders.Authorization, authHeader)
        }
        when (response.status) {
            HttpStatusCode.Created, HttpStatusCode.OK, HttpStatusCode.NoContent -> Unit
            HttpStatusCode.MethodNotAllowed -> Unit // exists
            else -> throw WebDavException.from(response)
        }
    }

    /**
     * Best-effort recursive mkcol: ensures every intermediate directory in
     * `path` exists. Each level is created with [mkdir]; the idempotent
     * 405 handling makes this safe to call repeatedly.
     */
    suspend fun ensureDirectory(path: String) {
        val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
        if (segments.isEmpty()) return
        var current = ""
        for (segment in segments) {
            current = if (current.isEmpty()) segment else "$current/$segment"
            mkdir(current)
        }
    }

    private fun buildUrl(relativePath: String): String {
        val cleaned = relativePath.trim('/').ifEmpty { "" }
        val encoded = cleaned
            .split('/')
            .joinToString("/") { encodeSegment(it) }
        val base = webdavBaseUrl.trimEnd('/')
        return if (encoded.isEmpty()) "$base/" else "$base/$encoded"
    }

    private fun encodeSegment(segment: String): String {
        if (segment.isEmpty()) return ""
        val out = StringBuilder(segment.length + 8)
        for (byte in segment.encodeToByteArray()) {
            val unsigned = byte.toInt() and 0xFF
            val ch = unsigned.toChar()
            val safe = ch.isLetterOrDigit() || ch == '.' || ch == '-' || ch == '_' || ch == '~'
            if (safe) {
                out.append(ch)
            } else {
                out.append('%')
                out.append(unsigned.toString(16).uppercase().padStart(2, '0'))
            }
        }
        return out.toString()
    }

    private companion object {
        const val PROPFIND_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>"""
    }
}

sealed class WebDavException(message: String) : Exception(message) {
    data object Unauthorized : WebDavException("Stored device credentials were rejected — re-pair the device.")
    data object NotFound : WebDavException("That file or folder no longer exists.")
    data object Forbidden : WebDavException("Your account isn't allowed to read or write there.")
    data object Conflict : WebDavException("A file with that name already exists or the path is missing intermediate folders.")
    data class Other(val statusCode: Int, val serverBody: String?) :
        WebDavException("WebDAV error $statusCode${serverBody?.let { ": $it" }.orEmpty()}")

    internal companion object {
        suspend fun from(response: HttpResponse): WebDavException {
            return when (response.status) {
                HttpStatusCode.Unauthorized -> Unauthorized
                HttpStatusCode.Forbidden -> Forbidden
                HttpStatusCode.NotFound -> NotFound
                HttpStatusCode.Conflict -> Conflict
                else -> Other(
                    statusCode = response.status.value,
                    serverBody = runCatching { response.bodyAsText().take(500) }.getOrNull(),
                )
            }
        }
    }
}
