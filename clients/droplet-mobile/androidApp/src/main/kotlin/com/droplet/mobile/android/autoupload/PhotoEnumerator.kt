package com.droplet.mobile.android.autoupload

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore

/**
 * Minimal MediaStore query for images added on/after `sinceSeconds`.
 *
 * Returns a list of `(uri, displayName, dateAddedSeconds, mimeType, size)`
 * tuples sorted oldest-first so the worker uploads in chronological order —
 * partial progress is durable: if the worker is killed mid-batch, the next
 * run sees a higher watermark and skips already-uploaded items.
 */
object PhotoEnumerator {

    data class Candidate(
        val uri: Uri,
        val displayName: String,
        val dateAddedSeconds: Long,
        val mimeType: String?,
        val sizeBytes: Long,
    )

    fun queryImagesSince(context: Context, sinceSeconds: Long): List<Candidate> {
        val resolver = context.contentResolver
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.SIZE,
        )
        val selection = "${MediaStore.Images.Media.DATE_ADDED} >= ?"
        val selectionArgs = arrayOf(sinceSeconds.toString())
        val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} ASC"
        val out = mutableListOf<Candidate>()
        resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            sortOrder,
        )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val dateCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val mimeCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            while (cursor.moveToNext()) {
                val id = cursor.getLong(idCol)
                val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                out += Candidate(
                    uri = uri,
                    displayName = cursor.getString(nameCol) ?: "upload_$id",
                    dateAddedSeconds = cursor.getLong(dateCol),
                    mimeType = cursor.getString(mimeCol),
                    sizeBytes = cursor.getLong(sizeCol),
                )
            }
        }
        return out
    }
}
