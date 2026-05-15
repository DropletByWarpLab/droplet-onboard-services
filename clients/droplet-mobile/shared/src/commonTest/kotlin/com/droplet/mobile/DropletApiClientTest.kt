package com.droplet.mobile

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Wire-level tests against a [MockEngine] so we exercise URL routing + JSON
 * deserialization + status-code → exception mapping without an actual
 * orchestrator running. Request-body assertions are left to the
 * orchestrator's own test suite (`device-clients.test.ts`) — duplicating
 * them here would couple two repos for no extra coverage.
 */
class DropletApiClientTest {

    private fun apiWith(engine: MockEngine) = DropletApiClient(
        baseUrl = "https://droplet.local",
        rawClient = HttpClient(engine),
    )

    @Test
    fun `login parses user response`() = runTest {
        val engine = MockEngine { request ->
            assertEquals("https://droplet.local/api/auth/login", request.url.toString())
            respond(
                content = ByteReadChannel(
                    """{"user":{"id":"stefan","username":"stefan","displayName":"Stefan","role":"owner"}}"""
                ),
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val response = apiWith(engine).login("stefan", "hunter2")
        assertEquals("stefan", response.user.username)
        assertEquals("Stefan", response.user.displayName)
        assertEquals("owner", response.user.role)
    }

    @Test
    fun `login maps 401 to InvalidCredentials`() = runTest {
        val engine = MockEngine {
            respond(
                content = ByteReadChannel("""{"error":"Invalid credentials"}"""),
                status = HttpStatusCode.Unauthorized,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        assertFailsWith<DropletApiException.InvalidCredentials> {
            apiWith(engine).login("stefan", "nope")
        }
    }

    @Test
    fun `claim parses success response`() = runTest {
        val engine = MockEngine { request ->
            assertEquals("https://droplet.local/api/devices/pair/claim", request.url.toString())
            respond(
                content = ByteReadChannel(
                    """{"deviceId":"dc_abc123","ncUsername":"stefan","webdavUrl":"https://droplet.local/nextcloud/remote.php/dav/files/stefan/","appPassword":"xxxxx-yyyyy-zzzzz"}"""
                ),
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val claim = apiWith(engine).claimPairingCode("8E3QN3", "Pixel 8", "0.1.0")
        assertEquals("dc_abc123", claim.deviceId)
        assertEquals("stefan", claim.ncUsername)
        assertEquals("xxxxx-yyyyy-zzzzz", claim.appPassword)
    }

    @Test
    fun `claim maps 410 to CodeExpired`() = runTest {
        val engine = MockEngine {
            respond(
                content = ByteReadChannel("""{"error":"Pairing code expired"}"""),
                status = HttpStatusCode.Gone,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        assertFailsWith<DropletApiException.CodeExpired> {
            apiWith(engine).claimPairingCode("EXPIRD", "Pixel 8", "0.1.0")
        }
    }

    @Test
    fun `claim maps 409 to CodeAlreadyUsed`() = runTest {
        val engine = MockEngine {
            respond(
                content = ByteReadChannel("""{"error":"Pairing code already used"}"""),
                status = HttpStatusCode.Conflict,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        assertFailsWith<DropletApiException.CodeAlreadyUsed> {
            apiWith(engine).claimPairingCode("USEDXX", "Pixel 8", "0.1.0")
        }
    }

    @Test
    fun `claim maps 404 to UnknownCode`() = runTest {
        val engine = MockEngine {
            respond(
                content = ByteReadChannel("""{"error":"Unknown pairing code"}"""),
                status = HttpStatusCode.NotFound,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        assertFailsWith<DropletApiException.UnknownCode> {
            apiWith(engine).claimPairingCode("NOPENO", "Pixel 8", "0.1.0")
        }
    }

    @Test
    fun `claim maps 403 to OwnerMismatch`() = runTest {
        val engine = MockEngine {
            respond(
                content = ByteReadChannel("""{"error":"Pairing code belongs to another user"}"""),
                status = HttpStatusCode.Forbidden,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        assertFailsWith<DropletApiException.OwnerMismatch> {
            apiWith(engine).claimPairingCode("MISALN", "Pixel 8", "0.1.0")
        }
    }
}
