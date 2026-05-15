package com.droplet.mobile.android.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.droplet.mobile.DropletSession
import com.droplet.mobile.android.R
import com.droplet.mobile.android.ui.theme.DropletOk
import org.koin.androidx.compose.koinViewModel

@Composable
fun HomeScreen(
    onBrowseFiles: () -> Unit,
    onUploadPhotos: () -> Unit,
    onUnpair: () -> Unit,
    viewModel: HomeViewModel = koinViewModel(),
) {
    val session by viewModel.session.collectAsStateWithLifecycle()

    Scaffold { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            HeaderBadge()
            Spacer(Modifier.height(12.dp))
            Text(
                text = stringResource(R.string.home_title),
                style = MaterialTheme.typography.displayLarge,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.home_subtitle),
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f),
            )
            session?.let { current ->
                Spacer(Modifier.height(20.dp))
                SessionCard(current)
            }
            Spacer(Modifier.height(28.dp))
            DestinationCard(
                icon = Icons.Filled.FolderOpen,
                title = stringResource(R.string.home_dest_files_title),
                body = stringResource(R.string.home_dest_files_body),
                onClick = onBrowseFiles,
            )
            Spacer(Modifier.height(12.dp))
            DestinationCard(
                icon = Icons.Filled.CloudUpload,
                title = stringResource(R.string.home_dest_upload_title),
                body = stringResource(R.string.home_dest_upload_body),
                onClick = onUploadPhotos,
            )
            Spacer(Modifier.weight(1f))
            TextButton(onClick = {
                viewModel.forget()
                onUnpair()
            }) {
                Icon(Icons.Filled.Logout, contentDescription = null)
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.home_unpair))
            }
        }
    }
}

@Composable
private fun HeaderBadge() {
    Surface(shape = CircleShape, color = DropletOk, modifier = Modifier.size(72.dp)) {
        androidx.compose.foundation.layout.Box(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.size(40.dp),
            )
        }
    }
}

@Composable
private fun SessionCard(session: DropletSession) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            FieldRow(stringResource(R.string.home_field_user), session.displayName.ifBlank { session.username })
            FieldRow(stringResource(R.string.home_field_server), session.serverUrl)
            FieldRow(stringResource(R.string.home_field_device), session.deviceName)
        }
    }
}

@Composable
private fun FieldRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun DestinationCard(
    icon: ImageVector,
    title: String,
    body: String,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(32.dp),
            )
            Spacer(Modifier.size(16.dp))
            Column {
                Text(text = title, style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(4.dp))
                Text(
                    text = body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
            }
        }
    }
}
