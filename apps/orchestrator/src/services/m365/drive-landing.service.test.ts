/**
 * WARP-3538 — landing what Microsoft's drive delta feed reports.
 *
 * Two things are under test. First, what ONE entry of a page means
 * (`readDriveEntry`): Graph's driveItem facets mapped onto the store's columns,
 * with the cases that go wrong quietly — a deleted item that carries no name, a
 * root that is not a file, a URL that is not https, a folder's cumulative size.
 * Second, the handler's SEQUENCE, which is where the data loss would be: the
 * mark before the first upsert, the sweep after the last, the pages between
 * touching neither, and an incremental run never being able to delete anything
 * the feed did not say was deleted.
 *
 * The store is the real one over in-memory tables that EVALUATE their arguments
 * (`helpers/fake-cloud-files.ts`), so what these tests assert is what the
 * database would hold — including that nothing leaks across people, libraries or
 * clouds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { makeFakeCloudFileDb, type FakeCloudFileDb } from "../../__tests__/helpers/fake-cloud-files.js";
import { unsealItemField } from "../cloud-files/cloud-file-crypto.js";
import type { CloudFileDb } from "../cloud-files/cloud-file-store.service.js";
import type { GraphPage } from "./graph-client.js";
import type { DueCursor } from "./delta-cursor.service.js";
import type { PageContext } from "./m365-sync.service.js";
import {
  LibrarySourceMissingError,
  OneDriveSourceMissingError,
  createDriveLandingHandler,
  readDriveEntry,
} from "./drive-landing.service.js";

const USER = "user-1";
const OTHER = "user-2";
const LIB = "b!library-drive";
const OD = "b!onedrive-drive";

beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 6).toString("base64")));
afterEach(() => __setColumnCryptoKeyForTest(null));

/** A driveItem as `GET /drives/{id}/root/delta` returns one. */
function file(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `${id}.pdf`,
    size: 2048,
    webUrl: `https://contoso.sharepoint.com/sites/front/Shared%20Documents/${id}.pdf`,
    createdDateTime: "2026-09-01T10:00:00Z",
    lastModifiedDateTime: "2026-10-01T14:03:00Z",
    lastModifiedBy: { user: { displayName: "Sam Rivera", email: "sam@contoso.example" } },
    parentReference: { driveId: LIB, id: "folder-1", path: undefined },
    file: { mimeType: "application/pdf", hashes: { quickXorHash: "abc" } },
    ...over,
  };
}
const folder = (id: string, over: Record<string, unknown> = {}) =>
  file(id, { file: undefined, size: 987_654, folder: { childCount: 3 }, ...over });
const deleted = (id: string) => ({ id, deleted: { state: "deleted" }, parentReference: { driveId: LIB } });

describe("readDriveEntry — one entry of a drive delta page", () => {
  it("maps a file's facets onto the store's columns", () => {
    expect(readDriveEntry(file("f1"))).toEqual({
      kind: "item",
      externalId: "f1",
      parentExternalId: "folder-1",
      isFolder: false,
      name: "f1.pdf",
      webUrl: "https://contoso.sharepoint.com/sites/front/Shared%20Documents/f1.pdf",
      lastModifiedBy: "Sam Rivera",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      remoteCreatedAt: new Date("2026-09-01T10:00:00Z"),
      remoteModifiedAt: new Date("2026-10-01T14:03:00Z"),
    });
  });

  it("a folder has no MIME type and no size — its `size` is the cumulative size of what is inside", () => {
    // driveitem-delta: a folder's size is the sum of its contents. Nobody asks a
    // folder for its size, and a stored cumulative number would read as one.
    expect(readDriveEntry(folder("d1"))).toMatchObject({ kind: "item", isFolder: true, mimeType: null, sizeBytes: null });
  });

  it("a shortcut to a folder somebody shared is a folder to the person looking at their drive", () => {
    expect(readDriveEntry(file("s1", { file: undefined, remoteItem: { folder: { childCount: 1 } } }))).toMatchObject({
      kind: "item",
      isFolder: true,
    });
  });

  it("recognises a DELETED item by its facet, and needs nothing but its id", () => {
    // Graph often sends a deleted item with no name at all; it must still be a
    // delete, not a "skipped: no name" that leaves the file in search for ever.
    expect(readDriveEntry({ id: "gone", deleted: { state: "deleted" } })).toEqual({ kind: "deleted", externalId: "gone" });
    expect(readDriveEntry({ id: "gone", deleted: {} })).toEqual({ kind: "deleted", externalId: "gone" });
  });

  it("a deleted marker wins over everything else on the entry", () => {
    expect(readDriveEntry({ ...file("f1"), deleted: { state: "deleted" } })).toEqual({ kind: "deleted", externalId: "f1" });
  });

  it("the drive root is not a file", () => {
    expect(readDriveEntry({ id: "root-id", name: "root", root: {}, folder: { childCount: 4 } })).toEqual({ kind: "root" });
  });

  it("an item directly under the root keeps the root's id as its parent — the chain ends at a row nobody stored", () => {
    expect(readDriveEntry(file("f1", { parentReference: { driveId: LIB, id: "root-id" } }))).toMatchObject({ parentExternalId: "root-id" });
    expect(readDriveEntry(file("f1", { parentReference: undefined }))).toMatchObject({ parentExternalId: null });
  });

  it.each([
    ["not an object", "x", "not_an_object"],
    ["null", null, "not_an_object"],
    ["an array", [], "not_an_object"],
    ["no id", { name: "a.pdf" }, "no_id"],
    ["an empty id", { id: "  ", name: "a.pdf" }, "no_id"],
    ["a non-string id", { id: 7, name: "a.pdf" }, "no_id"],
    ["no name", { id: "f1" }, "no_name"],
    ["a blank name", { id: "f1", name: "   " }, "no_name"],
  ])("skips %s rather than storing a row nobody can read", (_label, raw, reason) => {
    expect(readDriveEntry(raw)).toEqual({ kind: "skipped", reason });
  });

  it.each([
    "http://contoso.sharepoint.com/x.pdf",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "not a url",
    "",
    null,
    42,
  ])("drops a webUrl that is not https: %j", (webUrl) => {
    // It ends up as a link a person clicks and a field a model reads.
    expect(readDriveEntry(file("f1", { webUrl }))).toMatchObject({ kind: "item", webUrl: null });
  });

  it("prefers the modifying person's name, then the application's, then nothing", () => {
    expect(readDriveEntry(file("f1", { lastModifiedBy: { user: { displayName: "Sam" }, application: { displayName: "Sync app" } } }))).toMatchObject({ lastModifiedBy: "Sam" });
    expect(readDriveEntry(file("f1", { lastModifiedBy: { application: { displayName: "Sync app" } } }))).toMatchObject({ lastModifiedBy: "Sync app" });
    expect(readDriveEntry(file("f1", { lastModifiedBy: { user: { email: "x@y.example" } } }))).toMatchObject({ lastModifiedBy: null });
    expect(readDriveEntry(file("f1", { lastModifiedBy: undefined }))).toMatchObject({ lastModifiedBy: null });
  });

  it("reads an unparseable timestamp or size as unknown, never as a wrong value", () => {
    expect(
      readDriveEntry(file("f1", { createdDateTime: "yesterday", lastModifiedDateTime: 5, size: "big" })),
    ).toMatchObject({ remoteCreatedAt: null, remoteModifiedAt: null, sizeBytes: null });
  });
});

// --- the handler -------------------------------------------------------------

function cursor(over: Partial<DueCursor> = {}): DueCursor {
  return {
    id: "c1",
    userId: USER,
    workload: "sharepoint",
    resourceId: LIB,
    deltaLink: null,
    resumeLink: null,
    state: "SYNCING",
    ...over,
  };
}
const filesCursor = (over: Partial<DueCursor> = {}) => cursor({ workload: "files", resourceId: "-", ...over });

function pageOf(items: Record<string, unknown>[]): GraphPage {
  return { items, links: { nextLink: null, deltaLink: null }, raw: {} } as unknown as GraphPage;
}

const FIRST = { fullEnumeration: true, isFirstPage: true, isLastPage: false } satisfies PageContext;
const MIDDLE = { fullEnumeration: true, isFirstPage: false, isLastPage: false } satisfies PageContext;
const LAST = { fullEnumeration: true, isFirstPage: false, isLastPage: true } satisfies PageContext;
const ONLY = { fullEnumeration: true, isFirstPage: true, isLastPage: true } satisfies PageContext;
const INCREMENTAL = { fullEnumeration: false, isFirstPage: true, isLastPage: true } satisfies PageContext;

/**
 * The person has registered their OneDrive and one SharePoint library — the state
 * discovery leaves them in, and the only one a page can land in. Either can be
 * left out to test a page that arrives with nowhere to go.
 */
function setup(opts: { oneDrive?: boolean; library?: boolean } = {}) {
  const db = makeFakeCloudFileDb();
  if (opts.oneDrive !== false) {
    db.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: OD, nameEnc: "dcv1:x" });
  }
  if (opts.library !== false) {
    db.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: LIB, nameEnc: "dcv1:x" });
  }
  const handle = createDriveLandingHandler(db as unknown as CloudFileDb);
  return { db, handle };
}

const stored = (db: FakeCloudFileDb, userId = USER, sourceId = LIB) =>
  db.items.filter((r) => r.userId === userId && r.sourceId === sourceId).map((r) => r.externalId as string).sort();

/** Land a previously-seen item the way an earlier run would have. */
const seed = (db: FakeCloudFileDb, externalId: string, over: Record<string, unknown> = {}) =>
  db.seedItem({ userId: USER, provider: "M365", sourceId: LIB, externalId, isFolder: false, nameEnc: "dcv1:x", ...over });

describe("createDriveLandingHandler — what lands, and where", () => {
  it("lands a SharePoint library's items under the cursor's drive id, with the names sealed", async () => {
    const { db, handle } = setup();
    await handle(cursor(), pageOf([file("f1", { name: "Smith, John — consent.pdf" })]), INCREMENTAL);

    expect(stored(db)).toEqual(["f1"]);
    const row = db.items[0]!;
    expect(row).toMatchObject({ userId: USER, provider: "M365", sourceId: LIB, parentExternalId: "folder-1", isFolder: false, mimeType: "application/pdf", sizeBytes: 2048n });
    expect(JSON.stringify([row.nameEnc, row.webUrlEnc, row.lastModifiedByEnc])).not.toContain("Smith");
    const ref = { provider: "M365", userId: USER, sourceId: LIB, externalId: "f1" } as const;
    expect(unsealItemField(ref, "name", row.nameEnc as string)).toBe("Smith, John — consent.pdf");
    expect(unsealItemField(ref, "lastModifiedBy", row.lastModifiedByEnc as string)).toBe("Sam Rivera");
  });

  it("lands OneDrive's items under the OneDrive SOURCE's drive id — the cursor's own resource is `-`", async () => {
    const { db, handle } = setup();
    await handle(filesCursor(), pageOf([file("o1", { parentReference: { driveId: "ignored-case-variant-of-the-id", id: "root" } })]), INCREMENTAL);
    expect(stored(db, USER, OD)).toEqual(["o1"]);
    expect(stored(db, USER, "-")).toEqual([]);
  });

  it("refuses OneDrive's pages until the OneDrive source is registered — the engine retries the run", async () => {
    const { db, handle } = setup({ oneDrive: false });
    await expect(handle(filesCursor(), pageOf([file("o1")]), INCREMENTAL)).rejects.toBeInstanceOf(OneDriveSourceMissingError);
    expect(db.items).toEqual([]);
  });

  describe("a library that is no longer registered lands nothing", () => {
    // A library is removed while a page of it is still being handled — the person
    // switched SharePoint off, or a complete discovery pruned it. The rows have no
    // foreign key, so without this check the page would write them under a source
    // that no longer exists, where nothing lists them and nothing deletes them: a
    // list the person was told was deleted, still there.
    it("refuses the page with a retryable error — the engine does not advance a cursor past a page that landed nowhere", async () => {
      const { db, handle } = setup({ library: false });
      await expect(handle(cursor(), pageOf([file("f1")]), INCREMENTAL)).rejects.toBeInstanceOf(LibrarySourceMissingError);
      expect(db.items).toEqual([]);
      expect(db.cloudFileItem.upsert).not.toHaveBeenCalled();
    });

    it("refuses a deletion and a sweep too — nothing at all is written for an unregistered library", async () => {
      const { db, handle } = setup({ library: false });
      seed(db, "leftover");
      await expect(handle(cursor(), pageOf([deleted("leftover")]), ONLY)).rejects.toBeInstanceOf(LibrarySourceMissingError);
      expect(db.cloudFileItem.updateMany).not.toHaveBeenCalled();
      expect(db.cloudFileItem.deleteMany).not.toHaveBeenCalled();
    });

    it("lands the first page and refuses the next when the library is removed in between", async () => {
      const { db, handle } = setup();
      await handle(cursor(), pageOf([file("f1")]), FIRST);
      db.sources.splice(0, db.sources.length, ...db.sources.filter((r) => r.sourceId !== LIB));
      await expect(handle(cursor(), pageOf([file("f2")]), MIDDLE)).rejects.toBeInstanceOf(LibrarySourceMissingError);
      expect(stored(db)).toEqual(["f1"]);
    });

    it("is not satisfied by a OneDrive that happens to have the library's id, nor by another person's library", async () => {
      const a = setup({ library: false });
      a.db.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: LIB, nameEnc: "dcv1:x" });
      await expect(a.handle(cursor(), pageOf([file("f1")]), INCREMENTAL)).rejects.toBeInstanceOf(LibrarySourceMissingError);

      const b = setup({ library: false });
      b.db.seedSource({ userId: OTHER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: LIB, nameEnc: "dcv1:x" });
      await expect(b.handle(cursor(), pageOf([file("f1")]), INCREMENTAL)).rejects.toBeInstanceOf(LibrarySourceMissingError);
      expect(b.db.items).toEqual([]);
    });

    it("does not make OneDrive's pages depend on a library, nor a library's depend on OneDrive", async () => {
      const od = setup({ library: false });
      await od.handle(filesCursor(), pageOf([file("o1")]), INCREMENTAL);
      expect(stored(od.db, USER, OD)).toEqual(["o1"]);

      const lib = setup({ oneDrive: false });
      await lib.handle(cursor(), pageOf([file("f1")]), INCREMENTAL);
      expect(stored(lib.db)).toEqual(["f1"]);
    });
  });

  it("lands OneDrive under THIS person's source, never another person's", async () => {
    const { db, handle } = setup();
    db.seedSource({ userId: OTHER, provider: "M365", kind: "ONEDRIVE", sourceId: "b!other-onedrive", nameEnc: "dcv1:x" });
    await handle(filesCursor({ userId: OTHER }), pageOf([file("o1")]), INCREMENTAL);
    expect(stored(db, OTHER, "b!other-onedrive")).toEqual(["o1"]);
    expect(stored(db, USER, OD)).toEqual([]);
  });

  it.each(["mail", "calendar", "contacts", "todo"])("does NOTHING for the %s workload — it is still counted and discarded", async (workload) => {
    const { db, handle } = setup();
    await handle(cursor({ workload, resourceId: "x" }), pageOf([file("f1"), deleted("f2")]), FIRST);
    expect(db.items).toEqual([]);
    expect(db.cloudFileItem.upsert).not.toHaveBeenCalled();
    expect(db.cloudFileItem.updateMany).not.toHaveBeenCalled();
    expect(db.cloudFileItem.deleteMany).not.toHaveBeenCalled();
  });

  it("does not store the drive root", async () => {
    const { db, handle } = setup();
    await handle(cursor(), pageOf([{ id: "root-id", name: "root", root: {}, folder: { childCount: 2 } }, file("f1")]), INCREMENTAL);
    expect(stored(db)).toEqual(["f1"]);
  });

  it("an item repeated in one page ends as its LAST mention says (renamed, then renamed again)", async () => {
    // driveitem-delta: an item can appear more than once in one enumeration.
    const { db, handle } = setup();
    await handle(cursor(), pageOf([file("f1", { name: "first.pdf" }), file("f1", { name: "second.pdf" })]), INCREMENTAL);
    expect(db.items).toHaveLength(1);
    const ref = { provider: "M365", userId: USER, sourceId: LIB, externalId: "f1" } as const;
    expect(unsealItemField(ref, "name", db.items[0]!.nameEnc as string)).toBe("second.pdf");
  });

  it("an item created and then deleted in one page ends deleted; deleted and then re-created ends present", async () => {
    const { db, handle } = setup();
    await handle(cursor(), pageOf([file("f1"), deleted("f1"), deleted("f2"), file("f2")]), INCREMENTAL);
    expect(stored(db)).toEqual(["f2"]);
  });

  it("a delete for something never stored is not an error", async () => {
    const { db, handle } = setup();
    await expect(handle(cursor(), pageOf([deleted("never-seen")]), INCREMENTAL)).resolves.toBeUndefined();
    expect(db.items).toEqual([]);
  });

  it("deleting a FOLDER removes what was inside it — the feed need not say so", async () => {
    const { db, handle } = setup();
    seed(db, "dir", { isFolder: true });
    seed(db, "child", { parentExternalId: "dir" });
    seed(db, "grandchild", { parentExternalId: "child" });
    seed(db, "sibling");
    await handle(cursor(), pageOf([deleted("dir")]), INCREMENTAL);
    expect(stored(db)).toEqual(["sibling"]);
  });

  it("a deleted folder takes nothing from another library or another person, whatever the ids", async () => {
    const { db, handle } = setup();
    seed(db, "dir", { isFolder: true });
    seed(db, "child", { parentExternalId: "dir" });
    seed(db, "dir", { sourceId: "b!other-lib", isFolder: true });
    seed(db, "child", { sourceId: "b!other-lib", parentExternalId: "dir" });
    seed(db, "dir", { userId: OTHER, isFolder: true });
    seed(db, "child", { userId: OTHER, parentExternalId: "dir" });
    await handle(cursor(), pageOf([deleted("dir")]), INCREMENTAL);
    expect(stored(db)).toEqual([]);
    expect(stored(db, USER, "b!other-lib")).toEqual(["child", "dir"]);
    expect(stored(db, OTHER)).toEqual(["child", "dir"]);
  });

  it("a malformed entry is skipped and counted — it does not fail the page of a hundred others", async () => {
    // A page that throws repeats for ever, and the other entries would never land.
    const { db, handle } = setup();
    await handle(cursor(), pageOf([file("f1"), { name: "no id" }, { id: "no-name" }, "junk" as unknown as Record<string, unknown>, file("f2")]), INCREMENTAL);
    expect(stored(db)).toEqual(["f1", "f2"]);
  });

  it("rethrows a storage failure — the engine must not advance the cursor past a page that was read and not stored", async () => {
    const { db, handle } = setup();
    db.cloudFileItem.upsert.mockRejectedValueOnce(new Error("disk full"));
    await expect(handle(cursor(), pageOf([file("f1")]), INCREMENTAL)).rejects.toThrow("disk full");
  });
});

describe("createDriveLandingHandler — the sweep of a full enumeration", () => {
  it("marks every row of the library on the FIRST page of a full enumeration, BEFORE it lands that page's items", async () => {
    // Mutation: land first, then mark, and the page's own items are marked and
    // swept at the end. The order is what the assertion below proves: a row the
    // page returns is un-marked, a row it does not is still marked.
    const { db, handle } = setup();
    seed(db, "kept");
    seed(db, "not-returned");
    await handle(cursor(), pageOf([file("kept")]), FIRST);
    expect(db.items.find((r) => r.externalId === "kept")!.sweepPending).toBe(false);
    expect(db.items.find((r) => r.externalId === "not-returned")!.sweepPending).toBe(true);
  });

  it("sweeps on the LAST page, after that page's items: what was not returned is gone", async () => {
    const { db, handle } = setup();
    seed(db, "stale");
    seed(db, "renamed");
    await handle(cursor(), pageOf([file("renamed", { name: "new.pdf" }), file("brand-new")]), ONLY);
    expect(stored(db)).toEqual(["brand-new", "renamed"]);
    expect(db.items.every((r) => r.sweepPending === false)).toBe(true);
  });

  it("sweeps on a last page that carries NO items — the delta-link-only page", async () => {
    // The final page of a long enumeration is often only the delta link. A sweep
    // that needed an item on the page to know which library it is sweeping would
    // never run, and every file deleted upstream would stay in search for ever.
    // (This is why the drive id comes from the registered source and the cursor.)
    const { db, handle } = setup();
    seed(db, "stale", { sourceId: OD });
    seed(db, "kept", { sourceId: OD });
    await handle(filesCursor(), pageOf([file("kept")]), FIRST);
    await handle(filesCursor(), pageOf([]), LAST);
    expect(stored(db, USER, OD)).toEqual(["kept"]);
  });

  it("a multi-page full enumeration: marks once, lands each page, sweeps once at the end", async () => {
    const { db, handle } = setup();
    for (const id of ["a", "b", "c", "stale"]) seed(db, id);
    await handle(cursor(), pageOf([file("a")]), FIRST);
    expect(stored(db)).toEqual(["a", "b", "c", "stale"]); // nothing is deleted before the end
    await handle(cursor(), pageOf([file("b")]), MIDDLE);
    expect(stored(db)).toEqual(["a", "b", "c", "stale"]);
    await handle(cursor(), pageOf([file("c")]), LAST);
    expect(stored(db)).toEqual(["a", "b", "c"]);
  });

  it("a tick that RESUMES a full enumeration does not re-mark — what an earlier tick already saw stays", async () => {
    // Tick one handled the first page(s): it marked, landed a and b, then ran out
    // of budget. Tick two resumes: its first page is NOT a first page. If it
    // marked again, a and b would be marked a second time, never seen again, and
    // swept — deleting files the library still holds.
    const { db, handle } = setup();
    for (const id of ["a", "b", "c", "stale"]) seed(db, id);
    await handle(cursor(), pageOf([file("a"), file("b")]), FIRST); // tick one
    await handle(cursor({ resumeLink: "https://graph.microsoft.com/v1.0/x?$skiptoken=p2" }), pageOf([file("c")]), LAST); // tick two
    expect(stored(db)).toEqual(["a", "b", "c"]);
  });

  it("an INCREMENTAL run never marks or sweeps — it deletes only what the feed says is deleted", async () => {
    // A sweep after an incremental run would delete every file the run did not
    // happen to mention: nearly all of them.
    const { db, handle } = setup();
    for (const id of ["a", "b", "c"]) seed(db, id);
    await handle(cursor({ deltaLink: "https://graph.microsoft.com/v1.0/drives/x/root/delta?token=t" }), pageOf([file("a", { name: "changed.pdf" }), deleted("c")]), INCREMENTAL);
    expect(stored(db)).toEqual(["a", "b"]);
    expect(db.cloudFileItem.updateMany).not.toHaveBeenCalled();
    expect(db.items.every((r) => r.sweepPending === false)).toBe(true);
  });

  it("marks and sweeps ONE library only — another library's rows, another person's and OneDrive's are untouched", async () => {
    // Mutation: drop `sourceId` or `userId` from the mark or the sweep and a
    // library's resync erases the person's other libraries, their OneDrive, or
    // somebody else's files.
    const { db, handle } = setup();
    seed(db, "mine");
    seed(db, "other-lib", { sourceId: "b!other-lib" });
    seed(db, "onedrive", { sourceId: OD });
    seed(db, "someone-elses", { userId: OTHER });
    await handle(cursor(), pageOf([]), ONLY);
    expect(stored(db)).toEqual([]);
    expect(stored(db, USER, "b!other-lib")).toEqual(["other-lib"]);
    expect(stored(db, USER, OD)).toEqual(["onedrive"]);
    expect(stored(db, OTHER)).toEqual(["someone-elses"]);
  });

  it("a full enumeration of OneDrive sweeps OneDrive's rows, not a SharePoint library's", async () => {
    const { db, handle } = setup();
    seed(db, "od-stale", { sourceId: OD });
    seed(db, "lib-file");
    await handle(filesCursor(), pageOf([]), ONLY);
    expect(stored(db, USER, OD)).toEqual([]);
    expect(stored(db)).toEqual(["lib-file"]);
  });

  it("is idempotent: re-running the same page (the engine does after a failure) lands the same state", async () => {
    const { db, handle } = setup();
    seed(db, "stale");
    const page = pageOf([file("a"), deleted("gone")]);
    await handle(cursor(), page, ONLY);
    const once = stored(db);
    await handle(cursor(), page, ONLY);
    expect(stored(db)).toEqual(once);
    expect(once).toEqual(["a"]);
  });

  it("a retried first page still ends right: a crash after the mark, then the whole run again", async () => {
    const { db, handle } = setup();
    for (const id of ["a", "stale"]) seed(db, id);
    db.cloudFileItem.upsert.mockRejectedValueOnce(new Error("crash mid-page"));
    await expect(handle(cursor(), pageOf([file("a")]), FIRST)).rejects.toThrow();
    // The cursor did not advance, so the engine repeats the run from the start:
    await handle(cursor(), pageOf([file("a")]), ONLY);
    expect(stored(db)).toEqual(["a"]);
  });
});

describe("createDriveLandingHandler — logging", () => {
  it("logs counts and reasons for what it could not land — never a file name", async () => {
    // A file name in a practice carries a patient's. The handler takes its logger
    // as a parameter so this can read exactly what would be written.
    const db = makeFakeCloudFileDb();
    db.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: LIB, nameEnc: "dcv1:x" });
    const warn = vi.fn();
    const handle = createDriveLandingHandler(db as unknown as CloudFileDb, { warn });

    await handle(
      cursor(),
      pageOf([
        { id: "f1", name: "   " },
        { id: "f2", name: "   ", extra: "Smith, John — consent.pdf" },
        { name: "orphan Smith.pdf" },
        file("ok", { name: "Smith, John — landed fine.pdf" }),
      ]),
      INCREMENTAL,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toEqual({ cursorId: "c1", workload: "sharepoint", skipped: { no_name: 2, no_id: 1 } });
    expect(JSON.stringify([fields, message])).not.toContain("Smith");
  });

  it("is silent when every entry landed", async () => {
    const db = makeFakeCloudFileDb();
    db.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: LIB, nameEnc: "dcv1:x" });
    const warn = vi.fn();
    await createDriveLandingHandler(db as unknown as CloudFileDb, { warn })(cursor(), pageOf([file("f1"), deleted("f2")]), INCREMENTAL);
    expect(warn).not.toHaveBeenCalled();
  });
});
