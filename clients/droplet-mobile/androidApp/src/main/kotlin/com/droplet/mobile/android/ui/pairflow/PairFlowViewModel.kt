package com.droplet.mobile.android.ui.pairflow

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.droplet.mobile.DropletApiException
import com.droplet.mobile.DropletPairUri
import com.droplet.mobile.DropletSession
import com.droplet.mobile.LoginResponse
import com.droplet.mobile.PairingRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Drives both halves of the pair flow against a single [PairingRepository]
 * (and thus a single Ktor HttpClient + cookie jar) so the session cookie
 * captured by `/api/auth/login` is still in scope when `/api/devices/pair/claim`
 * runs immediately afterwards.
 *
 * State machine:
 *   Idle → Authenticating → Claiming → Success
 *                       ↘ Error(reason) → (user fixes input) → Authenticating …
 *   Idle ←─────── reset() ←───────────────┘
 *
 * If login succeeds but claim fails for a recoverable reason (e.g. expired
 * code), [retryClaim] re-runs only the claim — no need to re-enter the
 * password.
 */
class PairFlowViewModel(
    private val repository: PairingRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(PairFlowUiState())
    val state: StateFlow<PairFlowUiState> = _state.asStateFlow()

    private var lastSignedInUser: LoginResponse.User? = null

    fun setUsername(value: String) = _state.update {
        it.copy(username = value, error = null)
    }

    fun setPassword(value: String) = _state.update {
        it.copy(password = value, error = null)
    }

    fun submit(pairUri: DropletPairUri) {
        val snapshot = _state.value
        if (snapshot.phase is Phase.Authenticating || snapshot.phase is Phase.Claiming) return
        if (snapshot.username.isBlank() || snapshot.password.isBlank()) {
            _state.update { it.copy(error = ErrorReason.EmptyFields) }
            return
        }
        _state.update { it.copy(phase = Phase.Authenticating, error = null) }
        viewModelScope.launch {
            val loginResult = runCatching {
                repository.signIn(snapshot.username.trim(), snapshot.password)
            }
            loginResult.onFailure { err ->
                _state.update { it.copy(phase = Phase.Idle, error = err.toErrorReason()) }
                return@launch
            }
            val user = loginResult.getOrThrow().user
            lastSignedInUser = user
            runClaim(pairUri, user)
        }
    }

    fun retryClaim(pairUri: DropletPairUri) {
        val user = lastSignedInUser ?: return
        if (_state.value.phase is Phase.Claiming) return
        _state.update { it.copy(phase = Phase.Claiming, error = null) }
        viewModelScope.launch {
            runClaim(pairUri, user)
        }
    }

    private suspend fun runClaim(pairUri: DropletPairUri, user: LoginResponse.User) {
        _state.update { it.copy(phase = Phase.Claiming) }
        val claimResult = runCatching { repository.claim(pairUri, user) }
        claimResult.onSuccess { session ->
            _state.update { it.copy(phase = Phase.Success(session), error = null) }
        }.onFailure { err ->
            _state.update { it.copy(phase = Phase.Idle, error = err.toErrorReason()) }
        }
    }

    fun reset() {
        _state.value = PairFlowUiState()
        lastSignedInUser = null
    }
}

private fun Throwable.toErrorReason(): ErrorReason = when (this) {
    DropletApiException.InvalidCredentials -> ErrorReason.InvalidCredentials
    DropletApiException.NotLoggedIn -> ErrorReason.NotLoggedIn
    DropletApiException.OwnerMismatch -> ErrorReason.OwnerMismatch
    DropletApiException.UnknownCode -> ErrorReason.UnknownCode
    DropletApiException.CodeAlreadyUsed -> ErrorReason.CodeAlreadyUsed
    DropletApiException.CodeExpired -> ErrorReason.CodeExpired
    DropletApiException.RateLimited -> ErrorReason.RateLimited
    DropletApiException.UpstreamFailure -> ErrorReason.UpstreamFailure
    is DropletApiException.BadRequest -> ErrorReason.Detail(message ?: "Rejected by Droplet")
    is DropletApiException.Unexpected -> ErrorReason.Detail(message ?: "Unexpected server error")
    else -> ErrorReason.Detail(message ?: "Couldn't reach the Droplet")
}

data class PairFlowUiState(
    val username: String = "",
    val password: String = "",
    val phase: Phase = Phase.Idle,
    val error: ErrorReason? = null,
)

sealed interface Phase {
    data object Idle : Phase
    data object Authenticating : Phase
    data object Claiming : Phase
    data class Success(val session: DropletSession) : Phase
}

sealed interface ErrorReason {
    data object EmptyFields : ErrorReason
    data object InvalidCredentials : ErrorReason
    data object NotLoggedIn : ErrorReason
    data object OwnerMismatch : ErrorReason
    data object UnknownCode : ErrorReason
    data object CodeAlreadyUsed : ErrorReason
    data object CodeExpired : ErrorReason
    data object RateLimited : ErrorReason
    data object UpstreamFailure : ErrorReason
    data class Detail(val text: String) : ErrorReason
}
