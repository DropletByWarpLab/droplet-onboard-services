/**
 * WARP-456 — HMAC signing helper for ActivityRow.
 *
 * Holds the device's audit signing key in memory and produces base64-url
 * HMAC-SHA256 signatures over the canonical-JSON serialization of a row's
 * content + the prevSignatureHash of the row immediately before it.
 *
 * Pluggable for TPM later: the public surface is `ActivityRowSigner`,
 * which is what callers depend on. `createHmacSigner` is one concrete
 * implementation; a future `createTpmSigner` will satisfy the same
 * interface and slot into `activity.service.ts` without code churn.
 *
 * Key on disk lives at `/data/secrets/audit.key`, mode 0600, owned by
 * the orchestrator service user. Generated first-boot by
 * `scripts/lib/secrets.sh::sync_audit_signing_key`. The helper's
 * `loadAuditKeyFromDisk()` reads it; in tests / dev environments
 * (`AUDIT_SIGNING_KEY` env var present) it picks up from env so the
 * orchestrator boots without writing to a fixed disk path.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

/** Lucide-icon name (or another agreed display token). */
export type ActivitySourceIcon = string;

export type ActivityKindName =
  | "chat"
  | "tool_call"
  | "file"
  | "camera"
  | "network"
  | "smart_home"
  | "email"
  | "auth"
  | "tool_run"
  | "system";

export type ActivitySeverityName = "ok" | "warn" | "err" | "info";

/**
 * Subset of an ActivityRow that the signature actually covers. The
 * database `id` is intentionally excluded so signatures remain stable
 * even if the row's primary key is renumbered (e.g. by a restore).
 */
export interface ActivityRowContent {
  at: Date;
  severity: ActivitySeverityName;
  sourceIcon: ActivitySourceIcon;
  what: string;
  sub: string | null;
  kind: ActivityKindName;
  refs: Record<string, unknown> | null;
}

/**
 * Minimum bytes required to construct a signer. HMAC-SHA256 truncates
 * keys larger than 64 bytes and pads keys smaller than 32 bytes — the
 * usable security floor matches the 32-byte minimum.
 *
 * Mirrors the existing 32-byte minima we already enforce on
 * `JWT_SECRET` and the service-token files.
 */
const MIN_KEY_BYTES = 32;

/** Pluggable signer abstraction so `activity.service.ts` doesn't care
 * whether the key lives in memory, on disk, or inside a TPM. */
export interface ActivityRowSigner {
  sign(content: ActivityRowContent, prevSignatureHash: string): string;
  verify(
    content: ActivityRowContent,
    prevSignatureHash: string,
    signature: string,
  ): boolean;
  /**
   * Public verification bytes the export bundle should ship alongside
   * the rows so an offline tool can re-derive every row's signature.
   * For the HMAC implementation this IS the key itself — symmetric, so
   * holders of these bytes can also forge. That's documented in the
   * spec; the TPM implementation will return the device's
   * attestation-rooted public key here instead.
   */
  exportPublicBytes(): Buffer;
}

/**
 * Canonicalize a row's content into a single string the HMAC runs over.
 *
 * The canonical form is JSON with:
 *   - keys sorted lexicographically at every depth
 *   - timestamps emitted as full ISO-8601 (`Date.toISOString()`)
 *   - `sub` and `refs` explicitly serialized as `null` when absent
 *
 * This shape is stable across orchestrator versions, JS engines, and
 * platforms — anything an offline verifier can re-derive given the row's
 * column values alone.
 */
export function canonicalizeRowContent(content: ActivityRowContent): string {
  const ordered = {
    at: content.at.toISOString(),
    kind: content.kind,
    refs: content.refs === undefined ? null : sortValue(content.refs),
    severity: content.severity,
    sourceIcon: content.sourceIcon,
    sub: content.sub === undefined ? null : content.sub,
    what: content.what,
  };
  return JSON.stringify(ordered);
}

/**
 * Recursively sort object keys lexicographically. Arrays preserve
 * order (positional semantics). Primitives pass through. Used by
 * `canonicalizeRowContent` to stabilize the `refs` payload regardless
 * of insertion order on the emitter side.
 */
function sortValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortValue);
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = sortValue(obj[k]);
  }
  return out;
}

/**
 * Base64-url SHA-256 of an input string. Used to compute
 * `prevSignatureHash` from the previous row's `signature` — the spec
 * calls for hashing the prior signature so the chain is one fixed-size
 * field regardless of HMAC output length.
 */
export function hashSignature(signature: string): string {
  return createHash("sha256").update(signature, "utf8").digest("base64url");
}

/**
 * Construct an in-memory HMAC-SHA256 signer.
 *
 * @throws if `keyBytes.length < MIN_KEY_BYTES`. Anything shorter would
 *   degrade the chain's tamper-evidence below the spec's intent.
 */
export function createHmacSigner(keyBytes: Buffer): ActivityRowSigner {
  if (keyBytes.length < MIN_KEY_BYTES) {
    throw new Error(
      `audit signing key must be at least ${MIN_KEY_BYTES} bytes (got ${keyBytes.length})`,
    );
  }

  return {
    sign(content, prevSignatureHash) {
      const canonical = canonicalizeRowContent(content);
      const hmac = createHmac("sha256", keyBytes);
      hmac.update(canonical, "utf8");
      // The literal `|` separator can't appear in either side — canonical
      // is JSON (so any literal `|` is escaped) and prevSignatureHash is
      // base64-url which only uses [A-Za-z0-9_-]. No prefix-extension
      // attack is reachable.
      hmac.update("|", "utf8");
      hmac.update(prevSignatureHash, "utf8");
      return hmac.digest("base64url");
    },
    verify(content, prevSignatureHash, signature) {
      const expected = this.sign(content, prevSignatureHash);
      // timingSafeEqual requires same-length buffers. A length-mismatched
      // signature is by construction not a match — bail before the
      // constant-time compare.
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },
    exportPublicBytes() {
      // Symmetric: today the "public" bytes ARE the HMAC key. The export
      // bundle is meant for the device owner — they already trust the
      // box. A TPM-backed implementation will return an attestation key
      // here that's verifiable without leaking signing capability.
      return Buffer.from(keyBytes);
    },
  };
}

/**
 * Canonical on-disk path. The setup script writes this file at mode
 * 0600 owned by the orchestrator service user; bind-mounted into the
 * container at the same path so the loader code is identical in dev
 * and prod.
 */
export const AUDIT_KEY_PATH = "/data/secrets/audit.key";

/**
 * Load the audit signing key.
 *
 * Resolution order:
 *   1. `AUDIT_SIGNING_KEY` env var (base64) — used in tests / CI / dev
 *      hosts that don't have `/data` mounted. Mirrors how `JWT_SECRET`
 *      is provided.
 *   2. File at `AUDIT_KEY_PATH` (binary bytes). The setup script
 *      generates it on first boot.
 *
 * Throws if neither source is available — the orchestrator must fail
 * to start rather than emit unsigned activity rows.
 */
export function loadAuditKeyFromDisk(
  diskPath: string = AUDIT_KEY_PATH,
): Buffer {
  const envKey = process.env.AUDIT_SIGNING_KEY;
  if (envKey && envKey.length > 0) {
    return Buffer.from(envKey, "base64");
  }
  if (!fs.existsSync(diskPath)) {
    throw new Error(
      `audit signing key not found: set AUDIT_SIGNING_KEY env var or write ${diskPath} (mode 0600) via scripts/setup.sh`,
    );
  }
  // Read raw bytes — the secrets.sh helper writes binary, not base64.
  return fs.readFileSync(diskPath);
}

/**
 * Single process-wide signer instance. Lazy so tests that construct
 * their own ephemeral signer don't have to mock the disk path.
 *
 * Resets are NOT exposed — once the orchestrator picks a key it stays
 * with it for the process lifetime. Key rotation is a future ticket;
 * the verification path can pick up additional public keys without
 * needing a hot-swap on this side.
 */
let cachedSigner: ActivityRowSigner | null = null;

export function getDefaultSigner(): ActivityRowSigner {
  if (cachedSigner) return cachedSigner;
  cachedSigner = createHmacSigner(loadAuditKeyFromDisk());
  return cachedSigner;
}

/** Exposed only for tests; production code calls `getDefaultSigner()`. */
export function _setDefaultSignerForTests(
  signer: ActivityRowSigner | null,
): void {
  cachedSigner = signer;
}

/**
 * Resolve the audit-key directory from a full path. Exists so
 * `scripts/lib/secrets.sh` can mkdir the parent without re-encoding
 * the constant.
 */
export function auditKeyDirectory(): string {
  return path.dirname(AUDIT_KEY_PATH);
}
