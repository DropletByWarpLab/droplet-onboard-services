package com.droplet.mobile.android.autoupload

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Tiny DataStore wrapper for the auto-upload feature flag + last-run
 * timestamp. The worker uses the timestamp as a watermark — every photo
 * with `DATE_ADDED >= lastRunAt` is a candidate for upload. First-run
 * watermark is set to `System.currentTimeMillis()` so we don't try to
 * back-fill an existing library.
 */
class AutoUploadSettings(context: Context) {

    private val Context.dataStore by preferencesDataStore(name = STORE_NAME)
    private val ds = context.applicationContext.dataStore

    private object Keys {
        val ENABLED = booleanPreferencesKey("enabled")
        val LAST_RUN_AT = longPreferencesKey("last_run_at_seconds")
        val LAST_SUCCESS_AT = longPreferencesKey("last_success_at_seconds")
    }

    val enabledFlow: Flow<Boolean> = ds.data.map { it[Keys.ENABLED] ?: false }
    val lastSuccessFlow: Flow<Long?> = ds.data.map { it[Keys.LAST_SUCCESS_AT] }

    suspend fun isEnabled(): Boolean = enabledFlow.first()

    suspend fun setEnabled(value: Boolean) {
        ds.edit { prefs ->
            prefs[Keys.ENABLED] = value
            if (value && prefs[Keys.LAST_RUN_AT] == null) {
                // Don't back-fill history on first enable — the watermark
                // starts now, so only photos taken AFTER opting in will sync.
                prefs[Keys.LAST_RUN_AT] = System.currentTimeMillis() / 1_000L
            }
        }
    }

    /** Returns the watermark in seconds-since-epoch — matches MediaStore.DATE_ADDED. */
    suspend fun lastRunAtSeconds(): Long =
        ds.data.first()[Keys.LAST_RUN_AT] ?: (System.currentTimeMillis() / 1_000L)

    suspend fun setLastRunAtSeconds(value: Long) {
        ds.edit { it[Keys.LAST_RUN_AT] = value }
    }

    suspend fun setLastSuccessAtSeconds(value: Long) {
        ds.edit { it[Keys.LAST_SUCCESS_AT] = value }
    }

    private companion object {
        const val STORE_NAME = "droplet_autoupload"
    }
}
