import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "../config.js";

/**
 * WARP-233 — app-layer PHI/PII column encryption (deviation D1: pg_tde is not
 * installable on pgvector/pgvector:pg16 and cannot do per-document keys).
 *
 * Wire format `dcv1:` = base64( iv(12) ‖ ciphertext ‖ tag(16) ) — tag LAST,
 * matching Python `cryptography`'s AESGCM layout so services/file-indexer
 * writes blobs this module reads. Deliberately different from
 * encryption.service.ts (iv‖tag‖ct) so the two formats can never be confused.
 *
 * Keys (WARP-242 split — the two ikm sources are deliberate):
 *   - doc-KEK = HKDF-SHA256(<data/secrets/doc-kek.key bytes>,
 *     salt="droplet-column-crypto-v1", info="doc-kek"). The keyfile never
 *     enters a restic snapshot (droplet-backup.sh excludes it), so deleting a
 *     wrapped DEK crypto-shreds its ciphertext even against restored backups.
 *     Consequence: restore-to-NEW-hardware cannot decrypt brain chunks (see
 *     docs/security/at-rest-encryption.md). TPM sealing is WARP-1033.
 *   - email keys = HKDF-SHA256(DEVICE_SECRET_KEY, ...). User.email MUST
 *     survive a disaster-recovery restore (it gates login), so it stays on
 *     the .env-carried secret — there is no per-user shred story for it.
 * Per-document DEKs are wrapped by the doc-KEK (AAD = keyId) and persisted in
 * DocumentEncryptionKey (document-key.service.ts). Crypto-shred = delete the
 * rows.
 */

export const ENC_PREFIX = "dcv1:";
const SALT = "droplet-column-crypto-v1";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let overrideKeyB64: string | null = null;
let docKekIkmCache: Buffer | null = null;

function deviceIkm(): Buffer {
  const raw = overrideKeyB64 ?? config.DEVICE_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "DEVICE_SECRET_KEY is not set — column encryption unavailable (setup.sh generates it).",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`DEVICE_SECRET_KEY must decode to 32 bytes (got ${buf.length}).`);
  }
  return buf;
}

/** WARP-242 — doc-KEK ikm comes from the dedicated keyfile, never .env
 *  (see module comment). Fails closed when the file is missing/malformed. */
function docKekIkm(): Buffer {
  if (overrideKeyB64) return deviceIkm(); // test seam covers both ikm sources
  if (docKekIkmCache) return docKekIkmCache;
  let buf: Buffer;
  try {
    buf = readFileSync(config.DOC_KEK_PATH);
  } catch (e) {
    throw new Error(
      `doc-KEK keyfile unreadable at ${config.DOC_KEK_PATH} — ` +
        `run scripts/setup.sh (mints data/secrets/doc-kek.key): ${String(e)}`,
    );
  }
  if (buf.length !== 32) {
    throw new Error(
      `doc-KEK keyfile at ${config.DOC_KEK_PATH} must be exactly 32 bytes (got ${buf.length}).`,
    );
  }
  docKekIkmCache = buf;
  return buf;
}

function hkdf(ikm: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.from(SALT), Buffer.from(info), 32));
}

export function deriveDocKek(): Buffer { return hkdf(docKekIkm(), "doc-kek"); }
export function deriveEmailIndexKey(): Buffer { return hkdf(deviceIkm(), "email-blind-index"); }
/** Column key for User.email at rest (whole-column logical key — derived,
 *  not a stored DEK: no per-user shred story, and sync read/write paths). */
export function deriveEmailColumnKey(): Buffer { return hkdf(deviceIkm(), "user-email-column"); }
/** WARP-2115 / ADR-041 — column key for M365Connection.tokenCacheEnc, which
 *  holds an MSAL cache containing a refresh token (a long-lived key to the
 *  customer's mailbox and files). Its own `info` label so compromise of the
 *  email column key does not extend to stored cloud credentials. Rides the
 *  DEVICE_SECRET_KEY ikm deliberately: setup.sh regenerates that on a factory
 *  reset, which crypto-shreds every stored token even if the rows survive —
 *  and unlike User.email, a token need NOT survive a disaster restore, because
 *  the person can simply sign in again. */
export function deriveM365TokenCacheKey(): Buffer { return hkdf(deviceIkm(), "m365-token-cache"); }
/** WARP-2137 / ADR-041 — column key for
 *  `IntegrationConnection.providerTokensEnc`, which holds the OAuth tokens of a
 *  cloud ERP track (QuickBooks Online's rotating refresh token, Dentrix
 *  Ascend's bearer). Separate `info` from the M365 label even though both are
 *  cloud tokens: they are different vendors with different blast radii, and one
 *  compromised key must not open the other. Same DEVICE_SECRET_KEY ikm and
 *  therefore the same factory-reset shred story — an owner who resets the box
 *  reconnects the company, which is the correct outcome for a financial grant. */
export function deriveErpCloudTokenKey(): Buffer { return hkdf(deviceIkm(), "erp-cloud-token"); }
/** WARP-2276 / ADR-041 — column key for the SaaS credentials an owner pastes
 *  into the admin configurator (`IntegrationConnection.apiCredentialsEnc`).
 *
 *  Its OWN `info` label rather than a widening of `deriveErpCloudTokenKey`,
 *  which is the same deliberate per-purpose separation that keeps the M365 and
 *  ERP-cloud labels apart: those two hold tokens the box OBTAINED through an
 *  OAuth grant it can re-run, while this holds a long-lived secret the customer
 *  typed in once and may have reused elsewhere. One compromised key must not
 *  open the other, and the blast radius of a pasted API key is the customer's
 *  vendor account, not just this box's grant.
 *
 *  Rides the DEVICE_SECRET_KEY ikm like its siblings, so a factory reset
 *  crypto-shreds every stored credential even if the rows survive — an owner
 *  who resets the box re-pastes the key, which is the correct outcome. */
export function deriveSaasCredentialKey(): Buffer { return hkdf(deviceIkm(), "saas-credential"); }
/**
 * The AAD that binds a SaaS credential blob to the connection row holding it.
 *
 * Separate from the key derivation ON PURPOSE. The key is per-PURPOSE (one
 * label for every SaaS credential on the box); the AAD is per-ROW. Folding the
 * row id into the key instead would make a moved blob fail too — but it would
 * also make the AAD dead weight, and the next caller to reach for
 * `encryptColumn` without an AAD would silently get a blob that decrypts on any
 * row sharing the key. Keeping the binding here, in the value both call sites
 * must pass, is what makes "moved between rows fails closed" a testable claim
 * rather than an incidental property of the derivation.
 */
export function saasCredentialAad(connectionId: string): string {
  return `saas-credential:${connectionId}`;
}
export function generateDek(): Buffer { return randomBytes(32); }

function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  if (sealed.length < IV_LEN + TAG_LEN) throw new Error("column-crypto: blob too short");
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  const ct = sealed.subarray(IV_LEN, sealed.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function wrapDek(kek: Buffer, dek: Buffer, keyId: string): string {
  return seal(kek, dek, Buffer.from(keyId)).toString("base64");
}
export function unwrapDek(kek: Buffer, wrapped: string, keyId: string): Buffer {
  return open(kek, Buffer.from(wrapped, "base64"), Buffer.from(keyId));
}
/** WARP-242: optional `aad` binds the ciphertext to its document identity
 *  (chunk text passes the DEK's keyId, e.g. "brain:<itemId>"). AAD is
 *  authenticated by the GCM tag but not stored — decrypt must supply the
 *  same value. Omitting it keeps WARP-233 callers (User.email) unchanged. */
export function encryptColumn(key: Buffer, plaintext: string, aad?: string): string {
  return (
    ENC_PREFIX +
    seal(key, Buffer.from(plaintext, "utf8"), aad ? Buffer.from(aad) : undefined).toString(
      "base64",
    )
  );
}
export function decryptColumn(key: Buffer, blob: string, aad?: string): string {
  if (!blob.startsWith(ENC_PREFIX)) throw new Error("column-crypto: missing dcv1: prefix");
  return open(
    key,
    Buffer.from(blob.slice(ENC_PREFIX.length), "base64"),
    aad ? Buffer.from(aad) : undefined,
  ).toString("utf8");
}
export function isEncryptedColumn(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}
export function emailLookupHash(email: string): string {
  return createHmac("sha256", deriveEmailIndexKey())
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/** Test helper — install a known key without touching env. Overrides BOTH
 *  ikm sources (DEVICE_SECRET_KEY and the doc-KEK keyfile) and drops the
 *  keyfile cache so tests never read the real file. */
export function __setColumnCryptoKeyForTest(keyBase64: string | null): void {
  overrideKeyB64 = keyBase64;
  docKekIkmCache = null;
}
