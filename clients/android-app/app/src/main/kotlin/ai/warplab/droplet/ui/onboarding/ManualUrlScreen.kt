package ai.warplab.droplet.ui.onboarding

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ai.warplab.droplet.R
import ai.warplab.droplet.data.PairedServer
import ai.warplab.droplet.data.ServerRepository
import ai.warplab.droplet.pair.UrlValidator
import kotlinx.coroutines.launch

/**
 * Single-field manual onboarding screen. The user types (or pastes) a URL,
 * we run it through [UrlValidator.normaliseServerUrl], and on success we
 * persist it as a paired server. We don't try to reach the URL here — the
 * WebView will tell the user soon enough whether it's reachable, and pinging
 * pre-flight adds latency + battery + a network-perms surprise we'd rather
 * avoid on first-run.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManualUrlScreen(
    serverRepository: ServerRepository,
    onPaired: () -> Unit,
    onBack: () -> Unit,
) {
    var input by remember { mutableStateOf("") }
    var showError by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(stringResource(R.string.manual_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = null)
                    }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 24.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = {
                    input = it
                    if (showError) showError = false
                },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.manual_hint)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                isError = showError,
                supportingText = if (showError) {
                    { Text(stringResource(R.string.manual_invalid), color = MaterialTheme.colorScheme.error) }
                } else null,
            )

            Spacer(Modifier.fillMaxWidth())

            Button(
                onClick = {
                    val normalised = UrlValidator.normaliseServerUrl(input)
                    if (normalised == null) {
                        showError = true
                        return@Button
                    }
                    scope.launch {
                        val now = System.currentTimeMillis()
                        val host = Uri.parse(normalised).host ?: normalised
                        serverRepository.upsert(
                            PairedServer(
                                url = normalised,
                                displayName = host,
                                pairedAt = now,
                                lastSeenAt = now,
                            )
                        )
                        onPaired()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 14.dp),
                enabled = input.isNotBlank(),
            ) {
                Text(stringResource(R.string.manual_continue))
            }
        }
    }
}
