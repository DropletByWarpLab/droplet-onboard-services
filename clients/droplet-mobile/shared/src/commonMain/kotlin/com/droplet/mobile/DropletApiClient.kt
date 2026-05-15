package com.droplet.mobile

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.URLBuilder
import io.ktor.http.contentType
import io.ktor.http.takeFrom
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Wraps the orchestrator's two REST routes the pairing flow needs:
 *
 *   POST /api/auth/login            { username, password }                → 200 + session cookie
 *   POST /api/devices/pair/claim    { code, deviceName, appVersion }     → 200 + DeviceClaimResponse
 *
 * Cookies persist in-memory across calls via Ktor's HttpCookies plugin so
 * the claim request inherits the login's session. The raw [rawClient] comes
 * from [createPlatformHttpClient] and brings the engine + TLS policy; we
 * layer the common plugins here.
 */
class DropletApiClient(
    baseUrl: String,
    rawClient: HttpClient,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private val client: HttpClient = rawClient.config {
        install(ContentNegotiation) {
            json(this@DropletApiClient.json)
        }
        install(HttpCookies)
        install(HttpTimeout) {
            requestTimeoutMillis = 30_000
            connectTimeoutMillis = 10_000
            socketTimeoutMillis = 30_000
        }
        install(Logging) {
            level = LogLevel.INFO
        }
        defaultRequest {
            url.takeFrom(URLBuilder().takeFrom(baseUrl.trimEnd('/') + "/"))
            headers.append(HttpHeaders.Accept, ContentType.Application.Json.toString())
        }
        // We translate 4xx/5xx ourselves below so individual endpoints can
        // attach status-specific context. Disable Ktor's default-throw.
        expectSuccess = false
        HttpResponseValidator {
            validateResponse { /* no-op */ }
        }
    }

    suspend fun login(username: String, password: String): LoginResponse {
        val response = client.post("api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(username = username, password = password))
        }
        return when (response.status) {
            HttpStatusCode.OK -> response.body()
            HttpStatusCode.Unauthorized -> throw DropletApiException.InvalidCredentials
            HttpStatusCode.BadRequest ->
                throw DropletApiException.BadRequest(response.readErrorMessage() ?: "Username and password are required")
            else -> throw DropletApiException.Unexpected(response.status.value, response.readErrorMessage())
        }
    }

    suspend fun claimPairingCode(
        code: String,
        deviceName: String,
        appVersion: String,
    ): DeviceClaimResponse {
        val response = client.post("api/devices/pair/claim") {
            contentType(ContentType.Application.Json)
            setBody(
                DeviceClaimRequest(
                    code = code,
                    deviceName = deviceName,
                    appVersion = appVersion,
                )
            )
        }
        return when (response.status) {
            HttpStatusCode.OK -> response.body()
            HttpStatusCode.BadRequest ->
                throw DropletApiException.BadRequest(response.readErrorMessage() ?: "Invalid claim request")
            HttpStatusCode.Unauthorized -> throw DropletApiException.NotLoggedIn
            HttpStatusCode.Forbidden -> throw DropletApiException.OwnerMismatch
            HttpStatusCode.NotFound -> throw DropletApiException.UnknownCode
            HttpStatusCode.Conflict -> throw DropletApiException.CodeAlreadyUsed
            HttpStatusCode.Gone -> throw DropletApiException.CodeExpired
            HttpStatusCode.TooManyRequests -> throw DropletApiException.RateLimited
            HttpStatusCode.BadGateway -> throw DropletApiException.UpstreamFailure
            else -> throw DropletApiException.Unexpected(response.status.value, response.readErrorMessage())
        }
    }

    fun close() {
        client.close()
    }

    private suspend fun HttpResponse.readErrorMessage(): String? = runCatching {
        body<ApiErrorBody>().error
    }.getOrNull()
}

@Serializable
internal data class LoginRequest(val username: String, val password: String)

@Serializable
data class LoginResponse(val user: User) {
    @Serializable
    data class User(
        val id: String,
        val username: String,
        val displayName: String,
        val role: String? = null,
    )
}

@Serializable
internal data class DeviceClaimRequest(
    val code: String,
    val deviceName: String,
    val appVersion: String,
)

@Serializable
data class DeviceClaimResponse(
    val deviceId: String,
    val ncUsername: String,
    val webdavUrl: String,
    val appPassword: String,
)

@Serializable
internal data class ApiErrorBody(val error: String? = null)

sealed class DropletApiException(message: String) : Exception(message) {
    data object InvalidCredentials : DropletApiException("Invalid username or password")
    data object NotLoggedIn : DropletApiException("Session expired — please sign in again")
    data object OwnerMismatch : DropletApiException("Pairing code belongs to a different account")
    data object UnknownCode : DropletApiException("Unknown pairing code")
    data object CodeAlreadyUsed : DropletApiException("This pairing code has already been used")
    data object CodeExpired : DropletApiException("This pairing code has expired")
    data object RateLimited : DropletApiException("Too many attempts — try again later")
    data object UpstreamFailure : DropletApiException("Droplet couldn't issue credentials. Try again.")
    data class BadRequest(val reason: String) : DropletApiException(reason)
    data class Unexpected(val statusCode: Int, val serverMessage: String?) :
        DropletApiException("Unexpected error ($statusCode)${serverMessage?.let { ": $it" }.orEmpty()}")
}
