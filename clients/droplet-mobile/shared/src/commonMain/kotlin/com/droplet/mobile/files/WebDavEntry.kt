package com.droplet.mobile.files

/**
 * A single file or folder returned by a WebDAV PROPFIND.
 *
 * `path` is the absolute server-side path stripped of the `webdavUrl`
 * prefix — e.g. for `https://x/nextcloud/remote.php/dav/files/stefan/Photos/IMG_1.jpg`
 * with webdavUrl `https://x/nextcloud/remote.php/dav/files/stefan/`,
 * `path` is `Photos/IMG_1.jpg`.
 */
data class WebDavEntry(
    val path: String,
    val displayName: String,
    val isDirectory: Boolean,
    val sizeBytes: Long?,
    val lastModified: String?,
    val contentType: String?,
) {
    val parentPath: String?
        get() {
            val trimmed = path.trimEnd('/')
            val slash = trimmed.lastIndexOf('/')
            return if (slash <= 0) null else trimmed.substring(0, slash)
        }
}
