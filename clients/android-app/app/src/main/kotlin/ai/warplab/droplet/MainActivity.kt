package ai.warplab.droplet

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.navigation.compose.rememberNavController
import ai.warplab.droplet.nav.DropletNavHost
import ai.warplab.droplet.pair.PairUrl
import ai.warplab.droplet.ui.theme.DropletTheme
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Single-activity host. Three responsibilities:
 *   1. Bring up the Compose theme + edge-to-edge insets.
 *   2. Pump any `droplet://pair?...` ACTION_VIEW intents into a SharedFlow
 *      that the NavHost collects to drive navigation.
 *   3. Honour singleTask launchMode by reading new intents in onNewIntent.
 *
 * The deep-link dispatch deliberately uses a SharedFlow rather than mirroring
 * the URL through an Activity field + Compose State. The flow is configured
 * with `replay = 1` so a deep link that arrives BEFORE setContent's first
 * composition (i.e., cold-start with ACTION_VIEW) is buffered and replayed
 * to the NavHost's collector the moment it starts. That eliminates the
 * earlier race where the empty-default `consumeDeepLink` lambda could swallow
 * a queued intent before the LaunchedEffect installing the real callback ran.
 *
 * Everything UI-shaped delegates to [DropletNavHost].
 */
class MainActivity : ComponentActivity() {

    private val app: DropletApp get() = application as DropletApp

    // replay=1 to survive cold-start race; extraBufferCapacity=1 so a fast
    // second deep link doesn't suspend on tryEmit if the collector is briefly
    // away (e.g. mid-config-change).
    private val deepLinkFlow = MutableSharedFlow<PairUrl>(
        replay = 1,
        extraBufferCapacity = 1,
    )

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

        // Buffer any pair-link intent into the flow BEFORE setContent so the
        // NavHost's LaunchedEffect collector picks it up on its first run.
        emitIfPairIntent(intent)

        setContent {
            DropletTheme {
                val navController = rememberNavController()
                DropletNavHost(
                    navController = navController,
                    serverRepository = app.serverRepository,
                    nsdDiscovery = app.nsdDiscovery,
                    deepLinkFlow = deepLinkFlow.asSharedFlow(),
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        emitIfPairIntent(intent)
    }

    private fun emitIfPairIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.data?.toString() ?: return
        val link = PairUrl.parse(data) ?: return
        // tryEmit can only fail if both replay+extraBuffer are full AND no
        // collector is active. With our config (replay=1, extra=1) the worst
        // case drops a third rapid-fire link, which is acceptable — the user
        // can't tap two pair links inside the time it takes the first to
        // resolve.
        deepLinkFlow.tryEmit(link)
    }
}
