package com.droplet.mobile.android.autoupload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.droplet.mobile.android.R
import com.droplet.mobile.files.FilesRepository
import com.droplet.mobile.files.WebDavException
import io.ktor.http.ContentType
import org.koin.core.component.KoinComponent
import org.koin.core.component.inject

/**
 * WorkManager job that runs on a 6-hour cadence (default) and uploads any
 * new images in `MediaStore.Images` whose `DATE_ADDED >= lastRunAt`.
 *
 * Idempotency strategy: the worker advances `lastRunAt` only on successful
 * completion. A killed run keeps the old watermark so the next attempt
 * retries the same window. Uploads themselves are PUTs to
 * `Photos/<displayName>` — WebDAV PUTs are idempotent at the HTTP level
 * (replace), and the orchestrator's Nextcloud configuration treats them
 * as upserts. Files already on the Droplet are simply re-PUT, which is
 * wasteful but never duplicates entries.
 *
 * A foreground notification keeps the OS from killing the job mid-batch
 * when several large photos are queued; the channel is silent.
 */
class PhotoUploadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params), KoinComponent {

    private val filesRepository: FilesRepository by inject()
    private val settings: AutoUploadSettings by inject()

    override suspend fun doWork(): Result {
        if (!settings.isEnabled()) return Result.success()

        val watermarkSeconds = settings.lastRunAtSeconds()
        val candidates = PhotoEnumerator.queryImagesSince(applicationContext, watermarkSeconds)
        if (candidates.isEmpty()) {
            // Nothing new — advance the watermark to "now" so we don't keep
            // querying the same empty window.
            settings.setLastRunAtSeconds(System.currentTimeMillis() / 1_000L)
            settings.setLastSuccessAtSeconds(System.currentTimeMillis() / 1_000L)
            return Result.success()
        }

        try {
            setForeground(buildForegroundInfo(initialCount = candidates.size))
        } catch (e: IllegalStateException) {
            // setForeground can fail on Android 14+ if the worker wasn't
            // started with a foreground service trigger. In that case we
            // just continue without it — WorkManager will still keep us
            // alive for the standard 10-minute window.
        }

        // Make sure the Photos collection exists before the first PUT to
        // avoid an N-way race of MKCOLs.
        runCatching { filesRepository.ensureDirectory(REMOTE_DIR) }
            .onFailure { return Result.retry() }

        var uploadedHighWater = watermarkSeconds
        var anyFailures = false
        for ((index, candidate) in candidates.withIndex()) {
            setForeground(buildForegroundInfo(index + 1, candidates.size, candidate.displayName))
            val outcome = runCatching { uploadOne(candidate) }
            outcome.onSuccess {
                if (candidate.dateAddedSeconds > uploadedHighWater) {
                    uploadedHighWater = candidate.dateAddedSeconds
                    // Persist after each success so a kill in the middle of
                    // the batch doesn't lose progress.
                    settings.setLastRunAtSeconds(uploadedHighWater + 1)
                }
            }.onFailure { err ->
                anyFailures = true
                if (err is WebDavException.Unauthorized) {
                    // Device was revoked server-side — bail out and let
                    // the user re-pair before we retry.
                    return Result.failure()
                }
            }
        }

        settings.setLastSuccessAtSeconds(System.currentTimeMillis() / 1_000L)
        return if (anyFailures) Result.retry() else Result.success()
    }

    private suspend fun uploadOne(candidate: PhotoEnumerator.Candidate) {
        val ctx = applicationContext
        val bytes = ctx.contentResolver.openInputStream(candidate.uri)?.use { it.readBytes() }
            ?: throw IllegalStateException("Could not open ${candidate.displayName}")
        val contentType = candidate.mimeType?.let { runCatching { ContentType.parse(it) }.getOrNull() }
        filesRepository.upload(
            path = "$REMOTE_DIR/${candidate.displayName}",
            body = bytes,
            contentType = contentType,
        )
    }

    private fun buildForegroundInfo(
        progress: Int = 0,
        total: Int = 0,
        currentName: String? = null,
        initialCount: Int? = null,
    ): ForegroundInfo {
        ensureChannel()
        val text = when {
            initialCount != null -> applicationContext.getString(R.string.autoupload_notif_starting, initialCount)
            currentName != null -> applicationContext.getString(R.string.autoupload_notif_progress, progress, total)
            else -> applicationContext.getString(R.string.autoupload_notif_running)
        }
        val notif: Notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(applicationContext.getString(R.string.autoupload_notif_title))
            .setContentText(text)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setProgress(total.coerceAtLeast(1), progress, total == 0)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ForegroundInfo(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIF_ID, notif)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ContextCompat.getSystemService(applicationContext, NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                applicationContext.getString(R.string.autoupload_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = applicationContext.getString(R.string.autoupload_channel_description)
                setShowBadge(false)
            }
        )
    }

    companion object {
        const val UNIQUE_NAME = "droplet.autoupload.photos"
        const val CHANNEL_ID = "droplet_autoupload"
        const val NOTIF_ID = 4201
        const val REMOTE_DIR = "Photos"
    }
}
