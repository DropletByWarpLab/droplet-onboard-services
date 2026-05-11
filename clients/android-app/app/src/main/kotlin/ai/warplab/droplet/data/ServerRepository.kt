package ai.warplab.droplet.data

import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
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
        prefs[KEY_SERVERS]?.let { json ->
            runCatching { Json.decodeFromString<List<PairedServer>>(json) }
                .getOrDefault(emptyList())
        } ?: emptyList()
    }

    val activeServerUrl: Flow<String?> = store.data.map { it[KEY_ACTIVE_URL] }

    /**
     * Insert or update a paired Droplet. Identity is by [PairedServer.url],
     * so calling this with an existing URL refreshes [PairedServer.lastSeenAt]
     * rather than creating a duplicate. After upsert, the newly-touched
     * server becomes the active one — this is the right default for both
     * "first pair" and "switching via deep link" flows.
     */
    suspend fun upsert(server: PairedServer) {
        store.edit { prefs ->
            val current = decode(prefs[KEY_SERVERS])
            val withoutMe = current.filterNot { it.url == server.url }
            val merged = (withoutMe + server).sortedByDescending { it.lastSeenAt }
            prefs[KEY_SERVERS] = Json.encodeToString(merged)
            prefs[KEY_ACTIVE_URL] = server.url
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
            prefs[KEY_SERVERS] = Json.encodeToString(remaining)
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
            prefs[KEY_SERVERS] = Json.encodeToString(updated)
        }
    }

    private fun decode(raw: String?): List<PairedServer> =
        raw?.let {
            runCatching { Json.decodeFromString<List<PairedServer>>(it) }
                .getOrDefault(emptyList())
        } ?: emptyList()

    private fun clearCookiesFor(url: String) {
        // CookieManager has no per-origin clear API on Android. The historic
        // workaround is to iterate cookies and overwrite with expired ones,
        // but that requires the Cookies header for each path. For the
        // privacy-minded "forget Droplet" case the simplest correct thing
        // is to nuke session storage and let other paired Droplets re-auth
        // from their persisted cookies (they will, because we set them with
        // long expiry on the server side).
        val host = Uri.parse(url).host ?: return
        val cm = CookieManager.getInstance()
        val cookieHeader = cm.getCookie(url) ?: return
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
    }
}

// Top-level DataStore delegate — Android best practice; gives us a singleton
// per Context.applicationContext without a DI framework.
private val Context.serverStore: DataStore<Preferences> by preferencesDataStore(name = "droplet_servers")
