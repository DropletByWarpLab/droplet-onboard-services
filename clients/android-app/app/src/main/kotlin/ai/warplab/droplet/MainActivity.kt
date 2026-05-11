package ai.warplab.droplet

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.lifecycle.lifecycleScope
import ai.warplab.droplet.data.PairedServer
import ai.warplab.droplet.nav.DropletNavHost
import ai.warplab.droplet.nav.DropletRoute
import ai.warplab.droplet.pair.PairUrl
import ai.warplab.droplet.ui.theme.DropletTheme
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch

/**
 * Single-activity host. Three responsibilities:
 *   1. Decide the start destination based on the persisted server list
 *      (no paired Droplets → onboarding, else → dashboard).
 *   2. Handle `droplet://pair?...` deep links on both cold-start (Intent in
 *      onCreate) and warm-up (onNewIntent) paths.
 *   3. Apply the Compose theme + edge-to-edge insets.
 *
 * Everything UI-shaped delegates to [DropletNavHost].
 */
class MainActivity : ComponentActivity() {

    private val app: DropletApp get() = application as DropletApp

    // Re-keys the nav graph when a deep link arrives so the destination
    // change re-evaluates. Compose state, not Activity field, so config
    // changes survive without us having to wire savedInstanceState.
    private var pendingDeepLink: PairUrl? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        // Replace the splash theme with the real one before setContent
        // (the manifest sets Theme.Droplet.Splash for cold-start, which
        // would otherwise leak through as the activity background).
        setTheme(R.style.Theme_Droplet)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(0, 0),
            navigationBarStyle = SystemBarStyle.auto(0, 0),
        )

        pendingDeepLink = extractPairUrl(intent)

        setContent {
            DropletTheme {
                val navController = rememberNavController()
                val deepLink = remember { mutableStateOf(pendingDeepLink) }

                // Re-read the deep link on every recomposition triggered by
                // onNewIntent. We can't observe Activity fields from Compose
                // directly, so onNewIntent below pokes via consumeDeepLink().
                LaunchedEffect(Unit) {
                    consumeDeepLink = { link ->
                        deepLink.value = link
                    }
                }

                // Decide start destination ONCE per activity-create. We don't
                // want the user mid-session to be ripped back to onboarding
                // because they happened to "forget" their last Droplet.
                val startRoute = remember(deepLink.value) {
                    when {
                        deepLink.value != null -> DropletRoute.PairHandoff.path
                        else -> DropletRoute.Bootstrap.path  // resolves to onboarding or dashboard
                    }
                }

                DropletNavHost(
                    navController = navController,
                    startDestination = startRoute,
                    serverRepository = app.serverRepository,
                    nsdDiscovery = app.nsdDiscovery,
                    pendingDeepLink = deepLink.value,
                    onDeepLinkConsumed = { deepLink.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val link = extractPairUrl(intent) ?: return
        // Mirror the link into the activity-scoped field so a config change
        // arriving immediately after this intent (orientation flip on a tap
        // from the lock screen) doesn't drop the pairing — onCreate re-reads
        // pendingDeepLink before setContent.
        pendingDeepLink = link

        // Hot path: append the paired server immediately (best-effort) and
        // hand the link to Compose to drive navigation. We don't block on
        // disk I/O — the repository call is idempotent so the screen can
        // also re-issue it.
        lifecycleScope.launch {
            val existing = app.serverRepository.servers.firstOrNull()
                ?.firstOrNull { it.url == link.server }
            val host = android.net.Uri.parse(link.server).host ?: link.server
            app.serverRepository.upsert(
                PairedServer(
                    url = link.server,
                    displayName = existing?.displayName ?: host,
                    pairedAt = existing?.pairedAt ?: System.currentTimeMillis(),
                    lastSeenAt = System.currentTimeMillis(),
                )
            )
        }
        consumeDeepLink(link)
    }

    /** Pull a [PairUrl] out of either an ACTION_VIEW intent or a launcher
     *  intent that has no data. Returns null in either non-pair case. */
    private fun extractPairUrl(intent: Intent?): PairUrl? {
        if (intent?.action != Intent.ACTION_VIEW) return null
        val data = intent.data?.toString() ?: return null
        return PairUrl.parse(data)
    }

    // Compose-side callback installed in setContent — used by onNewIntent to
    // forward deep links into the active composition without a global event
    // bus. Reassigned each onCreate so a recreated activity gets a fresh
    // pointer.
    private var consumeDeepLink: (PairUrl) -> Unit = {}
}
