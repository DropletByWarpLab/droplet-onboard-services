/**
 * WARP-3538 — sealing the human-readable columns of the landed drive metadata.
 *
 * A file name in a practice routinely carries a patient's name, so ADR-041 §4's
 * "synced content is encrypted at rest" is honoured for these columns even
 * though WARP-2549's narrow reading would have let this table be plaintext. What
 * these tests defend is the BINDING: a ciphertext is only openable by the row
 * and the column it was written for, so a bug, a bad restore or a copied row
 * fails closed instead of showing one person another person's file names — or a
 * file's name where its URL belongs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  __setColumnCryptoKeyForTest,
  decryptColumn,
  deriveEmailColumnKey,
  deriveM365DriveMetadataKey,
  deriveM365TokenCacheKey,
  isEncryptedColumn,
} from "../column-crypto.service.js";
import {
  sealDriveItemField,
  sealLibraryField,
  unsealDriveItemField,
  unsealLibraryField,
} from "./drive-metadata.js";

const TEST_KEY = Buffer.alloc(32, 3).toString("base64");
const NAME = "Smith, John — root canal consent.pdf";

beforeEach(() => __setColumnCryptoKeyForTest(TEST_KEY));
afterEach(() => __setColumnCryptoKeyForTest(null));

describe("sealDriveItemField / unsealDriveItemField", () => {
  it("round-trips each column for the row it was sealed for", () => {
    for (const column of ["name", "webUrl", "lastModifiedBy"] as const) {
      const blob = sealDriveItemField("user-1", "drive-1", "item-1", column, NAME);
      expect(unsealDriveItemField("user-1", "drive-1", "item-1", column, blob)).toBe(NAME);
    }
  });

  it("writes a dcv1: envelope that never carries the plaintext", () => {
    const blob = sealDriveItemField("user-1", "drive-1", "item-1", "name", NAME);
    expect(isEncryptedColumn(blob)).toBe(true);
    expect(blob).not.toContain("Smith");
    expect(Buffer.from(blob.slice("dcv1:".length), "base64").toString("utf8")).not.toContain("Smith");
  });

  it("produces a different blob each time, so equal names are not linkable", () => {
    expect(sealDriveItemField("user-1", "drive-1", "item-1", "name", NAME)).not.toBe(
      sealDriveItemField("user-1", "drive-1", "item-1", "name", NAME),
    );
  });

  it.each([
    ["another person", ["user-2", "drive-1", "item-1", "name"]],
    ["another drive", ["user-1", "drive-2", "item-1", "name"]],
    ["another item", ["user-1", "drive-1", "item-2", "name"]],
    ["another column", ["user-1", "drive-1", "item-1", "webUrl"]],
  ] as const)("refuses a blob opened as %s", (_label, [userId, driveId, itemId, column]) => {
    // Mutation: drop any one of the four from the AAD in drive-metadata.ts and
    // the matching case here starts decrypting — the row, the person or the
    // column can then be swapped without anything noticing.
    const blob = sealDriveItemField("user-1", "drive-1", "item-1", "name", NAME);
    expect(() => unsealDriveItemField(userId, driveId, itemId, column, blob)).toThrow();
  });

  it("cannot be re-split along an id's own delimiter to forge a match", () => {
    // Ids come out of Microsoft's response bodies, so one may contain the
    // character a naive `${user}:${drive}:${item}` AAD is joined with. `a:b` + `c`
    // must not collide with `a` + `b:c`; the AAD is an unambiguous encoding of
    // the tuple for exactly this reason. (Mutation: join with ":" and this opens.)
    const blob = sealDriveItemField("u", "a:b", "c", "name", NAME);
    expect(() => unsealDriveItemField("u", "a", "b:c", "name", blob)).toThrow();
    const lib = sealLibraryField("u", "a:b", "siteName", NAME);
    expect(() => unsealLibraryField("u:a", "b", "siteName", lib)).toThrow();
  });

  it("fails closed on a tampered blob rather than returning partial plaintext", () => {
    const blob = sealDriveItemField("user-1", "drive-1", "item-1", "name", NAME);
    expect(() =>
      unsealDriveItemField("user-1", "drive-1", "item-1", "name", `${blob.slice(0, -4)}AAAA`),
    ).toThrow();
  });

  it("is sealed under its OWN key — not the token-cache key, not the email column key", () => {
    const blob = sealDriveItemField("user-1", "drive-1", "item-1", "name", NAME);
    const aad = (key: Buffer) => {
      // Whatever AAD is used, a different KEY can never open it.
      for (const candidate of ["user-1", "user-1:drive-1:item-1:name", "user-1:drive-1:item-1"]) {
        expect(() => decryptColumn(key, blob, candidate)).toThrow();
      }
    };
    aad(deriveM365TokenCacheKey());
    aad(deriveEmailColumnKey());
    // …and the right key is not enough either: with no AAD, or the person's id
    // alone, the blob stays shut. (Mutation: seal without an AAD and these open.)
    expect(() => decryptColumn(deriveM365DriveMetadataKey(), blob)).toThrow();
    expect(() => decryptColumn(deriveM365DriveMetadataKey(), blob, "user-1")).toThrow();
  });

  it("is unreadable after the device secret changes, as a factory reset does", () => {
    const blob = sealDriveItemField("user-1", "drive-1", "item-1", "name", NAME);
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
    expect(() => unsealDriveItemField("user-1", "drive-1", "item-1", "name", blob)).toThrow();
  });
});

describe("sealLibraryField / unsealLibraryField", () => {
  it("round-trips each column for the library it was sealed for", () => {
    for (const column of ["siteName", "libraryName", "webUrl"] as const) {
      const blob = sealLibraryField("user-1", "drive-1", column, "Front desk");
      expect(unsealLibraryField("user-1", "drive-1", column, blob)).toBe("Front desk");
    }
  });

  it.each([
    ["another person", ["user-2", "drive-1", "siteName"]],
    ["another library", ["user-1", "drive-2", "siteName"]],
    ["another column", ["user-1", "drive-1", "libraryName"]],
  ] as const)("refuses a blob opened as %s", (_label, [userId, driveId, column]) => {
    const blob = sealLibraryField("user-1", "drive-1", "siteName", "Front desk");
    expect(() => unsealLibraryField(userId, driveId, column, blob)).toThrow();
  });

  it("cannot be opened as an item column, nor an item column as a library's", () => {
    // Same key, different AAD shape: a blob moved between the two tables fails
    // to decrypt instead of being read as the other kind of thing.
    const library = sealLibraryField("user-1", "drive-1", "webUrl", "https://x.example/lib");
    expect(() => unsealDriveItemField("user-1", "drive-1", "drive-1", "webUrl", library)).toThrow();
    const item = sealDriveItemField("user-1", "drive-1", "item-1", "webUrl", "https://x.example/f");
    expect(() => unsealLibraryField("user-1", "drive-1", "webUrl", item)).toThrow();
  });
});
