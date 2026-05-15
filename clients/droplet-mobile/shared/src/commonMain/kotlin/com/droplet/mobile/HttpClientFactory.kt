package com.droplet.mobile

import io.ktor.client.HttpClient

/**
 * Build a raw, engine-bound Ktor [HttpClient]. Common plugins (content
 * negotiation, cookies, logging, timeouts) are installed by
 * [DropletApiClient]; this factory is only responsible for the engine choice
 * and the TLS trust policy.
 *
 * @param allowSelfSignedHosts hostnames for which the client accepts
 *   self-signed certificates. Used for first-run pairing against a fresh
 *   Droplet on the LAN before DuckDNS / Let's Encrypt is provisioned. Pass
 *   an empty set to enforce the platform's default CA store.
 */
expect fun createPlatformHttpClient(
    allowSelfSignedHosts: Set<String> = emptySet(),
): HttpClient
