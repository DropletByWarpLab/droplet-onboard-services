/**
 * WARP-3538 — `deriveCloudFileMetadataKey()`, the key the landed cloud-file
 * metadata (file, site and library names, for every provider) is sealed under.
 *
 * One promise is under test, and it fails silently: **purpose separation.** The
 * key must differ from every other column key on the box. Aliasing it onto
 * `deriveM365TokenCacheKey` would compile, pass every functional test, and
 * quietly mean that the key which opens a person's refresh token (a long-lived
 * key to their mailbox) also opens every file name Droplet has landed — and the
 * other way round.
 *
 * Its factory-reset behaviour is stated here too, because it is a decision and
 * not an accident: the key rides DEVICE_SECRET_KEY, so a reset shreds the
 * landed metadata along with the tokens. That is acceptable ONLY because the
 * data is a cache of Microsoft's and re-syncs (see the m365-auth unreadable-cache
 * test, which makes that re-sync actually happen).
 */
import { hkdfSync } from "node:crypto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  __setColumnCryptoKeyForTest,
  decryptColumn,
  deriveCloudFileMetadataKey,
  deriveEmailColumnKey,
  deriveEmailIndexKey,
  deriveErpCloudTokenKey,
  deriveM365TokenCacheKey,
  deriveSaasCredentialKey,
  encryptColumn,
  ENC_PREFIX,
} from "./column-crypto.service.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  __setColumnCryptoKeyForTest(TEST_KEY);
});

describe("deriveCloudFileMetadataKey", () => {
  it("is its own key, distinct from every other column purpose", () => {
    const key = deriveCloudFileMetadataKey();

    // Mutation: `export const deriveCloudFileMetadataKey = deriveM365TokenCacheKey`
    // (or any other existing derivation) turns every line below red.
    expect(key.equals(deriveM365TokenCacheKey())).toBe(false);
    expect(key.equals(deriveEmailColumnKey())).toBe(false);
    expect(key.equals(deriveEmailIndexKey())).toBe(false);
    expect(key.equals(deriveErpCloudTokenKey())).toBe(false);
    expect(key.equals(deriveSaasCredentialKey())).toBe(false);
  });

  it("is HKDF over the device secret with the info label \"cloud-file-metadata\" — the label is a stored-data contract", () => {
    // Every landed name is sealed under this key. Renaming the label (or the
    // salt it is derived with) would compile, pass every round-trip test, and
    // strand every row already on a box: they would all fail to open and the
    // person's file search would go quietly empty until a full resync. A label
    // change is a migration, so it must be a deliberate edit of THIS line.
    const expected = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(TEST_KEY, "base64"),
        Buffer.from("droplet-column-crypto-v1"),
        Buffer.from("cloud-file-metadata"),
        32,
      ),
    );
    expect(deriveCloudFileMetadataKey().equals(expected)).toBe(true);
  });

  it("is a 256-bit key, deterministic for a given device secret", () => {
    expect(deriveCloudFileMetadataKey()).toHaveLength(32);
    expect(deriveCloudFileMetadataKey().equals(deriveCloudFileMetadataKey())).toBe(true);
  });

  it("changes with the device secret, so a factory reset crypto-shreds what was landed", () => {
    const before = deriveCloudFileMetadataKey();
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 8).toString("base64"));
    expect(deriveCloudFileMetadataKey().equals(before)).toBe(false);
  });

  it("does not open a blob sealed under the token-cache key, even with the right AAD", () => {
    // The direction that matters most: a compromise of the metadata key must not
    // reach a refresh token.
    const sealedAsToken = encryptColumn(deriveM365TokenCacheKey(), "refresh-token", "user-1");
    expect(sealedAsToken.startsWith(ENC_PREFIX)).toBe(true);
    expect(() => decryptColumn(deriveCloudFileMetadataKey(), sealedAsToken, "user-1")).toThrow();
  });

  it("and a blob sealed under it is not opened by the token-cache key", () => {
    const sealed = encryptColumn(deriveCloudFileMetadataKey(), "Smith, John — crown.pdf", "user-1");
    expect(() => decryptColumn(deriveM365TokenCacheKey(), sealed, "user-1")).toThrow();
  });
});
