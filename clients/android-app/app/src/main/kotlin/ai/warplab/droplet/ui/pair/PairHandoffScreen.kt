package ai.warplab.droplet.ui.pair

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ai.warplab.droplet.R
import ai.warplab.droplet.data.PairedServer
import ai.warplab.droplet.data.ServerRepository
import ai.warplab.droplet.pair.PairUrl

/**
 * Transient screen shown after the user taps a `droplet://pair?...` link from
 * outside the app (email, NFC tag, another phone's QR). Persists the paired
 * server and bounces to the dashboard. The actual `POST /api/devices/pair/claim`
 * happens inside the WebView (because that's where the user's session cookie
 * lives) — see DashboardWebViewScreen.kt for the in-page claim hook.
 *
 * If [pairUrl] is null we treat it as a stale intent (e.g. user backed out
 * and re-entered the app via launcher icon) and onFailed() — caller routes
 * back to onboarding.
 */
@Composable
fun PairHandoffScreen(
    pairUrl: PairUrl?,
    serverRepository: ServerRepository,
    onDone: () -> Unit,
    onFailed: (String) -> Unit,
) {
    LaunchedEffect(pairUrl) {
        val link = pairUrl
        if (link == null) {
            onFailed("Missing pair URL")
            return@LaunchedEffect
        }
        val now = System.currentTimeMillis()
        val host = Uri.parse(link.server).host ?: link.server
        serverRepository.upsert(
            PairedServer(
                url = link.server,
                displayName = host,
                pairedAt = now,
                lastSeenAt = now,
            )
        )
        // The dashboard's pair page in the WebView will read `code` from the
        // URL fragment we append and POST /api/devices/pair/claim on its own,
        // re-using the user's already-logged-in session.
        onDone()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.pair_handoff_title),
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            text = stringResource(R.string.pair_handoff_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
    }
}
