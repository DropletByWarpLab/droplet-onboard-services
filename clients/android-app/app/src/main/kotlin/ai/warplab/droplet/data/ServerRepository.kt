package ai.warplab.droplet.data

import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Source of truth for the list of paired Droplets. Persisted via
 * Preferences DataStore (single JSON-encoded string under one key — fine
 * for the small N we expect, <10 paired appliances per user).
 *
 * The repository also owns the "which Droplet is currently active" pointer
 * so the WebView host and switcher screen agree.
 *
 * Why not Room? For a list of 1–10 records with no relational queries,
 * Room is overkill. DataStore + JSON is ~30 lines and gives us reactive
 * Flow updates for free.
 */
class ServerRepository(private val context: Context) {

    private val store: DataStore<Preferences> = context.serverStore

    val servers: Flow<List<PairedServer>> = store.data.map { prefs ->
        decode(prefs[KEY_SERVERS])
    }

    val activeServerUrl: Flow<String?> = store.data.map { it[KEY_ACTIVE_URL] }

    /**
     * Insert or update a paired Droplet. Identity is by [PairedServer.url],
     * so calling this with an existing URL refreshes [PairedServer.lastSeenAt]
     * rather than creating a duplicate. After upsert, the newly-touched
     * server becomes the active one — this is the right default for both
     * "first pair" and "switching via deep link" flows.
     *
     * For the common deep-link-handoff case prefer [markPaired] — it preserves
     * a user-renamed displayName, while this method replaces the full record.
     */
    suspend fun upsert(server: PairedServer) {
        store.edit { prefs ->
            val current = decode(prefs[KEY_SERVERS])
            val withoutMe = current.filterNot { it.url == server.url }
            val merged = (withoutMe + server).sortedByDescending { it.lastSeenAt }
            prefs[KEY_SERVERS] = json.encodeToString(merged)
            prefs[KEY_ACTIVE_URL] = server.url
        }
    }

    /**
     * "I just connected to this Droplet — preserve everything the user set,
     * just bump last-seen and make it active."
     *
     * Use this from the pair-deeplink handoff and the QR scanner. Both paths
     * arrive with no naming intent: the user already named the Droplet in a
     * past session (or didn't), and we shouldn't clobber that with the
     * hostname every time they re-pair.
     *
     * If no record exists yet, creates one with the host portion of the URL
     * as the display name.
     */
    suspend fun markPaired(url: String, defaultDisplayName: String? = null) {
        val now = System.currentTimeMillis()
        val fallbackName = defaultDisplayName?.takeIf { it.isNotBlank() }
            ?: Uri.parse(url).host
            ?: url
        store.edit { prefs ->
            val current = decode(prefs[KEY_SERVERS])
            val existing = current.firstOrNull { it.url == url }
            // Existing record: keep displayName + pairedAt; only refresh lastSeen.
            // New record: take the caller-provided default (e.g. mDNS service name).
            val updated = existing?.copy(lastSeenAt = now)
                ?: PairedServer(
                    url = url,
                    displayName = fallbackName,
                    pairedAt = now,
                    lastSeenAt = now,
                )
            val merged = (current.filterNot { it.url == url } + updated)
                .sortedByDescending { it.lastSeenAt }
            prefs[KEY_SERVERS] = json.encodeToString(merged)
            prefs[KEY_ACTIVE_URL] = url
        }
    }

    /**
     * Remove the paired Droplet *and* clear its WebView cookies so the next
     * pairing starts clean — otherwise an old session cookie could short-
     * circuit the login flow on re-pair. CookieManager is process-global, so
     * we touch it directly rather than routing through the WebView instance.
     */
    suspend fun forget(url: String) {
        store.edit { prefs ->
            val current = decode(prefs[KEY_SERVERS])
            val remaining = current.filterNot { it.url == url }
            prefs[KEY_SERVERS] = json.encodeToString(remaining)
            if (prefs[KEY_ACTIVE_URL] == url) {
                prefs[KEY_ACTIVE_URL] = remaining.firstOrNull()?.url
            }
        }
        clearCookiesFor(url)
    }

    suspend fun setActive(url: String) {
        store.edit { prefs -> prefs[KEY_ACTIVE_URL] = url }
    }

    suspend fun touchLastSeen(url: String) {
        store.edit { prefs ->
            val current = decode(prefs[KEY_SERVERS])
            val updated = current.map {
                if (it.url == url) it.copy(lastSeenAt = System.currentTimeMillis()) else it
            }
            prefs[KEY_SERVERS] = json.encodeToString(updated)
        }
    }

    private fun decode(raw: String?): List<PairedServer> =
        raw?.let {
            runCatching { json.decodeFromString<List<PairedServer>>(it) }
                .getOrDefault(emptyList())
        } ?: emptyList()

    /**
     * Wipes cookies for the given origin off the main thread. CookieManager's
     * setCookie + flush hit disk; doing them inline on whatever dispatcher the
     * caller is on (typically Main, from a Compose button click) can produce
     * jank on slow flash. The flush is fire-and-forget — we don't suspend on
     * its completion callback because the next paired-server pick happens
     * after the DataStore edit returns, and cookie state isn't a correctness
     * dependency for that.
     */
    private suspend fun clearCookiesFor(url: String) = withContext(Dispatchers.IO) {
        val host = Uri.parse(url).host ?: return@withContext
        val cm = CookieManager.getInstance()
        val cookieHeader = cm.getCookie(url) ?: return@withContext
        cookieHeader.split(";").forEach { kv ->
            val name = kv.substringBefore("=").trim()
            if (name.isNotEmpty()) {
                cm.setCookie(url, "$name=; Max-Age=0; Path=/; Domain=$host")
            }
        }
        cm.flush()
    }

    private companion object {
        val KEY_SERVERS = stringPreferencesKey("paired_servers_json")
        val KEY_ACTIVE_URL = stringPreferencesKey("active_server_url")

        /**
         * Forward-compat: ignoreUnknownKeys lets a downgraded app read a
         * persistence written by a newer version with extra fields. Without
         * it, MissingFieldException is thrown, runCatching swallows it, and
         * the user sees their paired-Droplet list vanish — a much worse
         * failure mode than ignoring an unfamiliar field. encodeDefaults so
         * future-added fields with defaults round-trip cleanly.
         */
        val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    }
}

// Top-level DataStore delegate — Android best practice; gives us a singleton
// per Context.applicationContext without a DI framework.
private val Context.serverStore: DataStore<Preferences> by preferencesDataStore(name = "droplet_servers")
