package com.droplet.mobile

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import platform.Foundation.NSURLSessionConfiguration

/**
 * Darwin-engine Ktor client. The Foundation URLSession default trust policy
 * uses the system CA store; per-host self-signed acceptance can be wired up
 * with a custom URLSessionDelegate when the iOS app is built. For now this
 * stub matches the Android engine signature so the shared layer compiles
 * for all KMP targets.
 */
actual fun createPlatformHttpClient(
    allowSelfSignedHosts: Set<String>,
): HttpClient = HttpClient(Darwin) {
    engine {
        configureSession {
            timeoutIntervalForRequest = 30.0
            timeoutIntervalForResource = 30.0
        }
        // TODO: when implementing the iOS app, add a URLSessionDelegate
        // that consults allowSelfSignedHosts for didReceiveChallenge.
    }
}
