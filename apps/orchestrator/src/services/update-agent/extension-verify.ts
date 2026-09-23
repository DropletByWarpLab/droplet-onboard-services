/**
 * WARP-2900 (ADR-056 slice H1): verify a signed extension statement.
 *
 * An extension statement (services/extension-manifest.ts) binds a manifest
 * digest to the exact git commit and tree an owner promoted. Two keys may
 * sign one, and the statement's own `kind` decides which are acceptable:
 *
 *   kind "extension" -> the BOX extension key (Node crypto, ECDSA-P256-SHA256
 *                       over EXTENSION_STATEMENT_PREFIX || statement), OR the
 *                       Warp Lab RELEASE key (cosign verify-blob over the raw
 *                       statement, against the baked-in trust anchor);
 *   anything else    -> the release key only. If the box key verifies it the
 *                       answer is key_usage_mismatch, never signature_failed.
 *   no kind          -> extension_kind_missing, before any key is tried.
 *
 * The asymmetry is one-way on purpose (WARP-2900 AC, corrected 2026-09-19):
 * the release key MAY vouch for an extension, the box key may NEVER vouch for
 * a release. The OTA release paths (verify.ts `verifyReleaseSignature` /
 * `verifyAndParseRelease`, app-downloads/store.ts) do not know this module or
 * the box key exists; release-paths-stay-release-only.test.ts pins that.
 *
 * Order, after the signature holds: statement schema (strict) -> the
 * manifest digest (extension_digest_mismatch) -> the manifest schema and its
 * version against the statement (extension_schema_invalid).
 *
 * Single read: the statement and manifest are copied ONCE on entry and only
 * the copies are verified, digested and parsed; the cosign leg reads a
 * private mkdtemp copy. A caller buffer rewritten during the cosign await
 * cannot change what was verified (extension-verify.toctou.test.ts).
 *
 * `recorded` is what the store wrote at sign time (ExtensionVersion.signer +
 * keyFingerprint, WARP-2900 H2). When present, only that signer is tried,
 * and a key that has changed since is extension_key_changed: a rebuilt boot
 * disk loses the mock backend's extension key (it is in no backup set), and
 * the owner must re-promote (docs/security/device-identity.md).
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  extensionKeyFingerprint,
  extensionStatementSchema,
  manifestSha256,
  parseExtensionManifest,
  type ExtensionManifest,
  type ExtensionStatement,
} from "../extension-manifest.js";
import type { UpdateFailureReason } from "./manifest.js";
import { defaultTrustAnchorPath, verifyReleaseSignature } from "./verify.js";

/**
 * Domain separator the sidecar prepends before signing with the box
 * extension key. Mirrors EXTENSION_STATEMENT_PREFIX in
 * services/device-identity-svc/extension_signing.py (drift-tested there and
 * in extension-verify.test.ts). Disjoint from every device-key prefix
 * (cross-protocol.test.ts).
 */
export const EXTENSION_STATEMENT_PREFIX = "droplet-extension-statement:v1:";

export type ExtensionSigner = "box" | "release";

export interface BoxExtensionKey {
  /** SubjectPublicKeyInfo DER, from the sidecar's GetStatus. */
  spkiDer: Uint8Array;
}

export interface VerifyExtensionStatementOptions {
  /** Canonical statement bytes as stored. Copied on entry. */
  statement: Uint8Array;
  /** Base64 DER ECDSA-P256-SHA256 (the cosign sig-file format, both signers). */
  signature: string;
  /** Manifest bytes as stored. Copied on entry. */
  manifest: Uint8Array;
  /** The box extension key now, or null when the sidecar has none. */
  boxKey: BoxExtensionKey | null;
  /** The signer and key fingerprint recorded when the statement was signed. */
  recorded?: { signer: ExtensionSigner; keyFingerprint: string };
  /** Release trust anchor override: tests only. */
  releaseAnchorPath?: string;
  /** cosign binary override: tests only. */
  cosignBin?: string;
}

export type VerifyExtensionResult =
  | {
      ok: true;
      signer: ExtensionSigner;
      /** "sha256:<hex>" over the verifying key's SPKI DER. */
      keyFingerprint: string;
      statement: ExtensionStatement;
      manifest: ExtensionManifest;
      /** The entry-time copies that were verified. */
      statementBytes: Buffer;
      manifestBytes: Buffer;
    }
  | { ok: false; failureReason: UpdateFailureReason; detail: string };

type Refusal = Extract<VerifyExtensionResult, { ok: false }>;

const refuse = (failureReason: UpdateFailureReason, detail: string): Refusal => ({
  ok: false,
  failureReason,
  detail,
});

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeSignature(signature: string): Buffer | null {
  const s = signature.trim();
  if (s.length === 0 || s.length % 4 !== 0 || !BASE64_RE.test(s)) return null;
  return Buffer.from(s, "base64");
}

function p256Key(spkiDer: Uint8Array): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiDer), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec") return null;
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

function ecdsaVerifies(key: KeyObject, data: Buffer, derSig: Buffer): boolean {
  try {
    return cryptoVerify("sha256", data, key, derSig);
  } catch {
    return false;
  }
}

/** "sha256:<hex>" of the release anchor's SPKI, or null if it is no key. */
function anchorFingerprint(anchorPath: string): string | null {
  try {
    const der = createPublicKey(readFileSync(anchorPath)).export({ type: "spki", format: "der" });
    return extensionKeyFingerprint(der);
  } catch {
    return null;
  }
}

/** cosign verify-blob over private copies of the statement and signature. */
async function releaseKeyVerifies(
  statementBytes: Buffer,
  signature: string,
  opts: VerifyExtensionStatementOptions,
): Promise<Refusal | null> {
  const privateDir = mkdtempSync(path.join(tmpdir(), "droplet-ext-verify-"));
  try {
    const blob = path.join(privateDir, "statement.json");
    const sig = path.join(privateDir, "statement.json.sig");
    writeFileSync(blob, statementBytes, { mode: 0o600 });
    writeFileSync(sig, signature.trim(), { mode: 0o600 });
    const res = await verifyReleaseSignature({
      manifestPath: blob,
      signaturePath: sig,
      publicKeyPath: opts.releaseAnchorPath,
      cosignBin: opts.cosignBin,
    });
    return res.ok ? null : refuse(res.failureReason, res.detail);
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
}

export async function verifyExtensionStatement(
  opts: VerifyExtensionStatementOptions,
): Promise<VerifyExtensionResult> {
  // The one read of each input. Buffer.from(Uint8Array) copies.
  const statementBytes = Buffer.from(opts.statement);
  const manifestBytes = Buffer.from(opts.manifest);
  const releaseAnchor = opts.releaseAnchorPath ?? defaultTrustAnchorPath();

  // ── 1. Read `kind` to select keys. Nothing else is trusted yet. ──────
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(statementBytes);
    parsed = JSON.parse(text);
  } catch (err) {
    return refuse("extension_schema_invalid", `statement is not UTF-8 JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("extension_schema_invalid", "statement is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "kind")) {
    return refuse("extension_kind_missing", "statement declares no kind; refusing to pick a key for it");
  }
  // Canonical bytes only: no whitespace variants, no key-order variants, no
  // duplicate keys (JSON.parse keeps the last; the re-encoding then differs).
  if (canonicalJson(record) !== text) {
    return refuse("extension_schema_invalid", "statement is not canonical JSON");
  }

  const derSig = decodeSignature(opts.signature);
  if (derSig === null) return refuse("signature_failed", "signature is not base64");
  const boxKey = opts.boxKey ? p256Key(opts.boxKey.spkiDer) : null;
  const envelope = Buffer.concat([Buffer.from(EXTENSION_STATEMENT_PREFIX, "utf8"), statementBytes]);

  // ── 2. Signature, keys selected by kind. ─────────────────────────────
  let signer: ExtensionSigner;
  let keyFingerprint: string;
  if (record.kind === "extension") {
    const allowed: ExtensionSigner[] = opts.recorded ? [opts.recorded.signer] : ["box", "release"];
    if (opts.recorded?.signer === "box") {
      const now = opts.boxKey ? extensionKeyFingerprint(opts.boxKey.spkiDer) : null;
      if (now !== opts.recorded.keyFingerprint) {
        return refuse(
          "extension_key_changed",
          now === null
            ? "the box holds no extension key; it was signed by one (re-promote after a disk rebuild)"
            : `box extension key is ${now}, the statement was signed by ${opts.recorded.keyFingerprint}; re-promote`,
        );
      }
    }
    if (opts.recorded?.signer === "release") {
      const now = anchorFingerprint(releaseAnchor);
      if (now !== null && now !== opts.recorded.keyFingerprint) {
        return refuse(
          "extension_key_changed",
          `release key is ${now}, the statement was signed by ${opts.recorded.keyFingerprint}`,
        );
      }
    }
    if (allowed.includes("box") && boxKey && ecdsaVerifies(boxKey, envelope, derSig)) {
      signer = "box";
      keyFingerprint = extensionKeyFingerprint(opts.boxKey!.spkiDer);
    } else if (allowed.includes("release")) {
      const refusal = await releaseKeyVerifies(statementBytes, opts.signature, opts);
      if (refusal) return refusal;
      signer = "release";
      keyFingerprint = anchorFingerprint(releaseAnchor) ?? "";
    } else {
      return refuse("signature_failed", "the box extension key did not sign this statement");
    }
  } else {
    // Not an extension statement: the release key is the only acceptable
    // signer. The box key verifying it means a usage mismatch.
    if (boxKey && (ecdsaVerifies(boxKey, envelope, derSig) || ecdsaVerifies(boxKey, statementBytes, derSig))) {
      return refuse(
        "key_usage_mismatch",
        `the box extension key signed a statement of kind ${JSON.stringify(record.kind)}; it may only sign kind "extension"`,
      );
    }
    const refusal = await releaseKeyVerifies(statementBytes, opts.signature, opts);
    if (refusal) return refusal;
    signer = "release";
    keyFingerprint = anchorFingerprint(releaseAnchor) ?? "";
  }

  // ── 3. The statement, the digest, the manifest. ──────────────────────
  const statement = extensionStatementSchema.safeParse(record);
  if (!statement.success) {
    return refuse(
      "extension_schema_invalid",
      `not an extension statement: ${statement.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const digest = manifestSha256(manifestBytes);
  if (digest !== statement.data.manifestSha256) {
    return refuse(
      "extension_digest_mismatch",
      `manifest sha256 is ${digest}, the signed statement names ${statement.data.manifestSha256}`,
    );
  }
  const manifest = parseExtensionManifest(manifestBytes);
  if (!manifest.ok) return refuse("extension_schema_invalid", `manifest: ${manifest.detail}`);
  if (manifest.manifest.version !== statement.data.version) {
    return refuse(
      "extension_schema_invalid",
      `manifest version ${manifest.manifest.version} differs from the signed version ${statement.data.version}`,
    );
  }

  return {
    ok: true,
    signer,
    keyFingerprint,
    statement: statement.data,
    manifest: manifest.manifest,
    statementBytes,
    manifestBytes,
  };
}
