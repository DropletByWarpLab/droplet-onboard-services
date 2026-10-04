/**
 * WARP-3538 — finding a person's own files across every connected cloud.
 *
 * What these defend:
 *   - a person finds ONLY their own files, whatever the names;
 *   - names are matched in memory (they are sealed at rest), but everything the
 *     database CAN filter on is pushed into the query, so a narrow search over a
 *     large store reads little;
 *   - the bound: a candidate set too large to open is REFUSED, never answered
 *     with a partial result that looks complete;
 *   - what a result says — where a file lives, its folder path, its link — is
 *     built from the store and never guessed: an unknown parent ends the path, an
 *     unreadable row is left out and counted.
 *
 * The store is the real one over tables that evaluate their arguments
 * (`helpers/fake-cloud-files.ts`), so the rows here are written the way the
 * landing handler writes them: names sealed, ids and times in the clear.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { makeFakeCloudFileDb, type FakeCloudFileDb } from "../../__tests__/helpers/fake-cloud-files.js";
import {
  upsertItem,
  upsertSource,
  type CloudFileDb,
  type CloudFileItemInput,
} from "./cloud-file-store.service.js";
import {
  CloudFileSearchTooLargeError,
  MAX_SEARCH_CANDIDATES,
  searchCloudFiles,
  type CloudFileSearchParams,
} from "./cloud-file-search.service.js";

const USER = "user-1";
const OTHER = "user-2";
const OD = "b!onedrive";
const LIB = "b!library-front-desk";
const LIB2 = "b!library-billing";

beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 8).toString("base64")));
afterEach(() => __setColumnCryptoKeyForTest(null));

const asDb = (db: FakeCloudFileDb) => db as unknown as CloudFileDb;

const t = (iso: string) => new Date(iso);

async function item(db: FakeCloudFileDb, over: Partial<CloudFileItemInput> & { externalId: string; name: string }) {
  await upsertItem(asDb(db), {
    userId: USER,
    provider: "M365",
    sourceId: LIB,
    parentExternalId: null,
    isFolder: false,
    webUrl: `https://contoso.sharepoint.com/${over.externalId}`,
    lastModifiedBy: "Sam Rivera",
    mimeType: "application/pdf",
    sizeBytes: 100,
    remoteCreatedAt: t("2026-01-01T00:00:00Z"),
    remoteModifiedAt: t("2026-10-01T00:00:00Z"),
    ...over,
  });
}

async function world() {
  const db = makeFakeCloudFileDb();
  await upsertSource(asDb(db), { userId: USER, provider: "M365", sourceId: OD, kind: "ONEDRIVE", siteId: null, siteName: null, name: "OneDrive", webUrl: null, followed: false });
  await upsertSource(asDb(db), { userId: USER, provider: "M365", sourceId: LIB, kind: "SHAREPOINT_LIBRARY", siteId: "s1", siteName: "Front desk", name: "Documents", webUrl: null, followed: true });
  await upsertSource(asDb(db), { userId: USER, provider: "M365", sourceId: LIB2, kind: "SHAREPOINT_LIBRARY", siteId: "s2", siteName: "Billing", name: "Invoices", webUrl: null, followed: false });
  return db;
}

const search = (db: FakeCloudFileDb, over: Partial<CloudFileSearchParams> = {}) =>
  searchCloudFiles(asDb(db), { userId: USER, limit: 25, ...over });
const names = (r: { items: Array<{ name: string }> }) => r.items.map((i) => i.name);

describe("searchCloudFiles — what a result says", () => {
  it("returns a file's name, where it lives, its link, its modifier, its size and its time", async () => {
    const db = await world();
    await item(db, {
      externalId: "f1",
      name: "Consent form — Smith, John.pdf",
      parentExternalId: "dir-forms",
      webUrl: "https://contoso.sharepoint.com/sites/front/Forms/Consent.pdf",
      lastModifiedBy: "Sam Rivera",
      sizeBytes: 48211,
      remoteModifiedAt: t("2026-10-01T14:03:00Z"),
    });
    await item(db, { externalId: "dir-forms", name: "Forms", isFolder: true, sizeBytes: null, mimeType: null });

    const result = await search(db);

    expect(result.total).toBe(2);
    expect(result.items.find((i) => i.name === "Consent form — Smith, John.pdf")).toEqual({
      name: "Consent form — Smith, John.pdf",
      isFolder: false,
      provider: "m365",
      location: "Front desk › Documents",
      path: "Forms",
      webUrl: "https://contoso.sharepoint.com/sites/front/Forms/Consent.pdf",
      lastModifiedAt: "2026-10-01T14:03:00.000Z",
      lastModifiedBy: "Sam Rivera",
      sizeBytes: 48211,
    });
  });

  it("says OneDrive for a OneDrive file, and `<site> › <library>` for a SharePoint library's", async () => {
    const db = await world();
    await item(db, { externalId: "o1", name: "mine.docx", sourceId: OD });
    await item(db, { externalId: "s1", name: "shared.docx", sourceId: LIB2 });
    const result = await search(db);
    expect(Object.fromEntries(result.items.map((i) => [i.name, i.location]))).toEqual({
      "mine.docx": "OneDrive",
      "shared.docx": "Billing › Invoices",
    });
  });

  it("falls back to the provider's own name for a file whose source row is not there yet — a file still shows up", async () => {
    // A crash between discovery's two writes, or a OneDrive not yet registered,
    // is a transient state; a person's file must not vanish from search for it.
    const db = await world();
    await item(db, { externalId: "x1", name: "orphan.pdf", sourceId: "b!no-such-source" });
    expect((await search(db)).items[0]).toMatchObject({ name: "orphan.pdf", location: "Microsoft 365" });
  });

  it("is a number for sizeBytes, null for a folder and for anything a double cannot hold exactly", async () => {
    const db = await world();
    await item(db, { externalId: "f1", name: "big.iso", sizeBytes: 5_000_000_000 });
    await item(db, { externalId: "d1", name: "dir", isFolder: true, sizeBytes: null });
    await item(db, { externalId: "huge", name: "huge.bin" });
    db.items.find((r) => r.externalId === "huge")!.sizeBytes = 2n ** 60n; // past 2^53
    const bySize = Object.fromEntries((await search(db)).items.map((i) => [i.name, i.sizeBytes]));
    expect(bySize).toEqual({ "big.iso": 5_000_000_000, dir: null, "huge.bin": null });
    expect((await search(db, { query: "dir" })).items[0]).toMatchObject({ name: "dir", isFolder: true });
  });

  it("shows a link that cannot be opened as null, and keeps the hit", async () => {
    const db = await world();
    await item(db, { externalId: "f1", name: "a.pdf" });
    db.items[0]!.webUrlEnc = "dcv1:not-a-real-blob";
    expect((await search(db)).items[0]).toMatchObject({ name: "a.pdf", webUrl: null });
  });
});

describe("searchCloudFiles — order and limit", () => {
  it("is newest first, a file with no modified time last, and stable for equal times", async () => {
    const db = await world();
    await item(db, { externalId: "old", name: "old.pdf", remoteModifiedAt: t("2026-01-01T00:00:00Z") });
    await item(db, { externalId: "new", name: "new.pdf", remoteModifiedAt: t("2026-10-03T00:00:00Z") });
    await item(db, { externalId: "unknown", name: "unknown.pdf", remoteModifiedAt: null });
    await item(db, { externalId: "tie-b", name: "tie-b.pdf", remoteModifiedAt: t("2026-06-01T00:00:00Z") });
    await item(db, { externalId: "tie-a", name: "tie-a.pdf", remoteModifiedAt: t("2026-06-01T00:00:00Z") });
    expect(names(await search(db))).toEqual(["new.pdf", "tie-a.pdf", "tie-b.pdf", "old.pdf", "unknown.pdf"]);
  });

  it("returns at most `limit` and reports how many matched in all", async () => {
    const db = await world();
    for (let i = 0; i < 7; i += 1) {
      await item(db, { externalId: `f${i}`, name: `report ${i}.pdf`, remoteModifiedAt: t(`2026-10-0${i + 1}T00:00:00Z`) });
    }
    const result = await search(db, { limit: 3 });
    expect(names(result)).toEqual(["report 6.pdf", "report 5.pdf", "report 4.pdf"]);
    expect(result.total).toBe(7);
  });
});

describe("searchCloudFiles — the name filter", () => {
  it("matches ignoring case, and every word must appear, in any order", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "Consent_Form 2026 (signed).pdf" });
    await item(db, { externalId: "b", name: "Form for consent.docx" });
    await item(db, { externalId: "c", name: "Consent summary.pdf" });
    await item(db, { externalId: "d", name: "Invoice.pdf" });
    expect(names(await search(db, { query: "CONSENT form" })).sort()).toEqual(["Consent_Form 2026 (signed).pdf", "Form for consent.docx"]);
  });

  it("matches the NAME only — not the location, the link or the person who changed it", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "plain.pdf", webUrl: "https://contoso.sharepoint.com/sites/consent/plain.pdf", lastModifiedBy: "Consent Officer" });
    expect((await search(db, { query: "consent" })).items).toEqual([]);
    expect((await search(db, { query: "documents" })).items).toEqual([]);
  });

  it("an empty or blank query is no filter", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "a.pdf" });
    expect((await search(db, { query: "   " })).total).toBe(1);
    expect((await search(db, { query: "" })).total).toBe(1);
  });

  it("finds a folder by its name too", async () => {
    const db = await world();
    await item(db, { externalId: "d", name: "Patient forms", isFolder: true, sizeBytes: null });
    expect((await search(db, { query: "patient" })).items[0]).toMatchObject({ name: "Patient forms", isFolder: true });
  });
});

describe("searchCloudFiles — whose files, which cloud, where, and since when", () => {
  it("returns only the caller's own files, whatever the other person's are called", async () => {
    // Mutation: drop `userId` from the item query (or the source query) and a
    // person finds a colleague's files.
    const db = await world();
    await item(db, { externalId: "mine", name: "budget.xlsx" });
    await item(db, { externalId: "theirs", name: "budget.xlsx", userId: OTHER });
    await item(db, { externalId: "theirs2", name: "budget plan.xlsx", userId: OTHER, sourceId: "b!theirs" });

    const result = await search(db, { query: "budget" });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(await searchCloudFiles(asDb(db), { userId: "nobody", limit: 25 })).toEqual({ items: [], total: 0, unreadable: 0 });
  });

  it("never lets another person's source name label a file", async () => {
    // Sources are read for the caller only: another person's library, with the
    // same drive id, must not decide where this person's file is said to live.
    const db = await world();
    await upsertSource(asDb(db), { userId: OTHER, provider: "M365", sourceId: LIB, kind: "SHAREPOINT_LIBRARY", siteId: "s", siteName: "Secret HR", name: "Salaries", webUrl: null, followed: false });
    await item(db, { externalId: "f1", name: "a.pdf" });
    expect((await search(db)).items[0]!.location).toBe("Front desk › Documents");
  });

  it("filters by provider", async () => {
    const db = await world();
    await item(db, { externalId: "m", name: "ms.pdf" });
    db.seedItem({ userId: USER, provider: "GOOGLE", sourceId: "g1", externalId: "g", isFolder: false, nameEnc: "dcv1:x" });
    expect(names(await search(db, { provider: "M365" }))).toEqual(["ms.pdf"]);
  });

  it("narrows by location — case-insensitive, a substring of where the file lives", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "a.pdf", sourceId: OD });
    await item(db, { externalId: "b", name: "b.pdf", sourceId: LIB });
    await item(db, { externalId: "c", name: "c.pdf", sourceId: LIB2 });
    expect(names(await search(db, { source: "ONEDRIVE" }))).toEqual(["a.pdf"]);
    expect(names(await search(db, { source: "front desk" }))).toEqual(["b.pdf"]);
    expect(names(await search(db, { source: "invoices" }))).toEqual(["c.pdf"]);
    expect(names(await search(db, { source: " › " })).sort()).toEqual(["b.pdf", "c.pdf"]);
    expect(names(await search(db, { source: "no such place" }))).toEqual([]);
  });

  it("pushes the location into the query: only those sources' rows are read", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "a.pdf", sourceId: OD });
    await item(db, { externalId: "b", name: "b.pdf", sourceId: LIB });
    await search(db, { source: "front desk" });
    // The first (and here only) read of items is the candidate query.
    expect(db.cloudFileItem.findMany.mock.calls[0]![0]!.where).toMatchObject({ userId: USER, sourceId: { in: [LIB] } });
  });

  it("a location that matches nothing reads no files at all", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "a.pdf" });
    db.cloudFileItem.findMany.mockClear();
    expect((await search(db, { source: "nowhere" })).items).toEqual([]);
    expect(db.cloudFileItem.findMany).not.toHaveBeenCalled();
  });

  it("a location filter cannot match a file whose source is not known", async () => {
    // It is a statement about WHERE a file lives; for a file whose source is
    // unknown there is nothing to say it is there.
    const db = await world();
    await item(db, { externalId: "x", name: "orphan.pdf", sourceId: "b!no-such-source" });
    expect((await search(db, { source: "microsoft 365" })).items).toEqual([]);
  });

  it("modifiedSince keeps files changed at or after the moment, and drops a file with no known modified time", async () => {
    const db = await world();
    await item(db, { externalId: "before", name: "before.pdf", remoteModifiedAt: t("2026-09-30T23:59:59Z") });
    await item(db, { externalId: "at", name: "at.pdf", remoteModifiedAt: t("2026-10-01T00:00:00Z") });
    await item(db, { externalId: "after", name: "after.pdf", remoteModifiedAt: t("2026-10-02T00:00:00Z") });
    await item(db, { externalId: "unknown", name: "unknown.pdf", remoteModifiedAt: null });
    const result = await search(db, { modifiedSince: t("2026-10-01T00:00:00Z") });
    expect(names(result)).toEqual(["after.pdf", "at.pdf"]);
    // …and it is pushed into the query, not applied after reading everything.
    expect(db.cloudFileItem.findMany.mock.calls[0]![0]!.where).toMatchObject({ remoteModifiedAt: { gte: t("2026-10-01T00:00:00Z") } });
  });
});

describe("searchCloudFiles — the bound", () => {
  it("REFUSES a candidate set past the bound — never a partial answer that looks complete", async () => {
    // Mutation: drop the check (or the `+ 1`) and a store of 50,001 files is
    // answered from the first 50,000 the database returned — newest-first looks
    // right, and the best match may be the one that was cut.
    const db = await world();
    for (let i = 0; i <= MAX_SEARCH_CANDIDATES; i += 1) {
      db.seedItem({ userId: USER, provider: "M365", sourceId: LIB, externalId: `f${i}`, isFolder: false, nameEnc: "dcv1:x" });
    }
    await expect(search(db, { query: "anything" })).rejects.toBeInstanceOf(CloudFileSearchTooLargeError);
    await expect(search(db)).rejects.toThrow(/Narrow the search/);
  });

  it("answers a candidate set exactly at the bound, and refuses one row more", async () => {
    const db = await world();
    for (let i = 0; i < MAX_SEARCH_CANDIDATES - 1; i += 1) {
      db.seedItem({ userId: USER, provider: "M365", sourceId: LIB, externalId: `f${i}`, isFolder: false, nameEnc: "dcv1:x", remoteModifiedAt: t("2026-01-01T00:00:00Z") });
    }
    await item(db, { externalId: "real", name: "the real one.pdf", remoteModifiedAt: t("2026-10-01T00:00:00Z") });
    // Exactly MAX_SEARCH_CANDIDATES rows. (No name filter: only the answer's own
    // name is opened, so the placeholder rows behind it are never touched.)
    expect(names(await search(db, { limit: 1 }))).toEqual(["the real one.pdf"]);

    db.seedItem({ userId: USER, provider: "M365", sourceId: LIB, externalId: "one-more", isFolder: false, nameEnc: "dcv1:x" });
    await expect(search(db, { limit: 1 })).rejects.toBeInstanceOf(CloudFileSearchTooLargeError);
  });

  it("narrowing by a clear column brings a store under the bound — location and date are pushed into the query", async () => {
    const db = await world();
    for (let i = 0; i <= MAX_SEARCH_CANDIDATES; i += 1) {
      db.seedItem({ userId: USER, provider: "M365", sourceId: LIB, externalId: `f${i}`, isFolder: false, nameEnc: "dcv1:x", remoteModifiedAt: t("2020-01-01T00:00:00Z") });
    }
    await item(db, { externalId: "recent", name: "recent.pdf", sourceId: LIB2, remoteModifiedAt: t("2026-10-01T00:00:00Z") });
    expect(names(await search(db, { source: "invoices" }))).toEqual(["recent.pdf"]);
    expect(names(await search(db, { modifiedSince: t("2026-01-01T00:00:00Z") }))).toEqual(["recent.pdf"]);
  });

  it("without a name filter opens only the names of the answer — a million unreadable rows behind it cost nothing", async () => {
    const db = await world();
    await item(db, { externalId: "recent", name: "recent.pdf", remoteModifiedAt: t("2026-10-01T00:00:00Z") });
    for (let i = 0; i < 500; i += 1) {
      db.seedItem({ userId: USER, provider: "M365", sourceId: LIB, externalId: `old${i}`, isFolder: false, nameEnc: "dcv1:garbage", remoteModifiedAt: t("2020-01-01T00:00:00Z") });
    }
    const result = await search(db, { limit: 1 });
    expect(names(result)).toEqual(["recent.pdf"]);
    expect(result.unreadable).toBe(0);
    expect(result.total).toBe(501);
  });
});

describe("searchCloudFiles — the folder path", () => {
  async function tree() {
    const db = await world();
    await item(db, { externalId: "forms", name: "Forms", isFolder: true, parentExternalId: "root-id", sizeBytes: null });
    await item(db, { externalId: "y2026", name: "2026", isFolder: true, parentExternalId: "forms", sizeBytes: null });
    await item(db, { externalId: "f1", name: "consent.pdf", parentExternalId: "y2026" });
    await item(db, { externalId: "top", name: "top-level.pdf", parentExternalId: "root-id" });
    return db;
  }
  const pathOf = async (db: FakeCloudFileDb, query: string) => (await search(db, { query })).items[0]!.path;

  it("is the containing folders from the top down, root excluded", async () => {
    const db = await tree();
    expect(await pathOf(db, "consent")).toBe("Forms/2026");
    expect(await pathOf(db, "Forms")).toBe("");
  });

  it("is empty for a file directly under the root — the root itself is never stored", async () => {
    expect(await pathOf(await tree(), "top-level")).toBe("");
  });

  it("is empty for a file with no parent at all", async () => {
    const db = await world();
    await item(db, { externalId: "f", name: "loose.pdf", parentExternalId: null });
    expect(await pathOf(db, "loose")).toBe("");
  });

  it("ends the chain at the first parent that is not stored — best effort, never a guess", async () => {
    const db = await world();
    await item(db, { externalId: "f", name: "deep.pdf", parentExternalId: "missing-folder" });
    expect(await pathOf(db, "deep")).toBe("");
    await item(db, { externalId: "y", name: "Known", isFolder: true, parentExternalId: "missing-folder" });
    await item(db, { externalId: "g", name: "partial.pdf", parentExternalId: "y" });
    expect(await pathOf(db, "partial")).toBe("Known");
  });

  it("does not take a folder of the same id from another library", async () => {
    // An item id is unique within a container, not across them.
    const db = await world();
    await item(db, { externalId: "shared-id", name: "Other library folder", isFolder: true, sourceId: LIB2 });
    await item(db, { externalId: "f", name: "here.pdf", parentExternalId: "shared-id", sourceId: LIB });
    expect(await pathOf(db, "here")).toBe("");
  });

  it("does not take a folder of the same id from another person", async () => {
    const db = await world();
    await item(db, { externalId: "shared-id", name: "Their private folder", isFolder: true, userId: OTHER });
    await item(db, { externalId: "f", name: "here.pdf", parentExternalId: "shared-id" });
    expect(await pathOf(db, "here")).toBe("");
  });

  it("ends on a malformed parent loop instead of spinning", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "A", isFolder: true, parentExternalId: "b" });
    await item(db, { externalId: "b", name: "B", isFolder: true, parentExternalId: "a" });
    await item(db, { externalId: "f", name: "looped.pdf", parentExternalId: "a" });
    // Each folder once, then the loop is recognised and the chain ends.
    expect(await pathOf(db, "looped")).toBe("B/A");
  });

  it("resolves the answer's rows only, a level per query — not the whole store", async () => {
    const db = await tree();
    for (let i = 0; i < 300; i += 1) await item(db, { externalId: `noise${i}`, name: `noise ${i}.pdf`, parentExternalId: "forms", remoteModifiedAt: t("2020-01-01T00:00:00Z") });
    db.cloudFileItem.findMany.mockClear();
    await search(db, { limit: 1 });
    // One query for the candidates, then at most one per level of the one answer.
    expect(db.cloudFileItem.findMany.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("searchCloudFiles — rows that cannot be opened", () => {
  it("leaves out what a rotated device key made unreadable, counts it, and never throws", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "a.pdf" });
    await item(db, { externalId: "b", name: "b.pdf" });
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64")); // a factory reset regenerated the key
    await upsertItem(asDb(db), {
      userId: USER, provider: "M365", sourceId: LIB, externalId: "c", parentExternalId: null, isFolder: false, name: "c.pdf",
      webUrl: null, lastModifiedBy: null, mimeType: null, sizeBytes: null, remoteCreatedAt: null, remoteModifiedAt: t("2026-10-02T00:00:00Z"),
    });

    const result = await search(db, { query: "pdf" });
    expect(names(result)).toEqual(["c.pdf"]);
    expect(result.unreadable).toBe(2);
    expect(result.total).toBe(1);
  });

  it("a source whose name cannot be opened is not shown as anything it is not", async () => {
    const db = await world();
    await item(db, { externalId: "a", name: "a.pdf" });
    db.sources.find((s) => s.sourceId === LIB)!.nameEnc = "dcv1:garbage";
    expect((await search(db)).items[0]!.location).toBe("Microsoft 365");
  });
});
