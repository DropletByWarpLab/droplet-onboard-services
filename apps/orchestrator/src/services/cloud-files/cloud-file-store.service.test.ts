/**
 * WARP-3538 — the provider-agnostic cloud-file store: landing an item, the sweep
 * that removes what a full re-enumeration did not return, and every way rows
 * leave.
 *
 * ADR-041 §4 says deletion is a real operation, and these tables have no foreign
 * key to a user, so nothing but each statement's `where` stops a purge deleting
 * somebody else's rows. The in-memory delegates EVALUATE their arguments
 * (`helpers/fake-cloud-files.ts`), so a dropped `userId`, `provider` or
 * `sourceId` predicate changes what these tests see — which is what the
 * "never touches another person's rows" cases are for.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { makeFakeCloudFileDb, type FakeCloudFileDb } from "../../__tests__/helpers/fake-cloud-files.js";
import { unsealItemField, unsealSourceField } from "./cloud-file-crypto.js";
import {
  countFilesBySource,
  deleteItemTree,
  deleteItemsInSources,
  deleteSources,
  ensureSource,
  findSourceId,
  hasSource,
  listSourceIds,
  markSourceForSweep,
  purgeProviderForUser,
  sweepSource,
  upsertItem,
  upsertSource,
  type CloudFileDb,
  type CloudFileItemInput,
  type CloudFileSourceInput,
} from "./cloud-file-store.service.js";

const USER = "user-1";
const OTHER = "user-2";
const SRC = "drive-1";

beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 5).toString("base64")));
afterEach(() => __setColumnCryptoKeyForTest(null));

const asDb = (db: FakeCloudFileDb) => db as unknown as CloudFileDb;

function item(over: Partial<CloudFileItemInput> = {}): CloudFileItemInput {
  return {
    userId: USER,
    provider: "M365",
    sourceId: SRC,
    externalId: "item-1",
    parentExternalId: "folder-1",
    isFolder: false,
    name: "Smith, John — consent.pdf",
    webUrl: "https://contoso.sharepoint.com/sites/front/consent.pdf",
    lastModifiedBy: "Sam Rivera",
    mimeType: "application/pdf",
    sizeBytes: 48211,
    remoteCreatedAt: new Date("2026-09-01T10:00:00Z"),
    remoteModifiedAt: new Date("2026-10-01T14:03:00Z"),
    ...over,
  };
}

function source(over: Partial<CloudFileSourceInput> = {}): CloudFileSourceInput {
  return {
    userId: USER,
    provider: "M365",
    sourceId: SRC,
    kind: "SHAREPOINT_LIBRARY",
    siteId: "contoso.sharepoint.com,site-guid,web-guid",
    siteName: "Front desk — Smith, John",
    name: "Patient consents",
    webUrl: "https://contoso.sharepoint.com/sites/front/Consents",
    followed: true,
    ...over,
  };
}

/** A row as the database would hold it, for seeding what a delete has to leave alone. */
const row = (
  userId: string,
  sourceId: string,
  externalId: string,
  parentExternalId: string | null = null,
  extra: Record<string, unknown> = {},
) => ({ userId, provider: "M365", sourceId, externalId, parentExternalId, isFolder: false, nameEnc: "dcv1:x", ...extra });

const ids = (db: FakeCloudFileDb, userId = USER, sourceId = SRC) =>
  db.items.filter((r) => r.userId === userId && r.sourceId === sourceId).map((r) => r.externalId as string).sort();

describe("upsertItem", () => {
  it("lands an item with its human-readable columns sealed and the rest in the clear", async () => {
    const db = makeFakeCloudFileDb();
    await upsertItem(asDb(db), item());

    const stored = db.items[0]!;
    // What the filters, the sort and the sweep run on stays readable…
    expect(stored).toMatchObject({
      userId: USER,
      provider: "M365",
      sourceId: SRC,
      externalId: "item-1",
      parentExternalId: "folder-1",
      isFolder: false,
      mimeType: "application/pdf",
      sizeBytes: 48211n,
      sweepPending: false,
    });
    expect(stored.remoteModifiedAt).toEqual(new Date("2026-10-01T14:03:00Z"));
    // …and nothing a person would recognise is. A name in a practice carries a patient's.
    const everything = JSON.stringify([stored.nameEnc, stored.webUrlEnc, stored.lastModifiedByEnc]);
    expect(everything).not.toContain("Smith");
    expect(everything).not.toContain("sharepoint.com");
    expect(everything).not.toContain("Sam Rivera");
    const ref = { provider: "M365", userId: USER, sourceId: SRC, externalId: "item-1" } as const;
    expect(unsealItemField(ref, "name", stored.nameEnc as string)).toBe("Smith, John — consent.pdf");
    expect(unsealItemField(ref, "webUrl", stored.webUrlEnc as string)).toBe("https://contoso.sharepoint.com/sites/front/consent.pdf");
    expect(unsealItemField(ref, "lastModifiedBy", stored.lastModifiedByEnc as string)).toBe("Sam Rivera");
  });

  it("updates the same row when the item is seen again — an upsert, never an append", async () => {
    // A change feed repeats items, and the engine re-runs a page after a
    // failure: the last one seen wins and there is one row.
    const db = makeFakeCloudFileDb();
    await upsertItem(asDb(db), item({ name: "old name.pdf" }));
    await upsertItem(asDb(db), item({ name: "new name.pdf", parentExternalId: "folder-2", sizeBytes: 9 }));

    expect(db.items).toHaveLength(1);
    const ref = { provider: "M365", userId: USER, sourceId: SRC, externalId: "item-1" } as const;
    expect(unsealItemField(ref, "name", db.items[0]!.nameEnc as string)).toBe("new name.pdf");
    expect(db.items[0]).toMatchObject({ parentExternalId: "folder-2", sizeBytes: 9n });
  });

  it("clears the sweep mark of an item the current enumeration returns", async () => {
    // The mark means "not seen in this full enumeration yet". An item that IS
    // returned must un-mark itself, or the sweep deletes a file the provider
    // had just told us about. (Mutation: drop `sweepPending: false` from the
    // update and this stays true.)
    const db = makeFakeCloudFileDb();
    await upsertItem(asDb(db), item());
    await markSourceForSweep(asDb(db), { userId: USER, provider: "M365", sourceId: SRC });
    expect(db.items[0]!.sweepPending).toBe(true);

    await upsertItem(asDb(db), item());
    expect(db.items[0]!.sweepPending).toBe(false);
  });

  it("keeps rows apart by person, provider-source and item id", async () => {
    const db = makeFakeCloudFileDb();
    await upsertItem(asDb(db), item());
    await upsertItem(asDb(db), item({ userId: OTHER }));
    await upsertItem(asDb(db), item({ sourceId: "drive-2" }));
    await upsertItem(asDb(db), item({ externalId: "item-2" }));
    expect(db.items).toHaveLength(4);
  });

  it("stores nothing sealed for a column the provider did not send", async () => {
    const db = makeFakeCloudFileDb();
    await upsertItem(asDb(db), item({ webUrl: null, lastModifiedBy: null, mimeType: null, remoteCreatedAt: null, remoteModifiedAt: null }));
    expect(db.items[0]).toMatchObject({ webUrlEnc: null, lastModifiedByEnc: null, mimeType: null, remoteCreatedAt: null, remoteModifiedAt: null });
  });

  it.each([
    ["a folder's absent size", null, null],
    ["zero", 0, 0n],
    ["a negative number", -1, null],
    ["a fraction", 1.5, null],
    ["a number past what a double holds exactly", 2 ** 60, null],
    ["not-a-number", Number.NaN, null],
  ])("a size of %s is stored as %s — never a wrong number", async (_label, given, expected) => {
    const db = makeFakeCloudFileDb();
    await upsertItem(asDb(db), item({ sizeBytes: given }));
    expect(db.items[0]!.sizeBytes).toBe(expected);
  });
});

describe("deleteItemTree", () => {
  /** root-folder ─ a ─ a1, a2(folder) ─ a2x ; sibling b ; the same ids in another source and for another person. */
  function seedTree() {
    const db = makeFakeCloudFileDb();
    for (const r of [
      row(USER, SRC, "a", "root"),
      row(USER, SRC, "a1", "a"),
      row(USER, SRC, "a2", "a"),
      row(USER, SRC, "a2x", "a2"),
      row(USER, SRC, "b", "root"),
      // The same ids elsewhere: an item id is unique within a container, not across them.
      row(USER, "drive-2", "a", "root"),
      row(USER, "drive-2", "a1", "a"),
      row(OTHER, SRC, "a", "root"),
      row(OTHER, SRC, "a1", "a"),
    ]) {
      db.seedItem(r);
    }
    return db;
  }

  it("removes a file and nothing else", async () => {
    const db = seedTree();
    expect(await deleteItemTree(asDb(db), { userId: USER, provider: "M365", sourceId: SRC, externalId: "b" })).toBe(1);
    expect(ids(db)).toEqual(["a", "a1", "a2", "a2x"]);
  });

  it("removes a folder and everything beneath it, however deep", async () => {
    // A change feed may report a deleted folder without listing what was in it,
    // and a stored child of a folder that no longer exists is a search hit that
    // opens a 404.
    const db = seedTree();
    expect(await deleteItemTree(asDb(db), { userId: USER, provider: "M365", sourceId: SRC, externalId: "a" })).toBe(4);
    expect(ids(db)).toEqual(["b"]);
  });

  it("still clears the children when the folder row itself is already gone", async () => {
    const db = seedTree();
    db.items.splice(db.items.findIndex((r) => r.userId === USER && r.sourceId === SRC && r.externalId === "a"), 1);
    expect(await deleteItemTree(asDb(db), { userId: USER, provider: "M365", sourceId: SRC, externalId: "a" })).toBe(3);
    expect(ids(db)).toEqual(["b"]);
  });

  it("never reaches into another source or another person, even for the same ids", async () => {
    // Mutation: drop `sourceId` or `userId` from either statement and a delete
    // takes the same-named items of another library or another person with it.
    const db = seedTree();
    await deleteItemTree(asDb(db), { userId: USER, provider: "M365", sourceId: SRC, externalId: "a" });
    expect(ids(db, USER, "drive-2")).toEqual(["a", "a1"]);
    expect(ids(db, OTHER, SRC)).toEqual(["a", "a1"]);
  });

  it("ends on a malformed parent loop instead of spinning", async () => {
    const db = makeFakeCloudFileDb();
    db.seedItem(row(USER, SRC, "x", "y"));
    db.seedItem(row(USER, SRC, "y", "x"));
    expect(await deleteItemTree(asDb(db), { userId: USER, provider: "M365", sourceId: SRC, externalId: "x" })).toBe(2);
    expect(ids(db)).toEqual([]);
  });

  it("walks a subtree wider than one statement can carry, in chunks", async () => {
    const db = makeFakeCloudFileDb();
    db.seedItem(row(USER, SRC, "big", "root", { isFolder: true }));
    for (let i = 0; i < 1203; i += 1) db.seedItem(row(USER, SRC, `c${i}`, "big"));
    db.seedItem(row(USER, SRC, "keep", "root"));

    expect(await deleteItemTree(asDb(db), { userId: USER, provider: "M365", sourceId: SRC, externalId: "big" })).toBe(1204);
    expect(ids(db)).toEqual(["keep"]);
    // 500 ids per statement: three delete statements, never one of 1,204.
    expect(db.cloudFileItem.deleteMany).toHaveBeenCalledTimes(3);
  });
});

describe("the sweep of a full enumeration", () => {
  const scope = { userId: USER, provider: "M365", sourceId: SRC } as const;

  it("marks every row of THAT source for THAT person, and only those", async () => {
    const db = makeFakeCloudFileDb();
    db.seedItem(row(USER, SRC, "a"));
    db.seedItem(row(USER, SRC, "b"));
    db.seedItem(row(USER, "drive-2", "c"));
    db.seedItem(row(OTHER, SRC, "d"));

    expect(await markSourceForSweep(asDb(db), scope)).toBe(2);
    expect(db.items.filter((r) => r.sweepPending).map((r) => r.externalId).sort()).toEqual(["a", "b"]);
  });

  it("deletes only the marked rows of that source and that person", async () => {
    // Mutation: drop `sweepPending: true` from the delete and a sweep takes
    // every file the person has; drop `sourceId` or `userId` and it takes
    // another library's, or another person's.
    const db = makeFakeCloudFileDb();
    db.seedItem(row(USER, SRC, "gone", null, { sweepPending: true }));
    db.seedItem(row(USER, SRC, "seen"));
    db.seedItem(row(USER, "drive-2", "other-library", null, { sweepPending: true }));
    db.seedItem(row(OTHER, SRC, "other-person", null, { sweepPending: true }));

    expect(await sweepSource(asDb(db), scope)).toBe(1);
    expect(ids(db)).toEqual(["seen"]);
    expect(ids(db, USER, "drive-2")).toEqual(["other-library"]);
    expect(ids(db, OTHER)).toEqual(["other-person"]);
  });

  it("leaves exactly what the enumeration returned: mark, re-land some, sweep", async () => {
    const db = makeFakeCloudFileDb();
    for (const id of ["kept", "renamed", "deleted-upstream"]) await upsertItem(asDb(db), item({ externalId: id }));

    await markSourceForSweep(asDb(db), scope);
    await upsertItem(asDb(db), item({ externalId: "kept" }));
    await upsertItem(asDb(db), item({ externalId: "renamed", name: "a new name.pdf" }));
    await upsertItem(asDb(db), item({ externalId: "brand-new" }));
    await sweepSource(asDb(db), scope);

    expect(ids(db)).toEqual(["brand-new", "kept", "renamed"]);
  });

  it("is a no-op sweep when nothing was marked — an incremental run never reaches a row", async () => {
    const db = makeFakeCloudFileDb();
    db.seedItem(row(USER, SRC, "a"));
    expect(await sweepSource(asDb(db), scope)).toBe(0);
    expect(ids(db)).toEqual(["a"]);
  });
});

describe("sources", () => {
  const ref = { provider: "M365", userId: USER, sourceId: SRC } as const;

  it("upsertSource seals the names and refreshes them in place when the container is renamed", async () => {
    const db = makeFakeCloudFileDb();
    await upsertSource(asDb(db), source());
    const stored = db.sources[0]!;
    const everything = JSON.stringify([stored.siteNameEnc, stored.nameEnc, stored.webUrlEnc]);
    expect(everything).not.toContain("Smith");
    expect(everything).not.toContain("consents");
    expect(everything).not.toContain("sharepoint.com");
    expect(stored).toMatchObject({ kind: "SHAREPOINT_LIBRARY", siteId: "contoso.sharepoint.com,site-guid,web-guid", followed: true });
    expect(unsealSourceField(ref, "siteName", stored.siteNameEnc as string)).toBe("Front desk — Smith, John");
    expect(unsealSourceField(ref, "name", stored.nameEnc as string)).toBe("Patient consents");

    await upsertSource(asDb(db), source({ name: "Signed consents", followed: false }));
    expect(db.sources).toHaveLength(1);
    expect(unsealSourceField(ref, "name", db.sources[0]!.nameEnc as string)).toBe("Signed consents");
    expect(db.sources[0]!.followed).toBe(false);
  });

  it("a container with no site stores no site columns", async () => {
    const db = makeFakeCloudFileDb();
    await upsertSource(asDb(db), source({ kind: "ONEDRIVE", siteId: null, siteName: null, webUrl: null }));
    expect(db.sources[0]).toMatchObject({ kind: "ONEDRIVE", siteId: null, siteNameEnc: null, webUrlEnc: null });
  });

  it("ensureSource creates a missing row and leaves an existing one exactly as it was", async () => {
    // A OneDrive is read once: rewriting its sealed fields every tick would
    // churn the row for nothing, and a refresh that fails halfway can swap a
    // good value for a worse one. (Mutation: make `update` carry the fields and
    // the blob below changes.)
    const db = makeFakeCloudFileDb();
    await ensureSource(asDb(db), source({ kind: "ONEDRIVE", siteId: null, siteName: null, name: "OneDrive" }));
    expect(db.sources).toHaveLength(1);
    const before = { ...db.sources[0]! };

    await ensureSource(asDb(db), source({ kind: "ONEDRIVE", siteId: null, siteName: null, name: "Renamed by Microsoft" }));
    expect(db.sources).toHaveLength(1);
    expect(db.sources[0]!.nameEnc).toBe(before.nameEnc);
    expect(unsealSourceField(ref, "name", db.sources[0]!.nameEnc as string)).toBe("OneDrive");
  });

  it("findSourceId answers the newest source of a kind for that person, or null", async () => {
    const db = makeFakeCloudFileDb();
    expect(await findSourceId(asDb(db), { userId: USER, provider: "M365", kind: "ONEDRIVE" })).toBeNull();
    db.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "older", nameEnc: "x", createdAt: new Date("2026-01-01T00:00:00Z") });
    db.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "newer", nameEnc: "x", createdAt: new Date("2026-06-01T00:00:00Z") });
    db.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "lib", nameEnc: "x" });
    db.seedSource({ userId: OTHER, provider: "M365", kind: "ONEDRIVE", sourceId: "theirs", nameEnc: "x" });

    expect(await findSourceId(asDb(db), { userId: USER, provider: "M365", kind: "ONEDRIVE" })).toBe("newer");
    expect(await findSourceId(asDb(db), { userId: OTHER, provider: "M365", kind: "SHAREPOINT_LIBRARY" })).toBeNull();
  });

  it("hasSource is true only for THAT person's source of THAT kind, in THAT cloud", async () => {
    // What a landing handler asks before it writes a file: is the place this
    // file would sit one this person still has? Mutation: drop `userId`,
    // `provider` or `kind` from the lookup and a library somebody else has, a
    // OneDrive passing for a library, or another cloud's container with the same
    // id would let a page land under a source the person does not have.
    const db = makeFakeCloudFileDb();
    db.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "lib", nameEnc: "x" });
    db.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "od", nameEnc: "x" });
    db.seedSource({ userId: OTHER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "theirs", nameEnc: "x" });
    db.seedSource({ userId: USER, provider: "GOOGLE", kind: "SHAREPOINT_LIBRARY", sourceId: "elsewhere", nameEnc: "x" });
    const has = (over: Record<string, unknown>) =>
      hasSource(asDb(db), { userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "lib", ...over } as never);

    expect(await has({})).toBe(true);
    expect(await has({ sourceId: "nope" })).toBe(false);
    expect(await has({ sourceId: "od" })).toBe(false); // it is a OneDrive, not a library
    expect(await has({ sourceId: "od", kind: "ONEDRIVE" })).toBe(true);
    expect(await has({ sourceId: "theirs" })).toBe(false); // somebody else's
    expect(await has({ sourceId: "elsewhere" })).toBe(false); // another cloud's
  });

  it("listSourceIds is the person's sources of that kind", async () => {
    const db = makeFakeCloudFileDb();
    db.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "l1", nameEnc: "x" });
    db.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "l2", nameEnc: "x" });
    db.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "od", nameEnc: "x" });
    db.seedSource({ userId: OTHER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "l9", nameEnc: "x" });
    expect((await listSourceIds(asDb(db), { userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY" })).sort()).toEqual(["l1", "l2"]);
  });

  it("countFilesBySource counts files per source — folders are not files", async () => {
    const db = makeFakeCloudFileDb();
    db.seedItem(row(USER, "d1", "f1"));
    db.seedItem(row(USER, "d1", "f2"));
    db.seedItem(row(USER, "d1", "dir", null, { isFolder: true }));
    db.seedItem(row(USER, "d2", "f3"));
    db.seedItem(row(OTHER, "d1", "f4"));
    const counts = await countFilesBySource(asDb(db), { userId: USER, provider: "M365" });
    expect([...counts.entries()].sort()).toEqual([["d1", 2], ["d2", 1]]);
  });
});

describe("purging", () => {
  function seedTwoPeople() {
    const db = makeFakeCloudFileDb();
    for (const [user, src] of [[USER, "d1"], [USER, "d2"], [OTHER, "d1"]] as const) {
      db.seedSource({ userId: user, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: src, nameEnc: "x" });
      db.seedItem(row(user, src, "i1"));
      db.seedItem(row(user, src, "i2"));
    }
    return db;
  }

  it("deleteItemsInSources removes the items of those sources for that person and no others", async () => {
    const db = seedTwoPeople();
    expect(await deleteItemsInSources(asDb(db), { userId: USER, provider: "M365", sourceIds: ["d1"] })).toBe(2);
    expect(ids(db, USER, "d1")).toEqual([]);
    expect(ids(db, USER, "d2")).toEqual(["i1", "i2"]);
    expect(ids(db, OTHER, "d1")).toEqual(["i1", "i2"]);
  });

  it("deleteSources removes those source rows for that person and no others", async () => {
    const db = seedTwoPeople();
    expect(await deleteSources(asDb(db), { userId: USER, provider: "M365", sourceIds: ["d2"] })).toBe(1);
    expect(db.sources.map((s) => `${s.userId}:${s.sourceId}`).sort()).toEqual([`${USER}:d1`, `${OTHER}:d1`]);
  });

  it("an empty list of sources deletes nothing — and does not become 'every source'", async () => {
    // `IN ()` matches nothing, but a caller that spread an empty list into a
    // where-clause the wrong way would match everything. Pinned.
    const db = seedTwoPeople();
    expect(await deleteItemsInSources(asDb(db), { userId: USER, provider: "M365", sourceIds: [] })).toBe(0);
    expect(await deleteSources(asDb(db), { userId: USER, provider: "M365", sourceIds: [] })).toBe(0);
    expect(db.items).toHaveLength(6);
    expect(db.sources).toHaveLength(3);
  });

  it("purgeProviderForUser removes every item and source of that person from that cloud, and reports how many", async () => {
    const db = seedTwoPeople();
    expect(await purgeProviderForUser(asDb(db), { userId: USER, provider: "M365" })).toEqual({ items: 4, sources: 2 });
    expect(db.items.every((r) => r.userId === OTHER)).toBe(true);
    expect(db.sources.every((r) => r.userId === OTHER)).toBe(true);
  });

  it("purgeProviderForUser is a clean no-op for a person with nothing", async () => {
    const db = makeFakeCloudFileDb();
    expect(await purgeProviderForUser(asDb(db), { userId: USER, provider: "M365" })).toEqual({ items: 0, sources: 0 });
  });

  it("purgeProviderForUser leaves a person's files in a DIFFERENT cloud alone", async () => {
    // Google Drive and Dropbox land into the same tables. Disconnecting one
    // cloud must not erase another's. (A second provider does not exist in the
    // enum yet; the row is seeded under the name it will have.)
    const db = seedTwoPeople();
    db.seedItem({ ...row(USER, "g1", "gi1"), provider: "GOOGLE" });
    db.seedSource({ userId: USER, provider: "GOOGLE", kind: "GOOGLE_MY_DRIVE", sourceId: "g1", nameEnc: "x" });
    await purgeProviderForUser(asDb(db), { userId: USER, provider: "M365" });
    expect(db.items.filter((r) => r.provider === "GOOGLE")).toHaveLength(1);
    expect(db.sources.filter((r) => r.provider === "GOOGLE")).toHaveLength(1);
  });
});
