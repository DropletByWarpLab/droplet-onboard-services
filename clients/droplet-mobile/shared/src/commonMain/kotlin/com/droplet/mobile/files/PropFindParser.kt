package com.droplet.mobile.files

/**
 * Minimal PROPFIND multi-status parser.
 *
 * Nextcloud emits `<d:multistatus><d:response>...</d:response>…</d:multistatus>`
 * with a stable structure per entry. Rather than pull a KMP XML library
 * we walk the `<d:response>` blocks with substring scans and extract the
 * five fields we care about. This is robust against namespace prefix
 * variations (the namespace may be `d:`, `D:`, or unprefixed) but does
 * *not* try to be a general XML parser — anything weirder than what
 * Nextcloud emits should be reported as a parse failure and surfaced to
 * the user as "couldn't read folder."
 */
object PropFindParser {

    private val responseBlockRegex = Regex(
        """<(?:\w+:)?response\b[^>]*>([\s\S]*?)</(?:\w+:)?response>""",
        RegexOption.IGNORE_CASE,
    )

    fun parse(xml: String, webdavBaseUrl: String): List<WebDavEntry> {
        val basePath = extractBasePath(webdavBaseUrl)
        return responseBlockRegex.findAll(xml)
            .mapNotNull { match -> parseResponse(match.groupValues[1], basePath) }
            .toList()
    }

    private fun parseResponse(block: String, basePath: String): WebDavEntry? {
        val href = findFirstTag(block, "href") ?: return null
        val isCollection = block.contains("<(?:\\w+:)?collection".toRegex(RegexOption.IGNORE_CASE))
        val displayName = findFirstTag(block, "displayname")
            ?: deriveDisplayName(href)
        val length = findFirstTag(block, "getcontentlength")?.toLongOrNull()
        val lastModified = findFirstTag(block, "getlastmodified")
        val contentType = findFirstTag(block, "getcontenttype")
        val relative = stripBase(href, basePath)
        return WebDavEntry(
            path = relative,
            displayName = displayName,
            isDirectory = isCollection,
            sizeBytes = length,
            lastModified = lastModified,
            contentType = contentType,
        )
    }

    /** Returns the inner text of the first `<…:tag>…</…:tag>` in `block`. */
    internal fun findFirstTag(block: String, tag: String): String? {
        val regex = Regex(
            """<(?:\w+:)?$tag\b[^/>]*>([\s\S]*?)</(?:\w+:)?$tag>""",
            RegexOption.IGNORE_CASE,
        )
        return regex.find(block)?.groupValues?.get(1)?.let { decode(it.trim()) }
    }

    private fun deriveDisplayName(href: String): String {
        val trimmed = href.trimEnd('/')
        val slash = trimmed.lastIndexOf('/')
        val segment = if (slash >= 0) trimmed.substring(slash + 1) else trimmed
        return decode(segment)
    }

    /**
     * Strip the WebDAV mount prefix (e.g. `/nextcloud/remote.php/dav/files/stefan`)
     * from `href`, returning the user-relative path. If `href` is not under the
     * mount, returns it verbatim — the caller can still display it.
     */
    private fun stripBase(href: String, basePath: String): String {
        // Server may emit either an absolute path ("/nextcloud/remote.php/...") or
        // a full URL ("https://host/nextcloud/..."). Normalise to the path part.
        val pathOnly = if (href.startsWith("http://") || href.startsWith("https://")) {
            val schemeEnd = href.indexOf("://") + 3
            val firstSlash = href.indexOf('/', schemeEnd)
            if (firstSlash < 0) "/" else href.substring(firstSlash)
        } else {
            href
        }
        val stripped = if (pathOnly.startsWith(basePath)) {
            pathOnly.substring(basePath.length)
        } else {
            pathOnly
        }
        return stripped.trimStart('/')
    }

    private fun extractBasePath(webdavBaseUrl: String): String {
        val schemeEnd = webdavBaseUrl.indexOf("://").takeIf { it >= 0 } ?: return webdavBaseUrl
        val firstSlash = webdavBaseUrl.indexOf('/', schemeEnd + 3)
        val pathOnly = if (firstSlash < 0) "/" else webdavBaseUrl.substring(firstSlash)
        return pathOnly.trimEnd('/')
    }

    private fun decode(value: String): String {
        // Strip XML entities the server commonly emits, then percent-decode.
        val unescaped = value
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
        return percentDecode(unescaped)
    }

    private fun percentDecode(raw: String): String {
        if ('%' !in raw) return raw
        val out = StringBuilder(raw.length)
        var i = 0
        val bytes = ArrayList<Byte>()
        while (i < raw.length) {
            val ch = raw[i]
            if (ch == '%' && i + 2 < raw.length) {
                val hex = raw.substring(i + 1, i + 3).toIntOrNull(16)
                if (hex != null) {
                    bytes.add(hex.toByte())
                    i += 3
                    continue
                }
            }
            if (bytes.isNotEmpty()) {
                out.append(bytes.toByteArray().decodeToString())
                bytes.clear()
            }
            out.append(ch)
            i++
        }
        if (bytes.isNotEmpty()) {
            out.append(bytes.toByteArray().decodeToString())
        }
        return out.toString()
    }
}
