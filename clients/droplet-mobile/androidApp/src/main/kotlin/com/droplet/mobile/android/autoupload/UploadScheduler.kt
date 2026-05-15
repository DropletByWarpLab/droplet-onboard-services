package com.droplet.mobile.android.autoupload

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Schedules and unschedules the [PhotoUploadWorker]. Default cadence is
 * every 6 hours; constraints require unmetered network + a charged-enough
 * battery so we don't drain the device or burn cellular data.
 *
 * The job is enqueued with `KEEP` policy so toggling the feature
 * on/off/on doesn't accumulate duplicate work — only one periodic job
 * with [PhotoUploadWorker.UNIQUE_NAME] can be live at a time.
 */
class UploadScheduler(context: Context) {

    private val workManager = WorkManager.getInstance(context.applicationContext)

    fun enable() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresBatteryNotLow(true)
            .build()
        val request = PeriodicWorkRequestBuilder<PhotoUploadWorker>(6, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
        workManager.enqueueUniquePeriodicWork(
            PhotoUploadWorker.UNIQUE_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    fun disable() {
        workManager.cancelUniqueWork(PhotoUploadWorker.UNIQUE_NAME)
    }

    /**
     * Fire the worker immediately, bypassing the cadence — used by the
     * "Run now" button. Same constraints as the periodic job; if Wi-Fi
     * is unavailable the user will see "waiting for network" in the
     * Workinfo, which is the correct behaviour.
     */
    fun runNow() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build()
        val request = OneTimeWorkRequestBuilder<PhotoUploadWorker>()
            .setConstraints(constraints)
            .build()
        workManager.enqueueUniqueWork(
            "${PhotoUploadWorker.UNIQUE_NAME}.now",
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }
}
