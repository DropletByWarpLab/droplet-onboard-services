/**
 * WARP-2115 / ADR-041 — sealing the Microsoft 365 token cache.
 *
 * The MSAL cache contains the REFRESH TOKEN, which is functionally a
 * long-lived key to the customer's mailbox and files. ADR-041 requires it
 * encrypted at rest, bound to its owner, and unrecoverable after a wipe.
 *
 * These tests pin the three properties that make that true:
 *   - it round-trips (obviously), and the stored form is never plaintext;
 *   - it is AAD-bound to the owning user, so a blob copied onto another user's
 *     row FAILS TO DECRYPT rather than silently handing that user someone
 *     else's mailbox — the difference between a database bug and a breach;
 *   - it uses a key derived separately from the user-email column key, so
 *     compromising one does not extend to the other.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  __setColumnCryptoKeyForTest,
  decryptColumn,
  deriveEmailColumnKey,
  isEncryptedColumn,
} from "../column-crypto.service.js";
import { sealTokenCache, unsealTokenCache } from "./token-cache.js";

// 32-byte base64 test key so derivation works without env setup.
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

// A realistic-shaped MSAL cache: the thing we must never store in the clear.
const CACHE_JSON = JSON.stringify({
  RefreshToken: {
    "uid.utid-login.windows.net-refreshtoken-app-": {
      secret: "0.AXoA-pretend-refresh-token-value",
      home_account_id: "uid.utid",
    },
  },
});

beforeEach(() => __setColumnCryptoKeyForTest(TEST_KEY));
afterEach(() => __setColumnCryptoKeyForTest(null));

describe("sealTokenCache / unsealTokenCache", () => {
  it("round-trips the cache for its owner", () => {
    const sealed = sealTokenCache("user-1", CACHE_JSON);
    expect(unsealTokenCache("user-1", sealed)).toBe(CACHE_JSON);
  });

  it("stores ciphertext — the refresh token never appears in the blob", () => {
    const sealed = sealTokenCache("user-1", CACHE_JSON);
    expect(sealed).not.toContain("0.AXoA-pretend-refresh-token-value");
    expect(sealed).not.toContain("RefreshToken");
    expect(isEncryptedColumn(sealed)).toBe(true);
  });

  it("refuses to open another user's blob", () => {
    // The security-critical case. userId is the AAD, so a row-swap (bug,
    // bad restore, or tampering) fails closed instead of leaking a mailbox.
    const sealed = sealTokenCache("user-1", CACHE_JSON);
    expect(() => unsealTokenCache("user-2", sealed)).toThrow();
  });

  it("fails closed on a tampered blob rather than returning partial plaintext", () => {
    const sealed = sealTokenCache("user-1", CACHE_JSON);
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    expect(() => unsealTokenCache("user-1", tampered)).toThrow();
  });

  it("produces a different blob each time, so equal caches are not linkable", () => {
    expect(sealTokenCache("user-1", CACHE_JSON)).not.toBe(sealTokenCache("user-1", CACHE_JSON));
  });

  it("is not decryptable with the user-email column key", () => {
    // Key separation: the M365 token key must derive from a different HKDF
    // info label than the email column, so one key's compromise is contained.
    const sealed = sealTokenCache("user-1", CACHE_JSON);
    expect(() => decryptColumn(deriveEmailColumnKey(), sealed, "user-1")).toThrow();
  });
});
