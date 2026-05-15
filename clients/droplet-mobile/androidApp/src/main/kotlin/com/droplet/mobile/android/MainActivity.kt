package com.droplet.mobile.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.droplet.mobile.DropletPairUri
import com.droplet.mobile.android.ui.DropletApp
import com.droplet.mobile.android.ui.theme.DropletTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val initialDeepLink = parseDropletDeepLink(intent)

        setContent {
            var deepLink by remember { mutableStateOf(initialDeepLink) }
            DropletTheme {
                DropletApp(
                    incomingPairUri = deepLink,
                    onDeepLinkConsumed = { deepLink = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // A second droplet:// link arrived while the activity was already
        // resumed. The DropletApp composable re-reads from its state hoist
        // on each setContent, so we just replace the intent and rely on the
        // remember above to be re-keyed via process death scenarios. For
        // this v1 we keep it simple: store on the activity and let the
        // user re-trigger via the "Scan again" button if they need it.
        setIntent(intent)
    }
}

private fun parseDropletDeepLink(intent: Intent?): DropletPairUri? {
    val data = intent?.data?.toString() ?: return null
    return DropletPairUri.parseOrNull(data)
}
