import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts reads env at import time in this codebase, so mutate process.env
// BEFORE dynamic import and reset module state between cases.
async function freshModule(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("./internal-tls.js");
  mod.resetInternalTlsForTests();
  return mod;
}

function makePems(dir: string): { cert: string; key: string; ca: string } {
  // Self-signed throwaway pair via openssl (present on macOS + CI Linux).
  execSync(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-keyout ${dir}/key.pem -out ${dir}/cert.pem -days 1 -nodes -subj "/CN=test"`,
    { stdio: "ignore" }
  );
  writeFileSync(join(dir, "ca.pem"), "");
  execSync(`cp ${dir}/cert.pem ${dir}/ca.pem`);
  return { cert: `${dir}/cert.pem`, key: `${dir}/key.pem`, ca: `${dir}/ca.pem` };
}

describe("internal-tls", () => {
  afterEach(() => {
    delete process.env.DROPLET_INTERNAL_TLS;
  });

  it("is a no-op when disabled", async () => {
    const mod = await freshModule({ DROPLET_INTERNAL_TLS: "0" });
    expect(mod.internalTlsEnabled()).toBe(false);
    expect(mod.internalDispatcher()).toBeUndefined();
    expect(mod.internalBaseUrl("http://ai-gateway:8000")).toBe("http://ai-gateway:8000");
  });

  it("returns TLS material for mqtts:// URLs and {} for mqtt:// (WARP-235)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "itls-mqtt-"));
    const p = makePems(dir);
    const mod = await freshModule({
      DROPLET_INTERNAL_TLS: "0", // deliberately off — the URL scheme is the gate
      DROPLET_TLS_CERT: p.cert,
      DROPLET_TLS_KEY: p.key,
      DROPLET_TLS_CA: p.ca,
    });
    expect(mod.mqttConnectOptions("mqtt://localhost:1883")).toEqual({});
    const opts = mod.mqttConnectOptions("mqtts://broker:8883");
    expect(opts.rejectUnauthorized).toBe(true);
    expect(Buffer.isBuffer(opts.cert)).toBe(true);
    expect(Buffer.isBuffer(opts.key)).toBe(true);
    expect(Buffer.isBuffer(opts.ca)).toBe(true);
  });

  it("loads material, builds server options and rewrites schemes when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "itls-"));
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
    expect(mod.internalDispatcher()).toBeDefined();
    expect(mod.internalBaseUrl("http://ai-gateway:8000/ai")).toBe("https://ai-gateway:8000/ai");
    expect(mod.internalBaseUrl("https://already")).toBe("https://already");
  });
});
