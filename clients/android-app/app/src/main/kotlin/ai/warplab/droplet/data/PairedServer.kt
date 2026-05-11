package ai.warplab.droplet.data

import kotlinx.serialization.Serializable

/**
 * One Droplet appliance the user has paired with this device. We keep the
 * minimum needed to (a) load the dashboard in a WebView and (b) show a
 * sensible label in the switcher.
 *
 * We deliberately do NOT store the user's session token here — that lives in
 * the WebView's own cookie jar so it follows the dashboard's auth lifecycle
 * (refresh, logout, expiry) without us having to mirror it. The result is
 * that "forget this Droplet" really means "delete the cookies for this
 * origin", which the repository handles on remove.
 */
@Serializable
data class PairedServer(
    /** Canonical URL from [ai.warplab.droplet.pair.UrlValidator]. Used as the
     *  identity key — two records with the same `url` are the same Droplet. */
    val url: String,

    /** Human label shown in the switcher. Defaults to the host portion of
     *  [url]; the user can rename. */
    val displayName: String,

    /** Epoch millis when the record was first added. Used to sort the
     *  switcher list (newest first). */
    val pairedAt: Long,

    /** Epoch millis of the last successful WebView load. Lets us surface
     *  "Last seen 3 days ago" in the switcher so the user knows which one
     *  they're actively using. */
    val lastSeenAt: Long,
)
