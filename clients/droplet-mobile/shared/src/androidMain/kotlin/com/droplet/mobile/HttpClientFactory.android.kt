package com.droplet.mobile

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * OkHttp-backed Ktor client. Trust is the JVM default (platform CA store +
 * Android system-CA additions) except for hostnames in [allowSelfSignedHosts],
 * which transparently accept any TLS chain — the trade-off for letting a
 * user pair against a fresh Droplet whose self-signed cert isn't yet in the
 * device's trust store. Production builds should pass an empty set.
 *
 * Timeouts are configured at the Ktor layer in [DropletApiClient] via
 * `HttpTimeout`, so we don't repeat them here.
 */
actual fun createPlatformHttpClient(
    allowSelfSignedHosts: Set<String>,
): HttpClient = HttpClient(OkHttp) {
    engine {
        if (allowSelfSignedHosts.isNotEmpty()) {
            preconfigured = buildSelfSignedAwareClient(allowSelfSignedHosts)
        }
    }
}

private fun buildSelfSignedAwareClient(allowedHosts: Set<String>): OkHttpClient {
    val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    val sslContext = SSLContext.getInstance("TLS").apply {
        init(null, arrayOf(trustAll), SecureRandom())
    }
    val verifier = HostnameVerifier { hostname, _ -> hostname in allowedHosts }
    return OkHttpClient.Builder()
        .sslSocketFactory(sslContext.socketFactory, trustAll)
        .hostnameVerifier(verifier)
        .build()
}
