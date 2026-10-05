/**
 * WARP-3538 — sealing the human-readable columns of the landed cloud-file
 * metadata.
 *
 * A file name in a practice routinely carries a patient's name, so ADR-041 §4's
 * "synced content is encrypted at rest" is honoured for these columns even
 * though WARP-2549's narrow reading would have let these tables be plaintext.
 * What these tests defend is the BINDING: a ciphertext is only openable by the
 * provider, person, source, row and column it was written for, so a bug, a bad
 * restore or a copied row fails closed instead of showing one person another
 * person's file names — or a file's name where its URL belongs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CloudFileProvider } from "@prisma/client";

import {
  __setColumnCryptoKeyForTest,
  decryptColumn,
  deriveCloudFileMetadataKey,
  deriveEmailColumnKey,
  deriveM365TokenCacheKey,
  isEncryptedColumn,
} from "../column-crypto.service.js";
import {
  cloudFileCrypto,
  sealItemField,
  sealSourceField,
  unsealItemField,
  unsealSourceField,
  type CloudFileItemRef,
  type CloudFileSourceRef,
} from "./cloud-file-crypto.js";

const TEST_KEY = Buffer.alloc(32, 3).toString("base64");
const NAME = "Smith, John — root canal consent.pdf";

const ITEM: CloudFileItemRef = { provider: "M365", userId: "user-1", sourceId: "drive-1", externalId: "item-1" };
const SOURCE: CloudFileSourceRef = { provider: "M365", userId: "user-1", sourceId: "drive-1" };
/** A provider the schema does not have YET — Google Drive is next. The AAD binds
 *  the provider's name, so this stands in for "another cloud" without a second
 *  enum value existing. */
const OTHER_CLOUD = "GOOGLE" as unknown as CloudFileProvider;

beforeEach(() => __setColumnCryptoKeyForTest(TEST_KEY));
afterEach(() => __setColumnCryptoKeyForTest(null));

describe("sealItemField / unsealItemField", () => {
  it("round-trips each column for the row it was sealed for", () => {
    for (const column of ["name", "webUrl", "lastModifiedBy"] as const) {
      const blob = sealItemField(ITEM, column, NAME);
      expect(unsealItemField(ITEM, column, blob)).toBe(NAME);
    }
  });

  it("writes a dcv1: envelope that never carries the plaintext", () => {
    const blob = sealItemField(ITEM, "name", NAME);
    expect(isEncryptedColumn(blob)).toBe(true);
    expect(blob).not.toContain("Smith");
    expect(Buffer.from(blob.slice("dcv1:".length), "base64").toString("utf8")).not.toContain("Smith");
  });

  it("produces a different blob each time, so equal names are not linkable", () => {
    expect(sealItemField(ITEM, "name", NAME)).not.toBe(sealItemField(ITEM, "name", NAME));
  });

  it.each([
    ["another provider", { ...ITEM, provider: OTHER_CLOUD }, "name"],
    ["another person", { ...ITEM, userId: "user-2" }, "name"],
    ["another source", { ...ITEM, sourceId: "drive-2" }, "name"],
    ["another item", { ...ITEM, externalId: "item-2" }, "name"],
    ["another column", ITEM, "webUrl"],
  ] as const)("refuses a blob opened as %s", (_label, ref, column) => {
    // Mutation: drop any one of the five from the AAD in cloud-file-crypto.ts
    // and the matching case here starts decrypting — the row, the person, the
    // cloud or the column can then be swapped without anything noticing.
    const blob = sealItemField(ITEM, "name", NAME);
    expect(() => unsealItemField(ref, column, blob)).toThrow();
  });

  it("cannot be re-split along an id's own delimiter to forge a match", () => {
    // Ids come out of a provider's response bodies, so one may contain the
    // character a naive `${user}:${source}:${item}` AAD is joined with. `a:b` +
    // `c` must not collide with `a` + `b:c`; the AAD is an unambiguous encoding
    // of the tuple for exactly this reason. (Mutation: join with ":" and this opens.)
    const base = { provider: "M365", userId: "u" } as const;
    const blob = sealItemField({ ...base, sourceId: "a:b", externalId: "c" }, "name", NAME);
    expect(() => unsealItemField({ ...base, sourceId: "a", externalId: "b:c" }, "name", blob)).toThrow();

    const source = sealSourceField({ ...base, sourceId: "a:b" }, "siteName", NAME);
    expect(() => unsealSourceField({ ...base, userId: "u:a", sourceId: "b" }, "siteName", source)).toThrow();
  });

  it("fails closed on a tampered blob rather than returning partial plaintext", () => {
    const blob = sealItemField(ITEM, "name", NAME);
    expect(() => unsealItemField(ITEM, "name", `${blob.slice(0, -4)}AAAA`)).toThrow();
  });

  it("is sealed under its OWN key — not the token-cache key, not the email column key", () => {
    const blob = sealItemField(ITEM, "name", NAME);
    for (const key of [deriveM365TokenCacheKey(), deriveEmailColumnKey()]) {
      // Whatever AAD is used, a different KEY can never open it.
      for (const candidate of ["user-1", "user-1:drive-1:item-1:name", "user-1:drive-1:item-1"]) {
        expect(() => decryptColumn(key, blob, candidate)).toThrow();
      }
    }
    // …and the right key is not enough either: with no AAD, or the person's id
    // alone, the blob stays shut. (Mutation: seal without an AAD and these open.)
    expect(() => decryptColumn(deriveCloudFileMetadataKey(), blob)).toThrow();
    expect(() => decryptColumn(deriveCloudFileMetadataKey(), blob, "user-1")).toThrow();
  });

  it("is unreadable after the device secret changes, as a factory reset does", () => {
    const blob = sealItemField(ITEM, "name", NAME);
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
    expect(() => unsealItemField(ITEM, "name", blob)).toThrow();
  });
});

describe("sealSourceField / unsealSourceField", () => {
  it("round-trips each column for the source it was sealed for", () => {
    for (const column of ["siteName", "name", "webUrl"] as const) {
      const blob = sealSourceField(SOURCE, column, "Front desk");
      expect(unsealSourceField(SOURCE, column, blob)).toBe("Front desk");
    }
  });

  it.each([
    ["another provider", { ...SOURCE, provider: OTHER_CLOUD }, "siteName"],
    ["another person", { ...SOURCE, userId: "user-2" }, "siteName"],
    ["another source", { ...SOURCE, sourceId: "drive-2" }, "siteName"],
    ["another column", SOURCE, "name"],
  ] as const)("refuses a blob opened as %s", (_label, ref, column) => {
    const blob = sealSourceField(SOURCE, "siteName", "Front desk");
    expect(() => unsealSourceField(ref, column, blob)).toThrow();
  });
});

describe("items and sources never open as one another", () => {
  it("a source blob does not open as an item column, nor an item blob as a source's — whatever the item's id is", () => {
    // Same key, same column names (`name`, `webUrl`) on both tables. The first
    // element of the AAD says which table the blob belongs to; without it, an
    // item whose provider-chosen id read like "no item" could collide with the
    // source row beside it. (Mutation: drop the table element and the
    // `externalId: "source"` case below opens.)
    const source = sealSourceField(SOURCE, "webUrl", "https://x.example/lib");
    for (const externalId of ["drive-1", "source", "", "item-1"]) {
      expect(() => unsealItemField({ ...ITEM, externalId }, "webUrl", source)).toThrow();
    }
    const item = sealItemField({ ...ITEM, externalId: "source" }, "webUrl", "https://x.example/f");
    expect(() => unsealSourceField(SOURCE, "webUrl", item)).toThrow();
  });
});

describe("cloudFileCrypto — one derived key for a whole page or search", () => {
  it("opens what the module-level functions sealed, and the other way round", () => {
    const bound = cloudFileCrypto();
    const a = sealItemField(ITEM, "name", NAME);
    expect(bound.openItem(ITEM, "name", a)).toBe(NAME);
    const b = bound.sealSource(SOURCE, "name", "Documents");
    expect(unsealSourceField(SOURCE, "name", b)).toBe("Documents");
  });

  it("is bound to the key as it was when it was made", () => {
    // A search that straddles a key change must not half-succeed: the bound
    // object keeps one key, so what it sealed before the change opens through
    // it after the change, and nothing mixes the two.
    const bound = cloudFileCrypto();
    const blob = bound.sealItem(ITEM, "name", NAME);
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
    expect(bound.openItem(ITEM, "name", blob)).toBe(NAME);
    expect(() => unsealItemField(ITEM, "name", blob)).toThrow();
  });
});
