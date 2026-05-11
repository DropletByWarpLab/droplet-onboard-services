package ai.warplab.droplet.pair

import com.google.common.truth.Truth.assertThat
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.JUnit4

@RunWith(JUnit4::class)
class UrlValidatorTest {

    @Test fun `bare host gets https`() {
        assertThat(UrlValidator.normaliseServerUrl("droplet.local"))
            .isEqualTo("https://droplet.local")
    }

    @Test fun `trims whitespace and trailing slash`() {
        assertThat(UrlValidator.normaliseServerUrl("  https://droplet.local/  "))
            .isEqualTo("https://droplet.local")
    }

    @Test fun `keeps explicit non-default port`() {
        assertThat(UrlValidator.normaliseServerUrl("http://192.168.1.42:8080/"))
            .isEqualTo("http://192.168.1.42:8080")
    }

    @Test fun `lowercases host`() {
        assertThat(UrlValidator.normaliseServerUrl("HTTPS://DROPLET.LOCAL"))
            .isEqualTo("https://droplet.local")
    }

    @Test fun `rejects empty`() {
        assertThat(UrlValidator.normaliseServerUrl("")).isNull()
        assertThat(UrlValidator.normaliseServerUrl("   ")).isNull()
    }

    @Test fun `rejects disallowed scheme`() {
        assertThat(UrlValidator.normaliseServerUrl("ftp://droplet.local")).isNull()
        assertThat(UrlValidator.normaliseServerUrl("javascript:alert(1)")).isNull()
    }

    @Test fun `idempotent`() {
        val once = UrlValidator.normaliseServerUrl("droplet.local")!!
        val twice = UrlValidator.normaliseServerUrl(once)
        assertThat(twice).isEqualTo(once)
    }
}
