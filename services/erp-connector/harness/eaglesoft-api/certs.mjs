/**
 * Dummy Eaglesoft REST API — throwaway TLS material.
 *
 * A real Eaglesoft box serves HTTPS with a certificate chaining to Patterson's
 * private CA (**PdcoTechCA**), which the connector trusts by way of an injected
 * undici `dispatcher` built from a resolved CA cert — it NEVER disables
 * certificate verification. To test that path honestly the harness needs a real
 * private CA of its own, so this generates one: a self-signed root plus a
 * server certificate signed by it.
 *
 * The point is that verification stays ON. A test can therefore prove both
 * halves: trusting the harness CA connects, and NOT trusting it fails. That is
 * only meaningful because these are genuine, verifiable certificates.
 *
 * Keys are generated at run time into a gitignored directory and are never
 * committed — a checked-in private key is a checked-in private key even when
 * it is "only for tests".
 *
 * Requires the `openssl` CLI (Node has no X.509 signing API). Present on the
 * GitHub runners, in the harness image, and on any dev box with git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default output directory (gitignored — see .gitignore in this folder). */
export const DEFAULT_CERT_DIR = join(HERE, ".certs");

/** How long the generated material is valid. Short on purpose: this is
 *  throwaway material for a mock, and a stale cert should fail loudly rather
 *  than quietly linger for a year. */
const VALIDITY_DAYS = 30;

/** Subject CN of the harness root. Named to make it obvious in any error
 *  message that this is the MOCK CA, not Patterson's real PdcoTechCA. */
const CA_SUBJECT = "/CN=Droplet Eaglesoft Harness Mock CA/O=Droplet Test Harness";

function openssl(args, opts = {}) {
  return execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** True when the `openssl` CLI is callable. */
export function opensslAvailable() {
  try {
    openssl(["version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate (or reuse) a CA + server certificate for the dummy box.
 *
 * Idempotent: if all three files already exist in `dir` and the server
 * certificate has not expired, they are reused — so repeated test runs and
 * container restarts do not re-key. Pass `force` to regenerate.
 *
 * `hosts` become subjectAltNames. The defaults cover both ways the harness is
 * reached: `localhost`/`127.0.0.1` for an in-process or port-mapped run, and
 * `eaglesoft-mock-api` for the compose service name on the harness network.
 *
 * @returns {{ caCertPath: string, certPath: string, keyPath: string, ca: string, cert: string, key: string }}
 */
export function ensureCerts({
  dir = DEFAULT_CERT_DIR,
  hosts = ["localhost", "eaglesoft-mock-api"],
  ips = ["127.0.0.1", "::1"],
  force = false,
} = {}) {
  const caCertPath = join(dir, "harness-ca.crt");
  const caKeyPath = join(dir, "harness-ca.key");
  const certPath = join(dir, "server.crt");
  const keyPath = join(dir, "server.key");

  if (force) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const haveAll = [caCertPath, caKeyPath, certPath, keyPath].every((p) => existsSync(p));
  if (!haveAll || !certStillValid(certPath)) {
    if (!opensslAvailable()) {
      throw new Error(
        "the Eaglesoft API harness needs the `openssl` CLI to generate its throwaway TLS material " +
          "(Node has no X.509 signing API). Install openssl, or run the harness via its Dockerfile.",
      );
    }
    generate({ dir, caCertPath, caKeyPath, certPath, keyPath, hosts, ips });
  }

  return {
    caCertPath,
    certPath,
    keyPath,
    ca: readFileSync(caCertPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
  };
}

/** True when `certPath` parses and has not passed its notAfter. */
function certStillValid(certPath) {
  try {
    openssl(["x509", "-in", certPath, "-checkend", "0", "-noout"]);
    return true;
  } catch {
    return false;
  }
}

function generate({ dir, caCertPath, caKeyPath, certPath, keyPath, hosts, ips }) {
  const days = String(VALIDITY_DAYS);

  // 1. Self-signed root CA.
  openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-days", days,
    "-keyout", caKeyPath,
    "-out", caCertPath,
    "-subj", CA_SUBJECT,
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);

  // 2. Server key + CSR.
  const csrPath = join(dir, "server.csr");
  openssl([
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", csrPath,
    "-subj", `/CN=${hosts[0]}/O=Droplet Test Harness`,
  ]);

  // 3. Sign it, carrying the SANs the harness is actually reached by. A cert
  //    without a matching SAN fails verification in Node — the same way it
  //    would against a real box, which is the behaviour we want to preserve.
  const san = [
    ...hosts.map((h) => `DNS:${h}`),
    ...ips.map((i) => `IP:${i}`),
  ].join(",");
  const extPath = join(dir, "server.ext");
  writeFileSync(
    extPath,
    [
      `subjectAltName=${san}`,
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
  );
  openssl([
    "x509", "-req", "-sha256", "-days", days,
    "-in", csrPath,
    "-CA", caCertPath, "-CAkey", caKeyPath, "-CAcreateserial",
    "-extfile", extPath,
    "-out", certPath,
  ]);

  rmSync(csrPath, { force: true });
  rmSync(extPath, { force: true });
}
