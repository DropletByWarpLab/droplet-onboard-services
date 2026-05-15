package com.droplet.mobile.android.ui.pairflow

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.droplet.mobile.DropletPairUri
import com.droplet.mobile.android.R

@Composable
fun PairFlowScreen(
    serverUrl: String,
    code: String,
    viewModel: PairFlowViewModel,
    onPaired: () -> Unit,
    onCancel: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val pairUri = remember(serverUrl, code) { DropletPairUri(server = serverUrl, code = code) }

    LaunchedEffect(state.phase) {
        if (state.phase is Phase.Success) onPaired()
    }

    Scaffold { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.Top,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Header(serverUrl = serverUrl, code = code)
            Spacer(Modifier.height(24.dp))

            when (val phase = state.phase) {
                Phase.Idle -> CredentialsForm(
                    state = state,
                    onUsernameChange = viewModel::setUsername,
                    onPasswordChange = viewModel::setPassword,
                    onSubmit = { viewModel.submit(pairUri) },
                )
                Phase.Authenticating -> ProgressBlock(
                    label = stringResource(R.string.pair_phase_signing_in),
                )
                Phase.Claiming -> ProgressBlock(
                    label = stringResource(R.string.pair_phase_claiming),
                )
                is Phase.Success -> ProgressBlock(
                    label = stringResource(R.string.pair_success),
                )
            }

            state.error?.let { reason ->
                Spacer(Modifier.height(16.dp))
                Text(
                    text = reason.toUserMessage(),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (reason.isRecoverableByRetryClaimOnly()) {
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { viewModel.retryClaim(pairUri) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.action_try_again))
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
            TextButton(onClick = onCancel) {
                Text(stringResource(R.string.action_cancel))
            }
        }
    }
}

@Composable
private fun Header(serverUrl: String, code: String) {
    Text(
        text = stringResource(R.string.login_title),
        style = MaterialTheme.typography.headlineMedium,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(8.dp))
    Text(
        text = stringResource(R.string.login_subtitle, serverUrl),
        style = MaterialTheme.typography.bodyMedium,
        textAlign = TextAlign.Center,
        color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f),
    )
    Spacer(Modifier.height(8.dp))
    Text(
        text = stringResource(R.string.login_pair_code_label, code),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.5f),
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun CredentialsForm(
    state: PairFlowUiState,
    onUsernameChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    OutlinedTextField(
        value = state.username,
        onValueChange = onUsernameChange,
        label = { Text(stringResource(R.string.login_username)) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Text,
            imeAction = ImeAction.Next,
        ),
    )
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(
        value = state.password,
        onValueChange = onPasswordChange,
        label = { Text(stringResource(R.string.login_password)) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Password,
            imeAction = ImeAction.Done,
        ),
    )
    Spacer(Modifier.height(20.dp))
    Button(
        onClick = onSubmit,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(R.string.login_cta))
    }
}

@Composable
private fun ProgressBlock(label: String) {
    Spacer(Modifier.height(32.dp))
    CircularProgressIndicator(modifier = Modifier.size(48.dp))
    Spacer(Modifier.height(16.dp))
    Text(
        text = label,
        style = MaterialTheme.typography.bodyLarge,
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun ErrorReason.toUserMessage(): String = when (this) {
    ErrorReason.EmptyFields -> stringResource(R.string.login_error_empty)
    ErrorReason.InvalidCredentials -> stringResource(R.string.login_error_invalid)
    ErrorReason.RateLimited -> stringResource(R.string.login_error_rate_limited)
    ErrorReason.NotLoggedIn -> stringResource(R.string.pair_error_not_logged_in)
    ErrorReason.OwnerMismatch -> stringResource(R.string.pair_error_owner_mismatch)
    ErrorReason.UnknownCode -> stringResource(R.string.pair_error_unknown_code)
    ErrorReason.CodeAlreadyUsed -> stringResource(R.string.pair_error_code_used)
    ErrorReason.CodeExpired -> stringResource(R.string.pair_error_code_expired)
    ErrorReason.UpstreamFailure -> stringResource(R.string.pair_error_upstream)
    is ErrorReason.Detail -> text
}

/**
 * After a successful login, errors that only fail the claim half (expired
 * code, owner mismatch, upstream NC issue) can be retried with just the
 * cookie jar — no need to re-prompt for the password.
 */
private fun ErrorReason.isRecoverableByRetryClaimOnly(): Boolean = when (this) {
    ErrorReason.UpstreamFailure,
    ErrorReason.RateLimited -> true
    else -> false
}
