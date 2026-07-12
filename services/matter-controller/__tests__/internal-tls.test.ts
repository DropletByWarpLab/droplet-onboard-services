/**
 * WARP-1061 — server-side internal-mTLS helper for the :8083 listener.
 * Mirrors apps/orchestrator/src/lib/internal-tls.test.ts (trimmed to the
 * server half this sidecar carries).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshModule(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("../src/internal-tls.js");
  mod.resetInternalTlsForTests();
  return mod;
}

function makePems(dir: string): { cert: string; key: string; ca: string } {
  // httpsServerOptions only READS the files into Buffers — no TLS handshake
  // happens in this test, so placeholder bytes are sufficient.
  for (const name of ["cert.pem", "key.pem", "ca.pem"]) {
    writeFileSync(join(dir, name), `PEM:${name}`);
  }
  return {
    cert: join(dir, "cert.pem"),
    key: join(dir, "key.pem"),
    ca: join(dir, "ca.pem"),
  };
}

describe("matter-controller internal-tls", () => {
  afterEach(() => {
    delete process.env.DROPLET_INTERNAL_TLS;
    delete process.env.DROPLET_TLS_CERT;
    delete process.env.DROPLET_TLS_KEY;
    delete process.env.DROPLET_TLS_CA;
  });

  it("is disabled by default (flag unset ⇒ plain HTTP listener)", async () => {
    const mod = await freshModule({ DROPLET_INTERNAL_TLS: undefined });
    expect(mod.internalTlsEnabled()).toBe(false);
  });

  it("is disabled on an explicit 0", async () => {
    const mod = await freshModule({ DROPLET_INTERNAL_TLS: "0" });
    expect(mod.internalTlsEnabled()).toBe(false);
  });

  it("serves the bundle and REQUIRES a CA-signed client cert when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-itls-"));
    const p = makePems(dir);
    const mod = await freshModule({
      DROPLET_INTERNAL_TLS: "1",
      DROPLET_TLS_CERT: p.cert,
      DROPLET_TLS_KEY: p.key,
      DROPLET_TLS_CA: p.ca,
    });
    expect(mod.internalTlsEnabled()).toBe(true);
    const opts = mod.httpsServerOptions();
    expect(opts.requestCert).toBe(true);
    expect(opts.rejectUnauthorized).toBe(true);
    expect(Buffer.isBuffer(opts.cert)).toBe(true);
    expect((opts.cert as Buffer).toString()).toBe("PEM:cert.pem");
    expect((opts.key as Buffer).toString()).toBe("PEM:key.pem");
    expect((opts.ca as Buffer).toString()).toBe("PEM:ca.pem");
  });
});
