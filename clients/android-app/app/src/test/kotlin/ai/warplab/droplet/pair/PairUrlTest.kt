package ai.warplab.droplet.pair

import com.google.common.truth.Truth.assertThat
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.JUnit4

/**
 * Pure-JVM tests for [PairUrl.parse]. We mock [android.net.Uri] via Robolectric-
 * free shadowing: in JVM tests Android's Uri throws NotImplementedError, so
 * these tests run against the project's UnitTestOptions which include the
 * `includeAndroidResources = true` flag in app/build.gradle.kts (via the
 * default AGP test task).
 *
 * Cases exercise every reject path so a regression that loosens validation
 * fails the build instead of shipping a phishing vector to users.
 */
@RunWith(JUnit4::class)
class PairUrlTest {

    @Test fun `parses canonical url`() {
        val raw = "droplet://pair?server=https%3A%2F%2Fdroplet.local&code=8E3QN3"
        val pair = PairUrl.parse(raw)
        assertThat(pair).isNotNull()
        assertThat(pair!!.server).isEqualTo("https://droplet.local")
        assertThat(pair.code).isEqualTo("8E3QN3")
    }

    @Test fun `accepts http server on LAN`() {
        val raw = "droplet://pair?server=http%3A%2F%2F192.168.1.42%3A8080&code=AB12CD"
        val pair = PairUrl.parse(raw)
        assertThat(pair).isNotNull()
        assertThat(pair!!.server).isEqualTo("http://192.168.1.42:8080")
    }

    @Test fun `strips default https port`() {
        val raw = "droplet://pair?server=https%3A%2F%2Fdroplet.local%3A443&code=AB12CD"
        val pair = PairUrl.parse(raw)
        assertThat(pair!!.server).isEqualTo("https://droplet.local")
    }

    @Test fun `rejects wrong scheme`() {
        assertThat(PairUrl.parse("https://pair?server=https%3A%2F%2Fdroplet.local&code=AB12CD"))
            .isNull()
    }

    @Test fun `rejects wrong host`() {
        assertThat(PairUrl.parse("droplet://unpair?server=https%3A%2F%2Fdroplet.local&code=AB12CD"))
            .isNull()
    }

    @Test fun `rejects missing server param`() {
        assertThat(PairUrl.parse("droplet://pair?code=AB12CD")).isNull()
    }

    @Test fun `rejects missing code param`() {
        assertThat(PairUrl.parse("droplet://pair?server=https%3A%2F%2Fdroplet.local")).isNull()
    }

    @Test fun `rejects javascript scheme server`() {
        assertThat(PairUrl.parse("droplet://pair?server=javascript%3Aalert(1)&code=AB12CD"))
            .isNull()
    }

    @Test fun `rejects empty code`() {
        assertThat(PairUrl.parse("droplet://pair?server=https%3A%2F%2Fdroplet.local&code=")).isNull()
    }

    @Test fun `rejects absurdly long code`() {
        val longCode = "X".repeat(50)
        assertThat(PairUrl.parse("droplet://pair?server=https%3A%2F%2Fdroplet.local&code=$longCode"))
            .isNull()
    }

    @Test fun `rejects garbage`() {
        assertThat(PairUrl.parse("not a url at all")).isNull()
        assertThat(PairUrl.parse("")).isNull()
    }

    @Test fun `case insensitive scheme`() {
        val raw = "DROPLET://pair?server=https%3A%2F%2Fdroplet.local&code=AB12CD"
        assertThat(PairUrl.parse(raw)).isNotNull()
    }
}
