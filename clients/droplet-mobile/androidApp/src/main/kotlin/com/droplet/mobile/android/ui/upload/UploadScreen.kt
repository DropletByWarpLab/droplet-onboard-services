package com.droplet.mobile.android.ui.upload

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.droplet.mobile.android.R
import org.koin.androidx.compose.koinViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UploadScreen(
    onClose: () -> Unit,
    viewModel: UploadViewModel = koinViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val picker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(maxItems = 50),
    ) { uris ->
        if (uris.isNotEmpty()) viewModel.upload(context, uris)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.upload_title)) },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        },
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            when (val phase = state.phase) {
                UploadPhase.Idle -> IdleBody(onPick = {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                })
                UploadPhase.Working -> WorkingBody(state)
                UploadPhase.Done -> DoneBody(state, onClose = onClose, onPickAgain = {
                    viewModel.reset()
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                })
                is UploadPhase.Failed -> FailedBody(
                    reason = phase.reason,
                    onRetry = { viewModel.reset() },
                )
            }
        }
    }
}

@Composable
private fun IdleBody(onPick: () -> Unit) {
    Text(
        text = stringResource(R.string.upload_idle_title),
        style = MaterialTheme.typography.headlineMedium,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(12.dp))
    Text(
        text = stringResource(R.string.upload_idle_body),
        style = MaterialTheme.typography.bodyLarge,
        textAlign = TextAlign.Center,
        color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f),
    )
    Spacer(Modifier.height(32.dp))
    Button(onClick = onPick, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.upload_pick_cta))
    }
}

@Composable
private fun WorkingBody(state: UploadUiState) {
    CircularProgressIndicator(modifier = Modifier.size(48.dp))
    Spacer(Modifier.height(24.dp))
    val progress = if (state.total > 0) state.completed.toFloat() / state.total else 0f
    LinearProgressIndicator(
        progress = { progress.coerceIn(0f, 1f) },
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(12.dp))
    Text(
        text = stringResource(R.string.upload_progress, state.completed + 1, state.total),
        style = MaterialTheme.typography.bodyLarge,
    )
    state.current?.let {
        Spacer(Modifier.height(4.dp))
        Text(
            text = it,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.6f),
            maxLines = 1,
        )
    }
}

@Composable
private fun DoneBody(state: UploadUiState, onClose: () -> Unit, onPickAgain: () -> Unit) {
    val succeeded = state.total - state.failures.size
    Text(
        text = stringResource(R.string.upload_done_title),
        style = MaterialTheme.typography.headlineMedium,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(8.dp))
    Text(
        text = stringResource(R.string.upload_done_summary, succeeded, state.total),
        style = MaterialTheme.typography.bodyLarge,
        textAlign = TextAlign.Center,
        color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f),
    )
    if (state.failures.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        Text(
            text = stringResource(R.string.upload_done_failures_header),
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.error,
        )
        Spacer(Modifier.height(4.dp))
        state.failures.forEach { (name, _) ->
            Text(text = "• $name", style = MaterialTheme.typography.bodyMedium)
        }
    }
    Spacer(Modifier.height(32.dp))
    Button(onClick = onPickAgain, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.upload_pick_more))
    }
    TextButton(onClick = onClose) {
        Text(stringResource(R.string.upload_done_back))
    }
}

@Composable
private fun FailedBody(reason: UploadErrorReason, onRetry: () -> Unit) {
    Text(
        text = stringResource(R.string.upload_failed_title),
        style = MaterialTheme.typography.headlineMedium,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(8.dp))
    Text(
        text = reason.toUserMessage(),
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.error,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(24.dp))
    Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.action_try_again))
    }
}

@Composable
private fun UploadErrorReason.toUserMessage(): String = when (this) {
    UploadErrorReason.Unauthorized -> stringResource(R.string.upload_error_unauthorized)
    UploadErrorReason.Forbidden -> stringResource(R.string.upload_error_forbidden)
    UploadErrorReason.Conflict -> stringResource(R.string.upload_error_conflict)
    is UploadErrorReason.Detail -> text
}
