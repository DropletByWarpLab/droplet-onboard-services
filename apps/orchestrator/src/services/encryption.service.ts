import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { config } from "../config.js";

/**
 * Authenticated symmetric encryption for per-device secrets.
 *
 * Each device client row stores the Nextcloud app password encrypted with
 * aes-256-gcm so we can revoke it later (by decrypting and calling the OCS
 * apppassword endpoint) without ever persisting the plaintext. Keys live in
 * the DEVICE_SECRET_KEY env var, generated once by scripts/setup.sh.
 *
 * Wire format for stored ciphertext:
 *   base64( iv (12 bytes) || authTag (16 bytes) || ciphertext )
 *
 * Rotating the key is not automatic — a planned rotation would need a
 * two-key transition window where decrypt tries the new key first and
 * falls back to the old one.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function assertValidKey(key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(
      `DEVICE_SECRET_KEY must decode to exactly 32 bytes (got ${key.length}).`
    );
  }
  return key;
}

function getKey(): Buffer {
  if (cachedKey) return assertValidKey(cachedKey);
  const raw = config.DEVICE_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "DEVICE_SECRET_KEY is not set. Generate one with `openssl rand -base64 32` " +
        "and add it to your .env; setup.sh does this automatically for fresh installs."
    );
  }
  cachedKey = assertValidKey(Buffer.from(raw, "base64"));
  return cachedKey;
}

/**
 * Encrypt a plaintext string and return an opaque base64 blob that can be
 * stored verbatim in the database.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a blob produced by `encryptSecret`. Throws on tamper or wrong key.
 */
export function decryptSecret(blob: string): string {
  const key = getKey();
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("encryption.service: ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Test helper — lets unit tests install a known key without touching env. */
export function __setEncryptionKeyForTest(keyBase64: string | null): void {
  cachedKey = keyBase64 ? Buffer.from(keyBase64, "base64") : null;
}
