package ai.warplab.droplet.ui.pair

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
import ai.warplab.droplet.data.ServerRepository
import ai.warplab.droplet.pair.PairUrl

/**
 * Transient screen shown after the user taps a `droplet://pair?...` link from
 * outside the app (email, NFC tag, another phone's QR). Persists the paired
 * server and bounces to the dashboard. The actual `POST /api/devices/pair/claim`
 * happens inside the WebView (because that's where the user's session cookie
 * lives) — the dashboard's pair completion page reads `code` from the URL and
 * POSTs claim itself.
 *
 * Uses [ServerRepository.markPaired] (not upsert) so a user who already
 * renamed this Droplet to "Home" doesn't see their custom name reverted to
 * the hostname on every re-pair.
 *
 * If [pairUrl] is null we treat it as a stale composition (e.g. activity
 * recreated after the deep link was already consumed) and onFailed() —
 * caller routes back to onboarding.
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
        serverRepository.markPaired(link.server)
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
