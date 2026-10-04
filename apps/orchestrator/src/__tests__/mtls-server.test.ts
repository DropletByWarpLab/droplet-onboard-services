import { describe, expect, it, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
// Use undici's own fetch with its own Agent so the dispatcher is version-matched
// (the appliance runs Node 20; a dev machine may run a newer Node whose bundled
// global fetch rejects a v6 dispatcher).
import { Agent, fetch } from "undici";

// The macOS default /usr/bin/openssl is LibreSSL, which emits EC keys with
// EXPLICIT curve params (Node's TLS rejects them) and lacks `x509 -ext`. Prefer
// a real OpenSSL 3 (named-curve keys) when present; CI Linux ships OpenSSL 3 as
// the default `openssl`.
const OPENSSL =
  process.env.INTERNAL_CA_OPENSSL ??
  ["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"].find(
    (p) => existsSync(p)
  ) ??
  "openssl";

// Mint a scratch CA + a server bundle + a client bundle with openssl.
function mint(dir: string, cn: string): void {
  execSync(
    `${OPENSSL} req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 ` +
      `-keyout ${dir}/${cn}.key -subj "/CN=${cn}" -out ${dir}/${cn}.csr && ` +
      `${OPENSSL} x509 -req -in ${dir}/${cn}.csr -CA ${dir}/ca.pem -CAkey ${dir}/ca.key ` +
      `-CAcreateserial -days 1 -sha256 -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1\\nextendedKeyUsage=serverAuth,clientAuth") ` +
      `-out ${dir}/${cn}.pem`,
    { stdio: "ignore", shell: "/bin/bash" }
  );
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mtls-"));
  execSync(
    `${OPENSSL} req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 ` +
      `-keyout ${dir}/ca.key -out ${dir}/ca.pem -days 1 -subj "/CN=test-ca" ` +
      `-addext "basicConstraints=critical,CA:TRUE"`,
    { stdio: "ignore" }
  );
  mint(dir, "server");
  mint(dir, "client");
});

describe("orchestrator mTLS listener", () => {
  it("accepts a CA-signed client cert and rejects certless connections", async () => {
    process.env.DROPLET_INTERNAL_TLS = "1";
    process.env.DROPLET_TLS_CERT = `${dir}/server.pem`;
    process.env.DROPLET_TLS_KEY = `${dir}/server.key`;
    process.env.DROPLET_TLS_CA = `${dir}/ca.pem`;
    const { httpsServerOptions, resetInternalTlsForTests } = await import("../lib/internal-tls.js");
    resetInternalTlsForTests();

    const server = createServer(httpsServerOptions(), (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    // With client cert: 200.
    const okAgent = new Agent({
      connect: {
        cert: execSync(`cat ${dir}/client.pem`),
        key: execSync(`cat ${dir}/client.key`),
        ca: execSync(`cat ${dir}/ca.pem`),
      },
    });
    const res = await fetch(`https://localhost:${port}/`, { dispatcher: okAgent });
    expect(res.status).toBe(200);

    // Without client cert: TLS handshake failure.
    const bareAgent = new Agent({ connect: { ca: execSync(`cat ${dir}/ca.pem`) } });
    await expect(
      fetch(`https://localhost:${port}/`, { dispatcher: bareAgent })
    ).rejects.toThrow();

    await new Promise<void>((r) => server.close(() => r()));
  });
});
