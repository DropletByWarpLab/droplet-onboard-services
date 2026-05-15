package com.droplet.mobile.android.ui.files

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.droplet.mobile.files.FilesRepository
import com.droplet.mobile.files.WebDavEntry
import com.droplet.mobile.files.WebDavException
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

class FilesViewModel(
    private val repository: FilesRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(FilesUiState())
    val state: StateFlow<FilesUiState> = _state.asStateFlow()

    init {
        load("")
    }

    fun load(path: String) {
        _state.update { it.copy(path = path, isLoading = true, error = null) }
        viewModelScope.launch {
            val result = runCatching { repository.list(path = path, depth = 1) }
            result.onSuccess { entries ->
                _state.update {
                    it.copy(
                        isLoading = false,
                        entries = entries.sortedWith(
                            compareByDescending<WebDavEntry> { it.isDirectory }.thenBy { it.displayName.lowercase() }
                        ),
                        error = null,
                    )
                }
            }.onFailure { err ->
                _state.update { it.copy(isLoading = false, error = err.toReason()) }
            }
        }
    }

    fun enter(entry: WebDavEntry) {
        if (entry.isDirectory) load(entry.path)
    }

    fun up() {
        val current = _state.value.path
        if (current.isEmpty()) return
        val parent = current.trimEnd('/').substringBeforeLast('/', missingDelimiterValue = "")
        load(parent)
    }

    fun refresh() = load(_state.value.path)

    /**
     * Downloads `entry` into the system Downloads collection via MediaStore.
     * Returns the user-visible filename on completion via the state flow.
     */
    fun download(context: Context, entry: WebDavEntry) {
        if (entry.isDirectory) return
        _state.update { it.copy(downloadState = DownloadState.InProgress(entry.displayName)) }
        viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    val channel = repository.download(entry.path)
                    writeToDownloads(context, entry.displayName, channel)
                }
            }
            result.onSuccess { uri ->
                _state.update { it.copy(downloadState = DownloadState.Done(entry.displayName, uri)) }
            }.onFailure { err ->
                _state.update {
                    it.copy(downloadState = DownloadState.Failed(entry.displayName, err.toReason()))
                }
            }
        }
    }

    fun dismissDownloadResult() {
        _state.update { it.copy(downloadState = DownloadState.Idle) }
    }

    private suspend fun writeToDownloads(
        context: Context,
        displayName: String,
        channel: ByteReadChannel,
    ): Uri {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Could not create Downloads entry")
            resolver.openOutputStream(uri)?.use { out ->
                channel.copyTo(out)
            } ?: throw IllegalStateException("Could not open Downloads output stream")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri
        } else {
            // Pre-Q: drop into the public Downloads directory.
            @Suppress("DEPRECATION")
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            if (!dir.exists()) dir.mkdirs()
            val target = File(dir, displayName)
            FileOutputStream(target).use { out ->
                channel.copyTo(out)
            }
            return Uri.fromFile(target)
        }
    }
}

private suspend fun ByteReadChannel.copyTo(out: java.io.OutputStream) {
    val buffer = ByteArray(64 * 1024)
    while (true) {
        val read = readAvailable(buffer, 0, buffer.size)
        if (read == -1) break
        if (read == 0) continue
        out.write(buffer, 0, read)
    }
    out.flush()
}

private fun Throwable.toReason(): FilesErrorReason = when (this) {
    WebDavException.Unauthorized -> FilesErrorReason.Unauthorized
    WebDavException.NotFound -> FilesErrorReason.NotFound
    WebDavException.Forbidden -> FilesErrorReason.Forbidden
    WebDavException.Conflict -> FilesErrorReason.Conflict
    is WebDavException.Other -> FilesErrorReason.Detail("Server returned ${statusCode}")
    else -> FilesErrorReason.Detail(message ?: "Couldn't reach the Droplet")
}

data class FilesUiState(
    val path: String = "",
    val entries: List<WebDavEntry> = emptyList(),
    val isLoading: Boolean = false,
    val error: FilesErrorReason? = null,
    val downloadState: DownloadState = DownloadState.Idle,
)

sealed interface DownloadState {
    data object Idle : DownloadState
    data class InProgress(val displayName: String) : DownloadState
    data class Done(val displayName: String, val uri: Uri) : DownloadState
    data class Failed(val displayName: String, val reason: FilesErrorReason) : DownloadState
}

sealed interface FilesErrorReason {
    data object Unauthorized : FilesErrorReason
    data object NotFound : FilesErrorReason
    data object Forbidden : FilesErrorReason
    data object Conflict : FilesErrorReason
    data class Detail(val text: String) : FilesErrorReason
}
