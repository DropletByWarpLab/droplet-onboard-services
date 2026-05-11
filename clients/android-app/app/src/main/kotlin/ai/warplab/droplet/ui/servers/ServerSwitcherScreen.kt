package ai.warplab.droplet.ui.servers

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ai.warplab.droplet.R
import ai.warplab.droplet.data.PairedServer
import ai.warplab.droplet.data.ServerRepository
import kotlinx.coroutines.launch

/**
 * Multi-Droplet switcher. Reachable from the dashboard's chrome (swap icon
 * in the top-right). List sorted by lastSeenAt — the one you used yesterday
 * floats to the top.
 *
 * Each row supports:
 *   • Tap → switch active server (closes the screen)
 *   • Edit icon → rename inline via a dialog
 *   • Delete icon → forget the Droplet + clear its cookies
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerSwitcherScreen(
    serverRepository: ServerRepository,
    onAdd: () -> Unit,
    onPicked: () -> Unit,
    onBack: () -> Unit,
) {
    val servers by serverRepository.servers.collectAsState(initial = emptyList())
    val activeUrl by serverRepository.activeServerUrl.collectAsState(initial = null)
    val scope = rememberCoroutineScope()

    // Currently-renaming server, or null if the dialog is closed. Hoisted to
    // the screen level so a row-level recomposition doesn't dismiss the dialog.
    var renaming by remember { mutableStateOf<PairedServer?>(null) }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(stringResource(R.string.switcher_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = null)
                    }
                },
                actions = {
                    IconButton(onClick = onAdd) {
                        Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.switcher_add))
                    }
                },
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(vertical = 8.dp),
        ) {
            items(servers, key = { it.url }) { server ->
                ServerRow(
                    server = server,
                    isActive = server.url == activeUrl,
                    onPick = {
                        scope.launch {
                            serverRepository.setActive(server.url)
                            onPicked()
                        }
                    },
                    onRename = { renaming = server },
                    onForget = {
                        scope.launch { serverRepository.forget(server.url) }
                    },
                )
                HorizontalDivider()
            }
        }
    }

    renaming?.let { target ->
        RenameDialog(
            initial = target.displayName,
            onDismiss = { renaming = null },
            onConfirm = { newName ->
                scope.launch {
                    serverRepository.rename(target.url, newName.trim())
                    renaming = null
                }
            },
        )
    }
}

@Composable
private fun ServerRow(
    server: PairedServer,
    isActive: Boolean,
    onPick: () -> Unit,
    onRename: () -> Unit,
    onForget: () -> Unit,
) {
    ListItem(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onPick)
            .padding(horizontal = 8.dp),
        headlineContent = {
            Text(server.displayName, style = MaterialTheme.typography.titleLarge)
        },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(server.url, style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = lastSeenLabel(server.lastSeenAt),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
        },
        leadingContent = {
            if (isActive) {
                Icon(Icons.Outlined.Check, contentDescription = "Active", tint = MaterialTheme.colorScheme.primary)
            }
        },
        trailingContent = {
            // Two trailing actions — rename + delete. Wrap in a Row so they
            // render side-by-side; ListItem's trailingContent is a single slot.
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                IconButton(onClick = onRename) {
                    Icon(
                        Icons.Outlined.Edit,
                        contentDescription = stringResource(R.string.switcher_rename),
                    )
                }
                IconButton(onClick = onForget) {
                    Icon(
                        Icons.Outlined.Delete,
                        contentDescription = stringResource(R.string.switcher_forget),
                    )
                }
            }
        },
    )
}

@Composable
private fun RenameDialog(
    initial: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var text by remember(initial) { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.rename_title)) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(stringResource(R.string.rename_hint)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(text) },
                // Disabled if blank — matches the repository's silent no-op
                // policy. Surfaces the constraint at the UI rather than
                // letting the user think they renamed when nothing changed.
                enabled = text.trim().isNotEmpty(),
            ) {
                Text(stringResource(R.string.rename_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.rename_cancel))
            }
        },
    )
}

private fun lastSeenLabel(millis: Long): String {
    val ageMs = System.currentTimeMillis() - millis
    val mins = ageMs / 60_000
    val hours = mins / 60
    val days = hours / 24
    return when {
        mins < 1 -> "Active now"
        mins < 60 -> "Last seen ${mins}m ago"
        hours < 24 -> "Last seen ${hours}h ago"
        days < 30 -> "Last seen ${days}d ago"
        else -> "Last seen long ago"
    }
}
