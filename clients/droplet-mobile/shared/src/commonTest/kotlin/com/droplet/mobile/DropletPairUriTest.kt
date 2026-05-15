package com.droplet.mobile

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DropletPairUriTest {

    @Test
    fun `parses well-formed pair URI`() {
        val parsed = DropletPairUri.parseOrNull(
            "droplet://pair?server=https%3A%2F%2Fdroplet.local&code=8E3QN3"
        )
        assertEquals("https://droplet.local", parsed?.server)
        assertEquals("8E3QN3", parsed?.code)
    }

    @Test
    fun `accepts unencoded server param`() {
        val parsed = DropletPairUri.parseOrNull(
            "droplet://pair?server=https://192.168.10.1&code=8E3QN3"
        )
        assertEquals("https://192.168.10.1", parsed?.server)
        assertEquals("8E3QN3", parsed?.code)
    }

    @Test
    fun `strips trailing slash on server`() {
        val parsed = DropletPairUri.parseOrNull(
            "droplet://pair?server=https%3A%2F%2Fdroplet.local%2F&code=ABCDEF"
        )
        assertEquals("https://droplet.local", parsed?.server)
    }

    @Test
    fun `rejects wrong scheme`() {
        assertNull(DropletPairUri.parseOrNull("https://droplet.local/pair?code=ABCDEF"))
    }

    @Test
    fun `rejects wrong path`() {
        assertNull(DropletPairUri.parseOrNull("droplet://login?server=https://x&code=ABCDEF"))
    }

    @Test
    fun `rejects missing code`() {
        assertNull(DropletPairUri.parseOrNull("droplet://pair?server=https://droplet.local"))
    }

    @Test
    fun `rejects missing server`() {
        assertNull(DropletPairUri.parseOrNull("droplet://pair?code=ABCDEF"))
    }

    @Test
    fun `rejects wrong code length`() {
        assertNull(DropletPairUri.parseOrNull("droplet://pair?server=https://x&code=ABC"))
        assertNull(DropletPairUri.parseOrNull("droplet://pair?server=https://x&code=ABCDEFGHIJ"))
    }

    @Test
    fun `rejects non-http server scheme`() {
        assertNull(DropletPairUri.parseOrNull("droplet://pair?server=ftp%3A%2F%2Fx&code=ABCDEF"))
    }

    @Test
    fun `ignores unknown query params`() {
        val parsed = DropletPairUri.parseOrNull(
            "droplet://pair?foo=bar&server=https%3A%2F%2Fdroplet.local&code=ABCDEF&hint=mobile"
        )
        assertEquals("https://droplet.local", parsed?.server)
        assertEquals("ABCDEF", parsed?.code)
    }
}
