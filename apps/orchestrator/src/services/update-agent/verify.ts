/**
 * WARP-537 — OTA release-manifest signature verification.
 *
 * First gate in the OTA trust chain: prove `release.json` was signed by
 * the Droplet release key before a single byte of it is interpreted.
 * Verification execs the vendored `cosign verify-blob` binary (pinned +
 * checksum-verified in apps/orchestrator/Dockerfile) against the
 * baked-in trust anchor `./cosign.pub` — the same envelope the publish
 * workflow produces with `cosign sign-blob --tlog-upload=false`
 * (.github/workflows/publish-release.yml). `--insecure-ignore-tlog=true`
 * on the verify side is the documented pairing for offline key-based
 * verification of private releases: there is no Rekor entry to check,
 * the public key IS the trust root.
 *
 * Fail-closed posture (every path that isn't a positive verification is
 * a refusal, each with its own canonical failureReason):
 *   - `trust_anchor_placeholder` — the shipped cosign.pub is still the
 *     WARP-535 placeholder (or missing/not a PEM public key). No key
 *     ceremony → no OTA, ever. Checked BEFORE any cosign spawn.
 *   - `cosign_unavailable`      — the binary can't be exec'd. Distinct
 *     from a bad signature so operators can tell "broken image" from
 *     "attack/corruption".
 *   - `signature_failed`        — cosign ran and said no. Covers both
 *     tampered bytes and wrong-key signatures (cryptographically
 *     indistinguishable from the outside).
 *
 * Binary resolution: `DROPLET_COSIGN_BIN` env → `cosign` on PATH. The
 * orchestrator image vendors it at /usr/local/bin/cosign, so the default
 * resolves in-container; dev machines install cosign or set the env.
 * The TRUST ANCHOR path is deliberately NOT env-overridable — tests
 * inject it per-call, production always uses the baked-in file.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseReleaseManifest,
  type ReleaseManifest,
  type UpdateFailureReason,
} from "./manifest.js";

/**
 * Marker string in the WARP-535 placeholder cosign.pub. Its presence —
 * or the absence of a PEM PUBLIC KEY block — means the key ceremony has
 * not run and verification must refuse everything.
 */
export const TRUST_ANCHOR_PLACEHOLDER_MARKER = "DROPLET-OTA-PLACEHOLDER";

export type SignatureFailureReason = Extract<
  UpdateFailureReason,
  "trust_anchor_placeholder" | "cosign_unavailable" | "signature_failed"
>;

export type VerifySignatureResult =
  | { ok: true }
  | { ok: false; failureReason: SignatureFailureReason; detail: string };

export type VerifyAndParseResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; failureReason: UpdateFailureReason; detail: string };

export interface VerifyReleaseOptions {
  /** Path to the release.json bytes exactly as downloaded. */
  manifestPath: string;
  /** Path to the detached cosign signature (release.json.sig). */
  signaturePath: string;
  /**
   * Trust anchor override — tests only. Production callers omit it and
   * get the baked-in cosign.pub.
   */
  publicKeyPath?: string;
  /**
   * Cosign binary override — tests only. Production resolution is
   * DROPLET_COSIGN_BIN env → `cosign` on PATH (vendored in the image).
   */
  cosignBin?: string;
}

/**
 * Canonical location of the baked-in trust anchor.
 *
 * Two candidates, first hit wins:
 *   1. next to this module — in dev/vitest the source tree has
 *      src/services/update-agent/cosign.pub right here;
 *   2. `<cwd>/src/services/update-agent/cosign.pub` — in the container
 *      this module runs from dist/, and the Dockerfile ships the .pub at
 *      the src/ path under WORKDIR /app/apps/orchestrator (see the
 *      WARP-535 COPY + scripts/test-security.sh assertion).
 */
export function defaultTrustAnchorPath(): string {
  // CJS build: __dirname is dist/services/update-agent in the container,
  // src/services/update-agent in dev/vitest (vite shims __dirname).
  const moduleLocal = path.resolve(__dirname, "cosign.pub");
  if (existsSync(moduleLocal)) return moduleLocal;
  return path.resolve(process.cwd(), "src/services/update-agent/cosign.pub");
}

function resolveCosignBin(override?: string): string {
  return override ?? process.env.DROPLET_COSIGN_BIN ?? "cosign";
}

/**
 * Trust-anchor gate. Returns null when the anchor is a real PEM public
 * key; otherwise the fail-closed refusal.
 */
function checkTrustAnchor(publicKeyPath: string): VerifySignatureResult | null {
  let content: string;
  try {
    content = readFileSync(publicKeyPath, "utf8");
  } catch {
    return {
      ok: false,
      failureReason: "trust_anchor_placeholder",
      detail: `trust anchor missing at ${publicKeyPath} — the orchestrator image must bake in cosign.pub (WARP-535); refusing to verify anything`,
    };
  }
  if (content.includes(TRUST_ANCHOR_PLACEHOLDER_MARKER)) {
    return {
      ok: false,
      failureReason: "trust_anchor_placeholder",
      detail:
        "cosign.pub is the WARP-535 placeholder — run the key ceremony (scripts/README.md, \"OTA release signing\") before any OTA release can verify",
    };
  }
  if (!content.includes("-----BEGIN PUBLIC KEY-----")) {
    return {
      ok: false,
      failureReason: "trust_anchor_placeholder",
      detail: `trust anchor at ${publicKeyPath} is not a PEM public key — refusing to verify`,
    };
  }
  return null;
}

/**
 * Verify the detached cosign signature over the manifest bytes. Spawns
 * `cosign verify-blob`; never interprets the manifest content.
 */
export async function verifyReleaseSignature(
  opts: VerifyReleaseOptions,
): Promise<VerifySignatureResult> {
  const publicKeyPath = opts.publicKeyPath ?? defaultTrustAnchorPath();

  const anchorRefusal = checkTrustAnchor(publicKeyPath);
  if (anchorRefusal) return anchorRefusal;

  const bin = resolveCosignBin(opts.cosignBin);
  const args = [
    "verify-blob",
    "--key",
    publicKeyPath,
    "--signature",
    opts.signaturePath,
    // Private releases signed with --tlog-upload=false have no Rekor
    // entry; offline key-based verification is the design (WARP-536).
    "--insecure-ignore-tlog=true",
    opts.manifestPath,
  ];

  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ ok: true });
        return;
      }
      const spawnFailure =
        (err as NodeJS.ErrnoException).code === "ENOENT" ||
        (err as NodeJS.ErrnoException).code === "EACCES";
      if (spawnFailure) {
        resolve({
          ok: false,
          failureReason: "cosign_unavailable",
          detail: `could not exec cosign at ${bin!} (${(err as NodeJS.ErrnoException).code}) — the orchestrator image vendors it at /usr/local/bin/cosign; set DROPLET_COSIGN_BIN in dev`,
        });
        return;
      }
      resolve({
        ok: false,
        failureReason: "signature_failed",
        detail: `cosign verify-blob rejected the signature: ${stderr.trim() || err.message}`,
      });
    });
  });
}

/**
 * The full WARP-537 trust chain: trust anchor → signature → parse/schema.
 * Only signature-verified bytes ever reach the parser; the returned
 * manifest is safe to act on (WARP-538 poller / WARP-539 apply).
 */
export async function verifyAndParseRelease(
  opts: VerifyReleaseOptions,
): Promise<VerifyAndParseResult> {
  const sig = await verifyReleaseSignature(opts);
  if (!sig.ok) return sig;

  let raw: Buffer;
  try {
    raw = readFileSync(opts.manifestPath);
  } catch (err) {
    return {
      ok: false,
      failureReason: "malformed_manifest",
      detail: `could not read manifest at ${opts.manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return parseReleaseManifest(raw);
}
