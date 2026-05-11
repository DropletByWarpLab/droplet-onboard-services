package ai.warplab.droplet.pair

import android.net.Uri

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

        /** Orchestrator hard-codes [PAIRING_CODE_LENGTH = 6] for now. We accept a
         *  small range so a future bump on the server doesn't break clients. */
        private val ACCEPTED_CODE_LENGTHS = 4..12

        /**
         * Parse a `droplet://pair?...` URL. Returns null on any failure rather
         * than throwing — caller decides how to surface the error (toast,
         * inline form message, etc.).
         */
        fun parse(raw: String): PairUrl? {
            val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return null
            if (!SCHEME.equals(uri.scheme, ignoreCase = true)) return null
            if (!HOST.equals(uri.host, ignoreCase = true)) return null

            val server = uri.getQueryParameter(PARAM_SERVER)?.trim().orEmpty()
            val code = uri.getQueryParameter(PARAM_CODE)?.trim().orEmpty()
            if (server.isEmpty() || code.isEmpty()) return null
            if (code.length !in ACCEPTED_CODE_LENGTHS) return null

            val normalisedServer = UrlValidator.normaliseServerUrl(server) ?: return null
            return PairUrl(server = normalisedServer, code = code)
        }
    }
}
