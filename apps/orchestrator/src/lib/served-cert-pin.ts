/**
 * WARP-2954 / ADR-058 — the served certificate's key fingerprint, for the
 * pairing link.
 *
 * A client can only pair to a box whose certificate it can verify. The
 * public-CA path (ADR-023) needs HQ; a box that never went through HQ — every
 * box, on the customer's terms — serves its own self-signed bootstrap
 * certificate, whose KEY is stable for the life of the install. What a client
 * lacks is an authenticated way to learn WHICH key is this box's. The pairing
 * link the box mints (`droplet://pair?server=…&code=…`) is that way: it is
 * shown by the box's own dashboard to a logged-in owner, so a host on the LAN
 * cannot rewrite it. Carrying `spki=<pin>` in it lets the client accept
 * exactly this key for this host, with no CA, no HQ, no renewal, and nothing
 * installed in the client's OS trust store (droplet-windows WARP-2953).
 *
 * The pin is the standard SPKI pin: base64 of SHA-256 over the DER
 * SubjectPublicKeyInfo of the FIRST certificate in `docker/certs/droplet.crt`
 * (the leaf — the LE fullchain writes the leaf first, and the bootstrap file
 * holds only the leaf). Byte-identical to
 *   openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER \
 *     | openssl dgst -sha256 -binary | base64
 * and to the Windows app's `discovery::spki_sha256_b64`, so every side
 * computes the same value. It is PUBLIC data — any TLS client sees the
 * certificate — but the CHANNEL it travels through is what makes it an
 * anchor, which is why it rides only the owner-authenticated pairing link and
 * not the unauthenticated `GET /api/tls/status`.
 *
 * Cached by the file's mtime: a cert swap (tls-issuance install, tls-reload)
 * changes the mtime and the next mint recomputes. A box whose key changed
 * therefore mints a new pin, and a client holding the old one is told
 * "identity changed — scan again", never silently re-trusted.
 */
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** docker/certs lives at the repo root; the orchestrator container mounts it
 *  at /app/docker/certs (docker-compose.yml). Same default as tls-issuance. */
const DEFAULT_CERTS_DIR = process.env.DROPLET_CERTS_DIR || "/app/docker/certs";
const LEAF_FILE = "droplet.crt";

/**
 * The SPKI-SHA256 pin (base64) of the first certificate in `pem`.
 * Throws on a PEM that carries no parseable certificate — the caller
 * decides whether a mint without a pin is acceptable.
 */
export function spkiSha256Base64FromPem(pem: string): string {
  // node:crypto rather than node-forge: forge reads RSA keys only, and a
  // pin must be computable for whatever key the box serves (the bootstrap
  // cert is RSA-2048 today; an issuer or a future leaf may be EC).
  const cert = new X509Certificate(firstCertificateBlock(pem));
  const spkiDer = cert.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spkiDer).digest("base64");
}

/** The first `-----BEGIN CERTIFICATE-----` block of a PEM bundle, verbatim. */
function firstCertificateBlock(pem: string): string {
  const begin = pem.indexOf("-----BEGIN CERTIFICATE-----");
  if (begin < 0) throw new Error("no certificate block in PEM");
  const end = pem.indexOf("-----END CERTIFICATE-----", begin);
  if (end < 0) throw new Error("unterminated certificate block in PEM");
  return pem.slice(begin, end + "-----END CERTIFICATE-----".length) + "\n";
}

interface CachedPin {
  path: string;
  mtimeMs: number;
  pin: string;
}
let cache: CachedPin | null = null;

/**
 * The pin of the certificate the gateway is serving right now, or `null`
 * when the leaf is missing/unreadable (a mint then carries no `spki=`; the
 * client falls back to what it could do before this existed). Never throws
 * — pairing must keep working on a box whose certs dir is momentarily odd.
 */
export function servedCertPin(certsDir: string = DEFAULT_CERTS_DIR): string | null {
  const path = join(certsDir, LEAF_FILE);
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.pin;
    const pin = spkiSha256Base64FromPem(readFileSync(path, "utf8"));
    cache = { path, mtimeMs, pin };
    return pin;
  } catch {
    return null;
  }
}

/** Test hook: drop the mtime cache. */
export function _resetServedCertPinCacheForTests(): void {
  cache = null;
}

/**
 * The pairing deep link. `spki` is appended only when a pin is known, so a
 * box without a readable leaf mints exactly the link it minted before.
 * `code` is validated upstream (the generated pairing code); `server` is
 * the trusted-origin URL (never a raw request header — PR #486).
 */
export function buildPairUrl(server: string, code: string, pin: string | null): string {
  const base = `droplet://pair?server=${encodeURIComponent(server)}&code=${code}`;
  return pin ? `${base}&spki=${encodeURIComponent(pin)}` : base;
}
