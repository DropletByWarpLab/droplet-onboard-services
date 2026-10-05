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
  deriveM365TokenCacheKey,
  encryptColumn,
  isEncryptedColumn,
} from "../column-crypto.service.js";
import { M365_BASE_SCOPES } from "./scopes.js";
import {
  sealPendingFlow,
  sealTokenCache,
  unsealPendingFlow,
  unsealTokenCache,
} from "./token-cache.js";

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

describe("sealPendingFlow / unsealPendingFlow (WARP-2704)", () => {
  const FLOW = {
    codeVerifier: "pkce-verifier-that-must-not-sit-in-the-clear-0123456789",
    nonce: "nonce-1",
    redirectUri: "https://droplet-ai.local/api/m365/callback",
    scopes: ["offline_access", "Mail.ReadWrite", "Sites.Read.All"],
  };

  it("round-trips the in-flight sign-in for its owner", () => {
    expect(unsealPendingFlow("user-1", sealPendingFlow("user-1", FLOW))).toEqual({ ...FLOW, returnTo: "/settings" });
  });

  it("never stores the PKCE verifier in the clear", () => {
    const sealed = sealPendingFlow("user-1", FLOW);
    expect(isEncryptedColumn(sealed)).toBe(true);
    expect(sealed).not.toContain(FLOW.codeVerifier);
  });

  it("refuses another user's blob", () => {
    const sealed = sealPendingFlow("user-1", FLOW);
    expect(() => unsealPendingFlow("user-2", sealed)).toThrow();
  });

  it("cannot be opened as a token cache, nor a token cache as a flow", () => {
    // Same key, different AAD: a blob moved between the row's two sealed
    // columns fails to decrypt instead of being parsed as the other kind.
    const flow = sealPendingFlow("user-1", FLOW);
    expect(() => unsealTokenCache("user-1", flow)).toThrow();
    const cache = sealTokenCache("user-1", CACHE_JSON);
    expect(() => unsealPendingFlow("user-1", cache)).toThrow();
  });

  it("refuses a blob that decrypts to the wrong shape", () => {
    // Defence in depth: a verifier that is not a string must not reach MSAL.
    const sealed = sealPendingFlow("user-1", { ...FLOW, codeVerifier: 7 } as never);
    expect(() => unsealPendingFlow("user-1", sealed)).toThrow();
  });

  describe("the scopes the authorize leg asked for travel with the flow (WARP-3538)", () => {
    // The person can flip the SharePoint switch in another tab while they are on
    // Microsoft's page, so the callback must redeem with the scopes it was ISSUED
    // for, not whatever the row says by then.
    const sealRaw = (payload: unknown) =>
      encryptColumn(deriveM365TokenCacheKey(), JSON.stringify(payload), "user-1:m365-pending-auth-code");
    const { scopes: _omitted, ...LEGACY } = FLOW;

    it("round-trips them exactly", () => {
      expect(unsealPendingFlow("user-1", sealPendingFlow("user-1", FLOW)).scopes).toEqual(FLOW.scopes);
    });

    it("a flow sealed by the build BEFORE this one (no scopes) is redeemed with the base set, which is what it asked for", () => {
      // It may still be inside its 15-minute window when the box updates: the
      // person is on Microsoft's page and would otherwise see a sign-in that can
      // no longer be completed. (Mutation: drop the fallback and this throws.)
      expect(unsealPendingFlow("user-1", sealRaw(LEGACY))).toEqual({ ...LEGACY, scopes: [...M365_BASE_SCOPES], returnTo: "/settings" });
    });

    it("hands back a copy of the fallback, so redeeming cannot edit the shared base set", () => {
      const a = unsealPendingFlow("user-1", sealRaw(LEGACY)).scopes;
      a.push("Sites.Read.All");
      expect(unsealPendingFlow("user-1", sealRaw(LEGACY)).scopes).toEqual([...M365_BASE_SCOPES]);
    });

    it.each([
      ["null", null],
      ["a string", "Mail.ReadWrite"],
      ["an empty list", []],
      ["a list with a non-string", ["Mail.ReadWrite", 7]],
      ["a list with an empty scope", ["Mail.ReadWrite", ""]],
    ])("refuses a flow whose scopes are %s — present but malformed is not the same as absent", (_label, scopes) => {
      expect(() => unsealPendingFlow("user-1", sealRaw({ ...LEGACY, scopes }))).toThrow();
    });
  });
});
