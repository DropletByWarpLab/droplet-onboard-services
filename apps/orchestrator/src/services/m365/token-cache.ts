/**
 * WARP-2115 / ADR-041 — sealing the Microsoft 365 token cache at rest.
 *
 * MSAL serializes its cache to JSON that contains the REFRESH TOKEN. On a
 * Droplet that token is functionally a long-lived key to the customer's mail
 * and files, so ADR-041 requires it encrypted at rest, purged on disconnect,
 * and unrecoverable after a factory reset.
 *
 * Two deliberate choices:
 *
 *   - **AAD-bound to the owning user.** The userId is the additional
 *     authenticated data, so a blob that ends up on the wrong row (a bug, a
 *     partial restore, tampering) FAILS TO DECRYPT instead of quietly handing
 *     one person another person's mailbox.
 *   - **Its own derived key.** `deriveM365TokenCacheKey` uses a different HKDF
 *     info label from the user-email column, so the two are cryptographically
 *     separated. That key rides DEVICE_SECRET_KEY, which setup.sh regenerates
 *     on a factory reset — a wipe therefore crypto-shreds stored tokens.
 *
 * Nothing here logs. Callers must never put the plaintext (or the sealed blob)
 * into a log line, an error message, or an API response.
 */
import {
  decryptColumn,
  deriveM365TokenCacheKey,
  encryptColumn,
} from "../column-crypto.service.js";

/**
 * Encrypt a serialized MSAL cache for storage in
 * `M365Connection.tokenCacheEnc`. Returns an opaque `dcv1:` blob.
 */
export function sealTokenCache(userId: string, serializedCache: string): string {
  return encryptColumn(deriveM365TokenCacheKey(), serializedCache, userId);
}

/**
 * Decrypt a stored cache blob back to the serialized MSAL cache.
 *
 * Throws when the blob was sealed for a different user, when it has been
 * tampered with, or when DEVICE_SECRET_KEY has changed (e.g. after a factory
 * reset). Callers should treat a throw as "this link can no longer be used"
 * and move the connection to NEEDS_RECONNECT — never as a fatal error.
 */
export function unsealTokenCache(userId: string, blob: string): string {
  return decryptColumn(deriveM365TokenCacheKey(), blob, userId);
}
