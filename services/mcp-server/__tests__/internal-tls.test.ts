import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// See apps/orchestrator/src/lib/internal-tls.test.ts — same contract, separate
// workspace copy. LibreSSL (macOS default) emits explicit-curve EC keys +
// lacks `x509 -ext`, so prefer a real OpenSSL 3 when present.
const OPENSSL =
  process.env.INTERNAL_CA_OPENSSL ??
  ["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"].find(
    (p) => existsSync(p)
  ) ??
  "openssl";

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
  execSync(
    `${OPENSSL} req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 ` +
      `-keyout ${dir}/key.pem -out ${dir}/cert.pem -days 1 -nodes -subj "/CN=test"`,
    { stdio: "ignore" }
  );
  execSync(`cp ${dir}/cert.pem ${dir}/ca.pem`);
  return { cert: `${dir}/cert.pem`, key: `${dir}/key.pem`, ca: `${dir}/ca.pem` };
}

describe("mcp-server internal-tls", () => {
  afterEach(() => {
    delete process.env.DROPLET_INTERNAL_TLS;
  });

  it("is a no-op when disabled", async () => {
    const mod = await freshModule({ DROPLET_INTERNAL_TLS: "0" });
    expect(mod.internalTlsEnabled()).toBe(false);
    expect(mod.internalDispatcher()).toBeUndefined();
    expect(mod.internalBaseUrl("http://orchestrator:3000")).toBe("http://orchestrator:3000");
  });

  it("builds a client-cert dispatcher and rewrites schemes when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-itls-"));
    const p = makePems(dir);
    const mod = await freshModule({
      DROPLET_INTERNAL_TLS: "1",
      DROPLET_TLS_CERT: p.cert,
      DROPLET_TLS_KEY: p.key,
      DROPLET_TLS_CA: p.ca,
    });
    expect(mod.internalTlsEnabled()).toBe(true);
    expect(mod.internalDispatcher()).toBeDefined();
    expect(mod.internalBaseUrl("http://orchestrator:3000/api")).toBe(
      "https://orchestrator:3000/api"
    );
    expect(mod.internalBaseUrl("https://already")).toBe("https://already");
  });
});
