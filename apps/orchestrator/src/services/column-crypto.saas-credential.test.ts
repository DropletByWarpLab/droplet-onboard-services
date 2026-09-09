/**
 * WARP-2276 — `deriveSaasCredentialKey()` and its AAD binding.
 *
 * Two independent promises are under test, and they fail in different ways:
 *
 *  1. **Purpose separation.** The SaaS credential key must differ from every
 *     other column key on the box. Aliasing it to `deriveErpCloudTokenKey`
 *     would compile, pass every functional test, and quietly mean that one
 *     compromised key opens two unrelated classes of credential.
 *  2. **AAD binding, failing CLOSED.** A blob moved to another connection row
 *     must THROW, not return empty. An empty plaintext is indistinguishable
 *     from "not configured", which is exactly how a moved blob would turn into
 *     a connection that looks unconfigured instead of tampered with.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  __setColumnCryptoKeyForTest,
  decryptColumn,
  deriveErpCloudTokenKey,
  deriveM365TokenCacheKey,
  deriveSaasCredentialKey,
  encryptColumn,
  ENC_PREFIX,
  saasCredentialAad,
} from "./column-crypto.service.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const ROW_A = "conn_aaaaaaaaaaaaaaaaaaaaaa";
const ROW_B = "conn_bbbbbbbbbbbbbbbbbbbbbb";
/** Deliberately not shaped like any real vendor key — the point of the
 *  assertions below is that this string never appears anywhere it shouldn't. */
const SEEDED = "SEEDED-CREDENTIAL-VALUE";

beforeEach(() => {
  __setColumnCryptoKeyForTest(TEST_KEY);
});

describe("deriveSaasCredentialKey", () => {
  it("is its own key, distinct from every other column purpose", () => {
    const saas = deriveSaasCredentialKey();

    // Mutation: `export const deriveSaasCredentialKey = deriveErpCloudTokenKey`
    // — aliasing the new purpose onto an existing one — turns both of these red.
    expect(saas.equals(deriveErpCloudTokenKey())).toBe(false);
    expect(saas.equals(deriveM365TokenCacheKey())).toBe(false);
  });

  it("is deterministic for a given device secret", () => {
    expect(deriveSaasCredentialKey().equals(deriveSaasCredentialKey())).toBe(true);
  });

  it("changes with the device secret, so a factory reset crypto-shreds", () => {
    const before = deriveSaasCredentialKey();
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 8).toString("base64"));
    expect(deriveSaasCredentialKey().equals(before)).toBe(false);
  });
});

describe("SaaS credential AAD binding", () => {
  it("round-trips under the row it was sealed for", () => {
    const blob = encryptColumn(deriveSaasCredentialKey(), SEEDED, saasCredentialAad(ROW_A));
    expect(decryptColumn(deriveSaasCredentialKey(), blob, saasCredentialAad(ROW_A))).toBe(
      SEEDED,
    );
  });

  it("writes a dcv1:-prefixed envelope, never the legacy encryptSecret format", () => {
    const blob = encryptColumn(deriveSaasCredentialKey(), SEEDED, saasCredentialAad(ROW_A));
    expect(blob.startsWith(ENC_PREFIX)).toBe(true);
    // The ciphertext must not carry the plaintext in any recoverable form.
    expect(blob).not.toContain(SEEDED);
  });

  it("THROWS when a blob sealed for row A is opened with row B's id", () => {
    const blob = encryptColumn(deriveSaasCredentialKey(), SEEDED, saasCredentialAad(ROW_A));

    // Mutation: drop the row id from `saasCredentialAad` (return a constant
    // string) and this decrypt starts succeeding — the assertion goes red,
    // which is the whole point of the binding.
    expect(() =>
      decryptColumn(deriveSaasCredentialKey(), blob, saasCredentialAad(ROW_B)),
    ).toThrow();
  });

  it("fails closed rather than returning an empty plaintext", () => {
    const blob = encryptColumn(deriveSaasCredentialKey(), SEEDED, saasCredentialAad(ROW_A));
    let result: string | null = null;
    try {
      result = decryptColumn(deriveSaasCredentialKey(), blob, saasCredentialAad(ROW_B));
    } catch {
      result = null;
    }
    // An empty string here would be the dangerous outcome: it reads as "no
    // credential configured" and routes the operator to re-paste rather than to
    // ask why a blob is on the wrong row.
    expect(result).toBeNull();
  });

  it("binds distinctly per row — two rows never share an AAD", () => {
    expect(saasCredentialAad(ROW_A)).not.toBe(saasCredentialAad(ROW_B));
    expect(saasCredentialAad(ROW_A)).toContain(ROW_A);
  });

  it("cannot be opened with another purpose's key even with the right AAD", () => {
    const blob = encryptColumn(deriveSaasCredentialKey(), SEEDED, saasCredentialAad(ROW_A));
    expect(() =>
      decryptColumn(deriveErpCloudTokenKey(), blob, saasCredentialAad(ROW_A)),
    ).toThrow();
  });
});
