package ai.warplab.droplet.pair

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Wire format produced by the orchestrator's `POST /api/devices/pair` and
 * rendered as a QR by the dashboard's `apps/web-dashboard/src/app/devices/pair`
 * page. See `apps/orchestrator/src/routes/device-clients.ts` for the canonical
 * generator.
 *
 *   droplet://pair?server=<url-encoded-server-url>&code=<6-char-code>
 *
 * Anything we receive over a deep link OR a scanned QR is normalised through
 * this type so the rest of the app never deals with raw strings.
 *
 * Parsing rules:
 *   • scheme must be exactly "droplet" — case-insensitive per RFC 3986
 *   • host must be "pair"
 *   • server param must be a syntactically valid http/https URL
 *   • code param is the orchestrator's pairing code; we validate length only
 *     (the server makes the final auth decision)
 *
 * Implementation note: we deliberately use [java.net.URI] (JVM stdlib) and a
 * tiny hand-rolled query-string splitter rather than `android.net.Uri`. This
 * lets the parser be unit-tested on the JVM without Robolectric or
 * `returnDefaultValues = true` (both of which would silently break the
 * `Uri.parse` codepath that this class previously relied on). The Android
 * deep-link receiver still does the right thing because the Activity intent
 * filter hands us the URL as a String, which we feed through [parse].
 *
 * Side effect: nothing — pure data extraction. Mutations live in
 * [ServerRepository] and `/pair/claim` HTTP calls.
 */
data class PairUrl(
    /** Origin of the appliance, e.g. `https://droplet.local` (no trailing slash). */
    val server: String,
    /** One-time pairing code from the dashboard. Length-checked, not auth-checked. */
    val code: String,
) {
    companion object {
        private const val SCHEME = "droplet"
        private const val HOST = "pair"
        private const val PARAM_SERVER = "server"
        private const val PARAM_CODE = "code"

        /** Orchestrator hard-codes PAIRING_CODE_LENGTH = 6 for now. We accept a
         *  small range so a future bump on the server doesn't break clients. */
        private val ACCEPTED_CODE_LENGTHS = 4..12

        /**
         * Parse a `droplet://pair?...` URL. Returns null on any failure rather
         * than throwing — caller decides how to surface the error (toast,
         * inline form message, etc.).
         */
        fun parse(raw: String): PairUrl? {
            val uri = runCatching { URI(raw) }.getOrNull() ?: return null
            if (!SCHEME.equals(uri.scheme, ignoreCase = true)) return null

            // java.net.URI's host is null for non-server-based authorities (no
            // colon-port form). For our scheme the "authority" is just the
            // literal `pair` after `//`, which URI exposes via getAuthority()
            // rather than getHost(). Fall back accordingly.
            val authority = uri.host ?: uri.authority
            if (authority == null || !HOST.equals(authority, ignoreCase = true)) return null

            val query = uri.rawQuery ?: return null
            val params = parseQuery(query)

            val server = params[PARAM_SERVER]?.trim().orEmpty()
            val code = params[PARAM_CODE]?.trim().orEmpty()
            if (server.isEmpty() || code.isEmpty()) return null
            if (code.length !in ACCEPTED_CODE_LENGTHS) return null

            val normalisedServer = UrlValidator.normaliseServerUrl(server) ?: return null
            return PairUrl(server = normalisedServer, code = code)
        }

        /**
         * Minimal `application/x-www-form-urlencoded` splitter. Last value wins
         * on duplicate keys — the dashboard never emits duplicates so this is a
         * safety default, not a meaningful semantic. Returns the *decoded*
         * value for each key.
         */
        private fun parseQuery(raw: String): Map<String, String> {
            if (raw.isEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (pair in raw.split('&')) {
                if (pair.isEmpty()) continue
                val eq = pair.indexOf('=')
                val k = if (eq < 0) pair else pair.substring(0, eq)
                val v = if (eq < 0) "" else pair.substring(eq + 1)
                out[decode(k)] = decode(v)
            }
            return out
        }

        private fun decode(s: String): String =
            try {
                URLDecoder.decode(s, StandardCharsets.UTF_8.name())
            } catch (_: IllegalArgumentException) {
                // Malformed % escape — keep the raw form, let the downstream
                // validator reject it.
                s
            }
    }
}
