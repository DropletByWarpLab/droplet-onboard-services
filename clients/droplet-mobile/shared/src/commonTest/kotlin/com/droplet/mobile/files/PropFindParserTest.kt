package com.droplet.mobile.files

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PropFindParserTest {

    private val webdavBase = "https://droplet.local/nextcloud/remote.php/dav/files/stefan/"

    @Test
    fun `parses a folder with one file and one subfolder`() {
        val xml = """
        <?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/nextcloud/remote.php/dav/files/stefan/</d:href>
            <d:propstat>
              <d:prop>
                <d:displayname>stefan</d:displayname>
                <d:resourcetype><d:collection/></d:resourcetype>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/nextcloud/remote.php/dav/files/stefan/Photos/</d:href>
            <d:propstat>
              <d:prop>
                <d:displayname>Photos</d:displayname>
                <d:getlastmodified>Tue, 14 May 2024 12:34:56 GMT</d:getlastmodified>
                <d:resourcetype><d:collection/></d:resourcetype>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/nextcloud/remote.php/dav/files/stefan/welcome.txt</d:href>
            <d:propstat>
              <d:prop>
                <d:displayname>welcome.txt</d:displayname>
                <d:getcontentlength>123</d:getcontentlength>
                <d:getcontenttype>text/plain</d:getcontenttype>
                <d:getlastmodified>Tue, 14 May 2024 12:00:00 GMT</d:getlastmodified>
                <d:resourcetype/>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>
        """.trimIndent()

        val entries = PropFindParser.parse(xml, webdavBase)
        // The root response (path == "") is dropped by the caller (WebDavClient),
        // but the parser still emits it — confirm we see all three rows here.
        assertEquals(3, entries.size)

        val photos = entries.first { it.path == "Photos" }
        assertEquals("Photos", photos.displayName)
        assertTrue(photos.isDirectory)

        val welcome = entries.first { it.path == "welcome.txt" }
        assertEquals("welcome.txt", welcome.displayName)
        assertEquals(false, welcome.isDirectory)
        assertEquals(123L, welcome.sizeBytes)
        assertEquals("text/plain", welcome.contentType)
    }

    @Test
    fun `decodes percent-encoded segments in href`() {
        val xml = """
        <?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/nextcloud/remote.php/dav/files/stefan/Hello%20World/file%20%C3%A9.txt</d:href>
            <d:propstat>
              <d:prop>
                <d:displayname>file é.txt</d:displayname>
                <d:resourcetype/>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>
        """.trimIndent()
        val entries = PropFindParser.parse(xml, webdavBase)
        assertEquals(1, entries.size)
        val e = entries.single()
        assertEquals("Hello World/file é.txt", e.path)
        assertEquals("file é.txt", e.displayName)
    }

    @Test
    fun `accepts uppercase namespace prefix`() {
        val xml = """
        <?xml version="1.0"?>
        <D:multistatus xmlns:D="DAV:">
          <D:response>
            <D:href>/nextcloud/remote.php/dav/files/stefan/Photos/</D:href>
            <D:propstat>
              <D:prop>
                <D:displayname>Photos</D:displayname>
                <D:resourcetype><D:collection/></D:resourcetype>
              </D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
        </D:multistatus>
        """.trimIndent()
        val entries = PropFindParser.parse(xml, webdavBase)
        assertEquals(1, entries.size)
        assertTrue(entries.single().isDirectory)
    }

    @Test
    fun `handles entity-escaped names`() {
        val xml = """
        <?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/nextcloud/remote.php/dav/files/stefan/AT%26T.txt</d:href>
            <d:propstat>
              <d:prop>
                <d:displayname>AT&amp;T.txt</d:displayname>
                <d:resourcetype/>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>
        """.trimIndent()
        val entries = PropFindParser.parse(xml, webdavBase)
        assertEquals("AT&T.txt", entries.single().displayName)
    }
}
