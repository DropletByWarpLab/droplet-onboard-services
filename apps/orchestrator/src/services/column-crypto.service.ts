import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes,
} from "node:crypto";
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
 * Keys: doc-KEK = HKDF-SHA256(DEVICE_SECRET_KEY, salt="droplet-column-crypto-v1",
 * info="doc-kek"). Per-document DEKs are wrapped by the KEK (AAD = keyId) and
 * persisted in DocumentEncryptionKey (document-key.service.ts). Crypto-shred =
 * delete the row. TPM sealing of the KEK is WARP-1033.
 */

export const ENC_PREFIX = "dcv1:";
const SALT = "droplet-column-crypto-v1";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let overrideKeyB64: string | null = null;

function ikm(): Buffer {
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

function hkdf(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm(), Buffer.from(SALT), Buffer.from(info), 32));
}

export function deriveDocKek(): Buffer { return hkdf("doc-kek"); }
export function deriveEmailIndexKey(): Buffer { return hkdf("email-blind-index"); }
/** Column key for User.email at rest (whole-column logical key — derived,
 *  not a stored DEK: no per-user shred story, and sync read/write paths). */
export function deriveEmailColumnKey(): Buffer { return hkdf("user-email-column"); }
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
export function encryptColumn(key: Buffer, plaintext: string): string {
  return ENC_PREFIX + seal(key, Buffer.from(plaintext, "utf8")).toString("base64");
}
export function decryptColumn(key: Buffer, blob: string): string {
  if (!blob.startsWith(ENC_PREFIX)) throw new Error("column-crypto: missing dcv1: prefix");
  return open(key, Buffer.from(blob.slice(ENC_PREFIX.length), "base64")).toString("utf8");
}
export function isEncryptedColumn(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}
export function emailLookupHash(email: string): string {
  return createHmac("sha256", deriveEmailIndexKey())
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/** Test helper — install a known key without touching env. */
export function __setColumnCryptoKeyForTest(keyBase64: string | null): void {
  overrideKeyB64 = keyBase64;
}
