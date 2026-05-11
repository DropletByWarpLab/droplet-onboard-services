package ai.warplab.droplet.pair

import android.net.Uri

/**
 * Common validation for any "server URL" the user might give us: a manual
 * onboarding entry, an NSD-discovered service URL, or the `server=` field of
 * a [PairUrl]. We normalise to a canonical form so two semantically-identical
 * URLs hash to the same paired-device record (i.e. `droplet.local` and
 * `droplet.local/` and `https://droplet.local:443` all collapse).
 */
object UrlValidator {

    /** Hosts the appliance is allowed to live on. Anything else is rejected
     *  pre-network — we don't want a malicious QR to trick the WebView into
     *  loading a phishing page. */
    private val ALLOWED_SCHEMES = setOf("http", "https")

    /**
     * Returns the normalised form (`<scheme>://<host>[:port]`) or null if the
     * input can't be coerced into a valid URL.
     *
     * Examples:
     *   "droplet.local"               → "https://droplet.local"
     *   "http://192.168.1.42:8080/"   → "http://192.168.1.42:8080"
     *   "https://droplet.local:443"   → "https://droplet.local"   (default port stripped)
     *   "  droplet.local/  "          → "https://droplet.local"
     *   ""                            → null
     *   "javascript:alert(1)"         → null
     */
    fun normaliseServerUrl(raw: String): String? {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isEmpty()) return null

        // If the user typed a bare host (no scheme), assume HTTPS — the
        // orchestrator's prod deployment is always behind Nginx TLS. Users
        // who want plain HTTP on LAN have to type it.
        val withScheme = if (!trimmed.contains("://")) "https://$trimmed" else trimmed

        val uri = runCatching { Uri.parse(withScheme) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme !in ALLOWED_SCHEMES) return null

        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val port = uri.port
        // Strip default ports so equality matches a user typing "https://foo"
        // vs "https://foo:443".
        val portPart = when {
            port == -1 -> ""
            scheme == "https" && port == 443 -> ""
            scheme == "http" && port == 80 -> ""
            else -> ":$port"
        }
        return "$scheme://$host$portPart"
    }

    /** Convenience predicate for inline form validation. */
    fun isLikelyValid(raw: String): Boolean = normaliseServerUrl(raw) != null
}
