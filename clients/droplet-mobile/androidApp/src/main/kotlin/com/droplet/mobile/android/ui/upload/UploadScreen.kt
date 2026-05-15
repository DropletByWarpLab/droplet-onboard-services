package com.droplet.mobile.android.ui.upload

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.MultiplePermissionsState
import com.google.accompanist.permissions.rememberMultiplePermissionsState
import org.koin.androidx.compose.koinViewModel
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UploadScreen(
    onClose: () -> Unit,
    uploadViewModel: UploadViewModel = koinViewModel(),
    autoUploadViewModel: AutoUploadViewModel = koinViewModel(),
) {
    val uploadState by uploadViewModel.state.collectAsStateWithLifecycle()
    val autoState by autoUploadViewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val picker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(maxItems = 50),
    ) { uris ->
        if (uris.isNotEmpty()) uploadViewModel.upload(context, uris)
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
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.Top,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AutoUploadCard(
                state = autoState,
                onToggle = { autoUploadViewModel.setEnabled(it) },
                onRunNow = { autoUploadViewModel.runNow() },
            )
            Spacer(Modifier.height(16.dp))
            HorizontalDivider()
            Spacer(Modifier.height(24.dp))

            // Manual picker block.
            when (val phase = uploadState.phase) {
                UploadPhase.Idle -> ManualPickerIdleBody(onPick = {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                })
                UploadPhase.Working -> ManualPickerWorkingBody(uploadState)
                UploadPhase.Done -> ManualPickerDoneBody(
                    state = uploadState,
                    onClose = onClose,
                    onPickAgain = {
                        uploadViewModel.reset()
                        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                    },
                )
                is UploadPhase.Failed -> ManualPickerFailedBody(
                    reason = phase.reason,
                    onRetry = { uploadViewModel.reset() },
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Auto-upload card
// ─────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalPermissionsApi::class)
@Composable
private fun AutoUploadCard(
    state: AutoUploadUiState,
    onToggle: (Boolean) -> Unit,
    onRunNow: () -> Unit,
) {
    val permissionState = rememberMultiplePermissionsState(buildRequiredPermissions())

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.autoupload_card_title),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = stringResource(R.string.autoupload_card_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                }
                Spacer(Modifier.size(12.dp))
                Switch(
                    checked = state.enabled && permissionState.allPermissionsGranted,
                    onCheckedChange = { wantsOn ->
                        if (wantsOn && !permissionState.allPermissionsGranted) {
                            permissionState.launchMultiplePermissionRequest()
                        } else {
                            onToggle(wantsOn)
                        }
                    },
                )
            }

            if (!permissionState.allPermissionsGranted) {
                Spacer(Modifier.height(12.dp))
                PermissionRationale(permissionState)
            }

            if (state.enabled && permissionState.allPermissionsGranted) {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = state.lastSuccessSeconds?.let {
                        stringResource(R.string.autoupload_last_success, formatTimestamp(it))
                    } ?: stringResource(R.string.autoupload_never_run),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onRunNow, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.autoupload_run_now))
                }
            }
        }
    }
}

@OptIn(ExperimentalPermissionsApi::class)
@Composable
private fun PermissionRationale(permissionState: MultiplePermissionsState) {
    Text(
        text = stringResource(R.string.autoupload_permission_rationale),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
    )
    Spacer(Modifier.height(8.dp))
    TextButton(onClick = { permissionState.launchMultiplePermissionRequest() }) {
        Text(stringResource(R.string.autoupload_permission_grant))
    }
}

private fun buildRequiredPermissions(): List<String> {
    val perms = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        perms += Manifest.permission.READ_MEDIA_IMAGES
        perms += Manifest.permission.POST_NOTIFICATIONS
    } else {
        @Suppress("DEPRECATION")
        perms += Manifest.permission.READ_EXTERNAL_STORAGE
    }
    return perms
}

private fun formatTimestamp(epochSeconds: Long): String {
    val df = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
    return df.format(Date(epochSeconds * 1_000L))
}

// ─────────────────────────────────────────────────────────────────────
// Manual picker bodies (extracted from the v1.5 implementation)
// ─────────────────────────────────────────────────────────────────────

@Composable
private fun ManualPickerIdleBody(onPick: () -> Unit) {
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
    Spacer(Modifier.height(24.dp))
    Button(onClick = onPick, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.upload_pick_cta))
    }
}

@Composable
private fun ManualPickerWorkingBody(state: UploadUiState) {
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
private fun ManualPickerDoneBody(state: UploadUiState, onClose: () -> Unit, onPickAgain: () -> Unit) {
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
    Spacer(Modifier.height(24.dp))
    Button(onClick = onPickAgain, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.upload_pick_more))
    }
    TextButton(onClick = onClose) {
        Text(stringResource(R.string.upload_done_back))
    }
}

@Composable
private fun ManualPickerFailedBody(reason: UploadErrorReason, onRetry: () -> Unit) {
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
