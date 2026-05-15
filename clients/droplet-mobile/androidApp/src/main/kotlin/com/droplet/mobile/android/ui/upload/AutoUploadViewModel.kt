package com.droplet.mobile.android.ui.upload

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.droplet.mobile.android.autoupload.AutoUploadSettings
import com.droplet.mobile.android.autoupload.UploadScheduler
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Owns the auto-upload feature flag + last-run state and the user-facing
 * actions ("turn on / off", "run now"). The actual worker scheduling is
 * delegated to [UploadScheduler]; this view-model is concerned only with
 * persisting the user intent and surfacing reactive state to the UI.
 */
class AutoUploadViewModel(
    private val settings: AutoUploadSettings,
    private val scheduler: UploadScheduler,
) : ViewModel() {

    val state: StateFlow<AutoUploadUiState> =
        combine(settings.enabledFlow, settings.lastSuccessFlow) { enabled, lastSuccess ->
            AutoUploadUiState(
                enabled = enabled,
                lastSuccessSeconds = lastSuccess,
            )
        }.stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = AutoUploadUiState(),
        )

    fun setEnabled(enabled: Boolean) {
        viewModelScope.launch {
            settings.setEnabled(enabled)
            if (enabled) scheduler.enable() else scheduler.disable()
        }
    }

    fun runNow() {
        scheduler.runNow()
    }
}

data class AutoUploadUiState(
    val enabled: Boolean = false,
    val lastSuccessSeconds: Long? = null,
)
