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
import { M365_BASE_SCOPES } from "./scopes.js";

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

// --- The in-flight authorization-code sign-in (WARP-2704) ------------------

/**
 * What the callback needs from the authorize step, and must not take from the
 * browser: the PKCE verifier (without it a stolen code is useless), the nonce
 * the ID token must echo, the exact redirect URI the code was issued to, and —
 * since WARP-3538 — the scopes the authorize leg asked for.
 *
 * The scopes travel with the flow because they are decided from the person's
 * row at the moment they pressed Connect, and the row can change while they are
 * on Microsoft's page (they flip the SharePoint switch in another tab).
 * Re-deriving them at the callback would redeem a code with scopes that differ
 * from the ones it was issued for, and Entra wants the redemption's scopes equal
 * to, or a subset of, the authorize leg's.
 */
export interface PendingAuthCodeFlow {
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  scopes: string[];
}

/** Same key as the token cache, its own AAD — so a blob moved between the
 *  row's two sealed columns fails to decrypt rather than being misparsed. */
function pendingFlowAad(userId: string): string {
  return `${userId}:m365-pending-auth-code`;
}

/** Seal an in-flight sign-in for `M365Connection.pendingFlowEnc`. */
export function sealPendingFlow(userId: string, flow: PendingAuthCodeFlow): string {
  return encryptColumn(deriveM365TokenCacheKey(), JSON.stringify(flow), pendingFlowAad(userId));
}

/**
 * Open a sealed in-flight sign-in. Throws on another user's blob, a tampered
 * blob, a rotated DEVICE_SECRET_KEY, or a payload of the wrong shape — callers
 * treat any throw as "this sign-in can no longer be completed".
 *
 * A flow sealed by the build before WARP-3538 has NO `scopes` and may still be
 * inside its 15-minute window when the box updates. That is not a malformed flow:
 * it was authorized with exactly the base set (the only set that build asked
 * for), so it is redeemed with that. A `scopes` that IS present but is not a
 * non-empty list of non-empty strings is malformed, and throws.
 */
export function unsealPendingFlow(userId: string, blob: string): PendingAuthCodeFlow {
  const parsed = JSON.parse(
    decryptColumn(deriveM365TokenCacheKey(), blob, pendingFlowAad(userId)),
  ) as Partial<Record<keyof PendingAuthCodeFlow, unknown>>;
  const { codeVerifier, nonce, redirectUri, scopes } = parsed;
  if (typeof codeVerifier !== "string" || typeof nonce !== "string" || typeof redirectUri !== "string") {
    throw new Error("The stored Microsoft sign-in is not in the expected shape.");
  }
  if (scopes === undefined) return { codeVerifier, nonce, redirectUri, scopes: [...M365_BASE_SCOPES] };
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string" && s !== "")) {
    throw new Error("The stored Microsoft sign-in is not in the expected shape.");
  }
  return { codeVerifier, nonce, redirectUri, scopes: [...(scopes as string[])] };
}
