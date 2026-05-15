package com.droplet.mobile.android.ui.files

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.droplet.mobile.android.R
import com.droplet.mobile.files.WebDavEntry
import org.koin.androidx.compose.koinViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(
    onClose: () -> Unit,
    viewModel: FilesViewModel = koinViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    // Handle download outcomes via snackbar.
    LaunchedEffect(state.downloadState) {
        when (val dl = state.downloadState) {
            is DownloadState.Done -> {
                snackbarHostState.showSnackbar("Saved ${dl.displayName} to Downloads.")
                viewModel.dismissDownloadResult()
            }
            is DownloadState.Failed -> {
                snackbarHostState.showSnackbar("Couldn't download ${dl.displayName}.")
                viewModel.dismissDownloadResult()
            }
            else -> Unit
        }
    }

    BackHandler(enabled = state.path.isNotEmpty()) { viewModel.up() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = state.path.ifEmpty { stringResource(R.string.files_title_root) },
                        maxLines = 1,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = {
                        if (state.path.isEmpty()) onClose() else viewModel.up()
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = null)
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { inner ->
        Box(modifier = Modifier.fillMaxSize().padding(inner)) {
            when {
                state.isLoading && state.entries.isEmpty() -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator()
                    }
                }
                state.error != null -> {
                    ErrorState(state.error!!) { viewModel.refresh() }
                }
                state.entries.isEmpty() -> {
                    Text(
                        text = stringResource(R.string.files_empty),
                        style = MaterialTheme.typography.bodyLarge,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(24.dp),
                        color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.6f),
                    )
                }
                else -> {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(state.entries, key = { it.path }) { entry ->
                            FileRow(
                                entry = entry,
                                downloadingDisplayName = (state.downloadState as? DownloadState.InProgress)?.displayName,
                                onClick = { viewModel.enter(entry) },
                                onDownload = { viewModel.download(context, entry) },
                            )
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FileRow(
    entry: WebDavEntry,
    downloadingDisplayName: String?,
    onClick: () -> Unit,
    onDownload: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = entry.isDirectory) { onClick() }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (entry.isDirectory) Icons.Filled.Folder else Icons.Filled.InsertDriveFile,
            contentDescription = null,
            tint = if (entry.isDirectory) MaterialTheme.colorScheme.primary
                   else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(28.dp),
        )
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = entry.displayName, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
            Text(
                text = entry.subtitle(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            )
        }
        if (!entry.isDirectory) {
            if (downloadingDisplayName == entry.displayName) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                IconButton(onClick = onDownload) {
                    Icon(Icons.Filled.Download, contentDescription = null)
                }
            }
        }
    }
}

@Composable
private fun ErrorState(reason: FilesErrorReason, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.files_error_title),
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = reason.toUserMessage(),
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.error,
        )
        Spacer(Modifier.height(24.dp))
        androidx.compose.material3.Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.action_try_again))
        }
    }
}

@Composable
private fun FilesErrorReason.toUserMessage(): String = when (this) {
    FilesErrorReason.Unauthorized -> stringResource(R.string.files_error_unauthorized)
    FilesErrorReason.NotFound -> stringResource(R.string.files_error_not_found)
    FilesErrorReason.Forbidden -> stringResource(R.string.files_error_forbidden)
    FilesErrorReason.Conflict -> stringResource(R.string.files_error_conflict)
    is FilesErrorReason.Detail -> text
}

private fun WebDavEntry.subtitle(): String {
    val sizeBit = sizeBytes?.let { humanSize(it) }
    val timeBit = lastModified
    return listOfNotNull(sizeBit, timeBit).joinToString(" · ")
}

private fun humanSize(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val kb = bytes.toDouble() / 1024
    if (kb < 1024) return "${"%.1f".format(kb)} KB"
    val mb = kb / 1024
    if (mb < 1024) return "${"%.1f".format(mb)} MB"
    return "${"%.2f".format(mb / 1024)} GB"
}
