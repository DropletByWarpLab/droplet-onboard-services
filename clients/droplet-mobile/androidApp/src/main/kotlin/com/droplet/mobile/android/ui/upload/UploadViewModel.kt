package com.droplet.mobile.android.ui.upload

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.droplet.mobile.files.FilesRepository
import com.droplet.mobile.files.WebDavException
import io.ktor.http.ContentType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Manual photo upload via the system Photo Picker. Each picked Uri is
 * read via ContentResolver and PUT to `Photos/<originalName>` on the
 * Droplet's WebDAV mount.
 *
 * No READ_MEDIA_IMAGES permission is required — the Photo Picker hands
 * back a scoped, read-only Uri for each item the user explicitly chose.
 */
class UploadViewModel(
    private val repository: FilesRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(UploadUiState())
    val state: StateFlow<UploadUiState> = _state.asStateFlow()

    fun upload(context: Context, uris: List<Uri>) {
        if (uris.isEmpty()) return
        val ctx = context.applicationContext
        _state.value = UploadUiState(
            total = uris.size,
            completed = 0,
            current = null,
            phase = UploadPhase.Working,
            failures = emptyList(),
        )
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                // Ensure the `Photos/` collection exists once up-front rather
                // than per file — saves N-1 MKCOLs and one round-trip per
                // upload after the first.
                runCatching { repository.ensureDirectory(DESTINATION_DIR) }
                    .onFailure { err ->
                        _state.update {
                            it.copy(phase = UploadPhase.Failed(reason = err.toReason()))
                        }
                        return@withContext
                    }

                for ((index, uri) in uris.withIndex()) {
                    val display = readDisplayName(ctx, uri) ?: "upload_${System.currentTimeMillis()}_$index"
                    _state.update {
                        it.copy(current = display, completed = index)
                    }
                    val outcome = runCatching {
                        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                            ?: throw IllegalStateException("Could not open $display")
                        val ct = readMimeType(ctx, uri)?.let { parseContentType(it) }
                        repository.upload(
                            path = "$DESTINATION_DIR/$display",
                            body = bytes,
                            contentType = ct,
                        )
                    }
                    if (outcome.isFailure) {
                        _state.update {
                            it.copy(failures = it.failures + (display to outcome.exceptionOrNull()!!.toReason()))
                        }
                    }
                }
                _state.update {
                    it.copy(
                        completed = uris.size,
                        current = null,
                        phase = UploadPhase.Done,
                    )
                }
            }
        }
    }

    fun reset() {
        _state.value = UploadUiState()
    }

    private fun readDisplayName(context: Context, uri: Uri): String? {
        val resolver = context.contentResolver
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) return c.getString(idx)
            }
        }
        return uri.lastPathSegment
    }

    private fun readMimeType(context: Context, uri: Uri): String? =
        context.contentResolver.getType(uri)

    private companion object {
        const val DESTINATION_DIR = "Photos"
    }
}

private fun parseContentType(raw: String): ContentType? = runCatching {
    ContentType.parse(raw)
}.getOrNull()

private fun Throwable.toReason(): UploadErrorReason = when (this) {
    WebDavException.Unauthorized -> UploadErrorReason.Unauthorized
    WebDavException.Forbidden -> UploadErrorReason.Forbidden
    WebDavException.Conflict -> UploadErrorReason.Conflict
    is WebDavException.Other -> UploadErrorReason.Detail("Server returned $statusCode")
    else -> UploadErrorReason.Detail(message ?: "Couldn't reach the Droplet")
}

data class UploadUiState(
    val total: Int = 0,
    val completed: Int = 0,
    val current: String? = null,
    val phase: UploadPhase = UploadPhase.Idle,
    val failures: List<Pair<String, UploadErrorReason>> = emptyList(),
)

sealed interface UploadPhase {
    data object Idle : UploadPhase
    data object Working : UploadPhase
    data object Done : UploadPhase
    data class Failed(val reason: UploadErrorReason) : UploadPhase
}

sealed interface UploadErrorReason {
    data object Unauthorized : UploadErrorReason
    data object Forbidden : UploadErrorReason
    data object Conflict : UploadErrorReason
    data class Detail(val text: String) : UploadErrorReason
}
