/**
 * WARP-823 — secret redaction for the downloadable log bundle.
 *
 * The log bundle is the single highest-risk secret-exfil surface on the box:
 * journald + container logs routinely echo connection strings, env dumps,
 * bearer tokens and the occasional pasted key. `redactSecrets()` is the
 * mandatory scrub applied to every byte before it can leave the appliance
 * (architecture-guard rule 19). These tests PLANT known secrets and assert
 * they never survive the scrub.
 */
import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  redactSecretParams,
  REDACTION_PLACEHOLDER,
} from "./log-redaction.js";

describe("redactSecrets", () => {
  it("redacts an Authorization: Bearer token", () => {
    const planted = "Bearer eyJhbGciOiJIUzI1Nithemostsecretjwt.abc.def";
    const input = `2026-06-06T10:00:00Z GET /api/llm/models Authorization: ${planted}`;
    const out = redactSecrets(input);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiThemostsecretjwt".toLowerCase());
    expect(out).not.toContain("eyJhbGciOiJIUzI1Nithemostsecretjwt.abc.def");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts a bare X-Droplet-Auth header value", () => {
    const secret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const input = `forwarding to bridge X-Droplet-Auth: ${secret} ok`;
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts an env-style password assignment (password=...)", () => {
    const input = "psql: connecting with password=S3cr3t-Pg-Passw0rd! to db";
    const out = redactSecrets(input);
    expect(out).not.toContain("S3cr3t-Pg-Passw0rd!");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts a quoted env-style password assignment", () => {
    const input = 'MQTT_PASSWORD="mq-very-secret-value-1234" loaded';
    const out = redactSecrets(input);
    expect(out).not.toContain("mq-very-secret-value-1234");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts a sensitive .env line by KEY name (JWT_SECRET=...)", () => {
    const input = "JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef";
    const out = redactSecrets(input);
    expect(out).not.toContain(
      "0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(out).toContain(REDACTION_PLACEHOLDER);
    // The key name itself is fine to keep — only the value is a secret.
    expect(out).toContain("JWT_SECRET");
  });

  it("redacts a variety of *_TOKEN / *_SECRET / *_KEY / *_PASSWORD env keys", () => {
    const lines = [
      "SERVICE_TOKEN_DISPLAY=tok_display_aaaaaaaaaaaaaaaa",
      "BRIDGE_AUTH_TOKEN=tok_bridge_bbbbbbbbbbbbbbbb",
      "DEVICE_SECRET_KEY=dsk_cccccccccccccccccccccccc",
      "REDIS_PASSWORD=redis-ddddddddddddddddd",
      "PM_ADMIN_TOKEN=pm-eeeeeeeeeeeeeeeeeeee",
      "AUDIT_KEY=audit-ffffffffffffffffffff",
    ];
    const out = redactSecrets(lines.join("\n"));
    for (const secret of [
      "tok_display_aaaaaaaaaaaaaaaa",
      "tok_bridge_bbbbbbbbbbbbbbbb",
      "dsk_cccccccccccccccccccccccc",
      "redis-ddddddddddddddddd",
      "pm-eeeeeeeeeeeeeeeeeeee",
      "audit-ffffffffffffffffffff",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it("redacts an entire PEM PRIVATE KEY block", () => {
    const input = [
      "loaded device identity key:",
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDverysecret",
      "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNNOOOO",
      "-----END PRIVATE KEY-----",
      "done",
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDverysecret");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out).toContain(REDACTION_PLACEHOLDER);
    // Surrounding non-secret context survives.
    expect(out).toContain("loaded device identity key:");
    expect(out).toContain("done");
  });

  it("redacts an RSA / EC PRIVATE KEY block variant", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "supersecretrsakeymaterialthatmustnotleak0000000000",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).not.toContain("supersecretrsakeymaterialthatmustnotleak0000000000");
  });

  it("redacts credentials embedded in a connection-string URI", () => {
    const input =
      "DATABASE_URL=postgresql://droplet:pgpass-supersecret@db:5432/droplet";
    const out = redactSecrets(input);
    expect(out).not.toContain("pgpass-supersecret");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts an MQTT URL with inline credentials", () => {
    const input = "connecting mqtt://droplet:mqtt-inline-secret@127.0.0.1:1883";
    const out = redactSecrets(input);
    expect(out).not.toContain("mqtt-inline-secret");
  });

  it("redacts an empty-username connection URI (redis://:pw@host) — secrets.sh's REDIS_URL shape", () => {
    // The uri-userinfo rule's username class is now `*` (was `+`), so the
    // empty-username form `redis://:pw@host` is scrubbed. secrets.sh generates
    // exactly this shape for REDIS_URL, and the key name carries no
    // PASSWORD/SECRET/TOKEN/KEY suffix so the assignment rule never fires —
    // before this fix the password leaked verbatim into the diagnostics bundle.
    const input = "REDIS_URL=redis://:redis-pw-9988xyz@cache:6379";
    const out = redactSecrets(input);
    expect(out).not.toContain("redis-pw-9988xyz");
    expect(out).toContain(REDACTION_PLACEHOLDER);
    // Scheme + host survive so the line is still diagnosable.
    expect(out).toContain("redis://");
    expect(out).toContain("cache:6379");
  });

  it("redacts an empty-username postgres URI (postgresql://:pw@host/db)", () => {
    const input = "DATABASE_URL=postgresql://:pg-empty-user-pw-7766@db:5432/droplet";
    const out = redactSecrets(input);
    expect(out).not.toContain("pg-empty-user-pw-7766");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts Authorization: Basic credentials (5-char scheme)", () => {
    const planted = "dXNlcjpzdXBlci1zZWNyZXQtcGFzcw==";
    const input = `proxy logged Authorization: Basic ${planted} for /api/files`;
    const out = redactSecrets(input);
    expect(out).not.toContain(planted);
    expect(out).toContain(REDACTION_PLACEHOLDER);
    // Surrounding non-secret context survives.
    expect(out).toContain("proxy logged");
    expect(out).toContain("for /api/files");
  });

  it("redacts Authorization: Token credentials (5-char scheme)", () => {
    const planted = "tok-drf-style-secret-000111";
    const input = `Authorization: Token ${planted}`;
    const out = redactSecrets(input);
    expect(out).not.toContain(planted);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("stays idempotent over a redacted Basic header", () => {
    const once = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(redactSecrets(once)).toBe(once);
  });


  it("leaves non-secret log lines untouched", () => {
    const input = [
      "2026-06-06T10:00:00Z orchestrator listening on :3000",
      "GET /api/health 200 4ms",
      "device-bridge reachable at host.docker.internal:9090",
    ].join("\n");
    expect(redactSecrets(input)).toBe(input);
  });

  it("is idempotent — re-redacting already-redacted text is a no-op", () => {
    const input = "JWT_SECRET=0123456789abcdef0123456789abcdef token=abcdef123456";
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it("keeps a PUBLIC_KEY value (public keys are not secret)", () => {
    const input = "AUDIT_PUBLIC_KEY=MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQ-not-secret";
    const out = redactSecrets(input);
    expect(out).toBe(input);
    expect(out).not.toContain(REDACTION_PLACEHOLDER);
  });

  it("still redacts DEVICE_SECRET_KEY despite the KEY suffix", () => {
    const input = "DEVICE_SECRET_KEY=dsk-must-not-leak-0000000000";
    const out = redactSecrets(input);
    expect(out).not.toContain("dsk-must-not-leak-0000000000");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("handles empty / whitespace input without throwing", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("   \n  ")).toBe("   \n  ");
  });
});

/**
 * WARP-1718 — structured (object) redaction for audit params.
 *
 * `redactSecretParams()` is the scrub standing between a Tier-2 network
 * command's raw params and `CommandAuditLog.data`. Same posture as the text
 * scrub above: PLANT a known passphrase, assert it never survives — while the
 * non-secret context that makes an audit row useful stays readable.
 */
describe("redactSecretParams", () => {
  it("redacts a password but keeps the key and its non-secret siblings", () => {
    const out = redactSecretParams({
      iface_section: "default_radio0",
      password: "hunter2-household-psk",
    });

    expect(out).toEqual({
      iface_section: "default_radio0",
      password: REDACTION_PLACEHOLDER,
    });
    // The key survives: the audit still proves a passphrase WAS set.
    expect(Object.keys(out)).toContain("password");
    expect(JSON.stringify(out)).not.toContain("hunter2-household-psk");
  });

  it("redacts create_guest_network's PSK but leaves ssid/radio/network legible", () => {
    const out = redactSecretParams({
      radio: "radio3",
      ssid: "Droplet Guest",
      password: "guest-psk-do-not-leak",
      network: "guest",
    });

    expect(out).toEqual({
      radio: "radio3",
      ssid: "Droplet Guest",
      password: REDACTION_PLACEHOLDER,
      network: "guest",
    });
  });

  it("redacts the WARP-1712 AP shape `{ssid, key}` on the `key` param", () => {
    const out = redactSecretParams({ ssid: "Droplet", key: "ap-psk-do-not-leak" });
    expect(out).toEqual({ ssid: "Droplet", key: REDACTION_PLACEHOLDER });
  });

  it("leaves an absent secret absent rather than implying one was set", () => {
    // WARP-1712 SSID-only edit: `key` is undefined and the op is
    // set_ap_wifi_ssid — a placeholder here would be a lie.
    const out = redactSecretParams({ ssid: "Droplet", key: undefined });
    expect(out).toEqual({ ssid: "Droplet", key: undefined });
    expect(out.key).toBeUndefined();
    expect(redactSecretParams({ psk: null })).toEqual({ psk: null });
  });

  it("covers the other secret-bearing key spellings", () => {
    const out = redactSecretParams({
      encryption_key: "ek",
      psk: "p",
      secret: "s",
      token: "t",
      wpa_passphrase: "w",
      SSID: "not-a-secret",
    });
    expect(out).toEqual({
      encryption_key: REDACTION_PLACEHOLDER,
      psk: REDACTION_PLACEHOLDER,
      secret: REDACTION_PLACEHOLDER,
      token: REDACTION_PLACEHOLDER,
      wpa_passphrase: REDACTION_PLACEHOLDER,
      SSID: "not-a-secret",
    });
  });

  it("keeps a public key / key id (the SAFE_KEY carve-out)", () => {
    const out = redactSecretParams({ public_key: "pk-not-secret", key_id: "kid-7" });
    expect(out).toEqual({ public_key: "pk-not-secret", key_id: "kid-7" });
  });

  it("redacts nested objects and arrays, not just top-level keys", () => {
    const out = redactSecretParams({
      networks: [{ ssid: "a", password: "nested-psk-leak" }],
      wan: { pppoe: { username: "u", password: "deep-psk-leak" } },
    });
    expect(JSON.stringify(out)).not.toContain("nested-psk-leak");
    expect(JSON.stringify(out)).not.toContain("deep-psk-leak");
    expect((out.networks as any[])[0].ssid).toBe("a");
    expect((out.wan as any).pppoe.username).toBe("u");
  });

  it("catches a secret embedded in a value under a harmless key", () => {
    // camera_subnet_setup forwards req.body wholesale — the key name gives
    // no hint, so the text scrub still has to run over string values.
    const out = redactSecretParams({ upstream: "redis://:sup3rsecret@cache:6379" });
    expect(JSON.stringify(out)).not.toContain("sup3rsecret");
  });

  it("does not mutate its input", () => {
    const input = { password: "original-psk" };
    redactSecretParams(input);
    expect(input.password).toBe("original-psk");
  });

  it("terminates on a cyclic object instead of spinning", () => {
    const cyclic: Record<string, unknown> = { ssid: "a" };
    cyclic.self = cyclic;
    expect(() => redactSecretParams(cyclic)).not.toThrow();
  });

  it("redacts a CLASS INSTANCE's secret rather than failing open", () => {
    // JSON.stringify emits an instance's own enumerable properties, so a
    // "not a plain object -> return as-is" bail-out would leak them. Walk it.
    class WifiParams {
      ssid = "Droplet";
      password = "class-instance-psk-leak";
    }
    const out = redactSecretParams(new WifiParams());
    expect(JSON.stringify(out)).not.toContain("class-instance-psk-leak");
    expect((out as any).ssid).toBe("Droplet");
    expect((out as any).password).toBe(REDACTION_PLACEHOLDER);
  });

  it("leaves objects that define their own JSON form intact", () => {
    // A Date has no own enumerable properties — walking it would turn it into
    // {} and destroy the value. toJSON is the signal to leave it alone.
    const when = new Date("2026-08-04T00:00:00.000Z");
    const out = redactSecretParams({ ssid: "Droplet", when });
    expect(JSON.parse(JSON.stringify(out)).when).toBe("2026-08-04T00:00:00.000Z");
  });

  it("a null-prototype object is still walked", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.password = "null-proto-psk-leak";
    expect(JSON.stringify(redactSecretParams(bare))).not.toContain("null-proto-psk-leak");
  });

  it("redacts a secret nested under a sensitive key holding an object", () => {
    const out = redactSecretParams({ credentials: { user: "u", pass: "creds-leak" } });
    expect(JSON.stringify(out)).not.toContain("creds-leak");
  });

  it("passes through undefined / primitives untouched", () => {
    expect(redactSecretParams(undefined)).toBeUndefined();
    expect(redactSecretParams({})).toEqual({});
  });
});

/**
 * WARP-1688 — the richdocuments DIRECT-EDITING token.
 *
 * It is bearer-equivalent for its lifetime: whoever holds the URL opens that
 * file with no cookie and no Authorization header (docs/THREAT_MODEL.md T1.8,
 * accepted risk R6 — "must never be logged, screenshotted into a ticket, or
 * pasted into chat").
 *
 * The credential rides in a URL PATH SEGMENT, which is a shape none of the
 * rules above model: not a Bearer header, not an auth header, not KEY=value,
 * not URI userinfo. It reaches the downloadable log bundle by two routes — the
 * gateway logs `$request` verbatim (no `access_log` directive), and
 * `nextcloud:29-apache` symlinks its Apache access log to stdout while
 * `nextcloud` sits in the collector's DEFAULT_SERVICES. So a bundle pulled
 * during an active editing session would ship live credentials off the box.
 */
describe("redactSecrets — richdocuments direct-editing token (WARP-1688)", () => {
  const ACCESS_LOG =
    '192.168.9.14 - - [09/Aug/2026:21:15:04 +0000] "GET ' +
    "/index.php/apps/richdocuments/direct/pLaNtEdDiReCtToKeN0123456789abcd" +
    ' HTTP/1.1" 200 31842 "-" "Mozilla/5.0"';

  it("removes the token from a realistic Apache/nginx access-log line", () => {
    const out = redactSecrets(ACCESS_LOG);
    expect(out).not.toContain("pLaNtEdDiReCtToKeN0123456789abcd");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("keeps the route visible so the line is still diagnosable", () => {
    const out = redactSecrets(ACCESS_LOG);
    // Redaction, not deletion: an access log with the path scrubbed away is
    // useless for the editor problem these bundles get pulled for.
    expect(out).toContain("/index.php/apps/richdocuments/direct/");
    expect(out).toContain("200 31842");
  });

  it("redacts the pretty-URL route shape too (no /index.php prefix)", () => {
    const out = redactSecrets(
      'GET /apps/richdocuments/direct/pRettyUrlDirectToken9876543210zyxw HTTP/1.1',
    );
    expect(out).not.toContain("pRettyUrlDirectToken9876543210zyxw");
  });

  it("redacts the token when a query string follows it", () => {
    const out = redactSecrets(
      "/index.php/apps/richdocuments/direct/tOkEnWithQuery12345678?requesttoken=abc",
    );
    expect(out).not.toContain("tOkEnWithQuery12345678");
  });

  it("redacts a bare URL with no surrounding log furniture", () => {
    const out = redactSecrets(
      "http://localhost/index.php/apps/richdocuments/direct/bAreUrlToken0987654321",
    );
    expect(out).not.toContain("bAreUrlToken0987654321");
  });

  it("leaves the ordinary richdocuments connector URL alone (no credential in it)", () => {
    const connector = "/nextcloud/index.php/apps/richdocuments/index?fileId=4242";
    expect(redactSecrets(connector)).toBe(connector);
  });

  it("is idempotent — re-running over redacted output changes nothing", () => {
    const once = redactSecrets(ACCESS_LOG);
    expect(redactSecrets(once)).toBe(once);
  });
});
