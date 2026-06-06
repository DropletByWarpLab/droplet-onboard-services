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
import { redactSecrets, REDACTION_PLACEHOLDER } from "./log-redaction.js";

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
