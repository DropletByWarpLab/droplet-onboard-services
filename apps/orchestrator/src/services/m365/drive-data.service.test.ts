/**
 * WARP-3538 — deleting what the sync engine landed, from the Microsoft 365 side.
 *
 * The cloud-file store holds copies of a person's file lists, and ADR-041 §4 says
 * deletion is a real operation. These are the three ways rows leave, and each is
 * a promise made to a person:
 *
 *   - switching SharePoint OFF: "Droplet deletes the list of SharePoint files it
 *     kept and stops reading them" — SharePoint's cursors, sources and items, and
 *     nothing of OneDrive's;
 *   - a COMPLETE discovery pruning libraries that are gone — only those, and only
 *     that person's;
 *   - disconnect / a leaver's deletion — everything the person has landed from
 *     Microsoft 365.
 *
 * Every filter is scoped to one `userId`: these tables have no foreign key, so
 * nothing but the `where` stops a purge deleting somebody else's rows. The
 * in-memory tables EVALUATE their arguments, so a dropped predicate shows up here
 * as a deleted row that should have survived.
 */
import { describe, it, expect } from "vitest";

import { makeFakeCloudFileDb } from "../../__tests__/helpers/fake-cloud-files.js";
import { makeFakeTable } from "../../__tests__/helpers/fake-table.js";
import {
  pruneSharePointLibraries,
  purgeM365FileDataForUser,
  purgeSharePointDataForUser,
  type DriveDataDb,
} from "./drive-data.service.js";

const USER = "user-1";
const OTHER = "user-2";

function seeded() {
  const cloud = makeFakeCloudFileDb();
  const cursors = makeFakeTable(() => ({}));
  const cursor = (userId: string, workload: string, resourceId: string) => cursors.seed({ userId, workload, resourceId });
  const library = (userId: string, sourceId: string) =>
    cloud.seedSource({ userId, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId, nameEnc: "dcv1:x" });
  const item = (userId: string, sourceId: string, externalId: string, provider = "M365") =>
    cloud.seedItem({ userId, provider, sourceId, externalId, isFolder: false, nameEnc: "dcv1:x" });

  cursor(USER, "sharepoint", "d1");
  cursor(USER, "sharepoint", "d2");
  cursor(USER, "files", "-");
  cursor(USER, "mail", "inbox");
  cursor(OTHER, "sharepoint", "d1");
  library(USER, "d1");
  library(USER, "d2");
  library(OTHER, "d1");
  cloud.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "od", nameEnc: "dcv1:x" });
  item(USER, "d1", "a");
  item(USER, "d2", "b");
  item(USER, "od", "c");
  item(OTHER, "d1", "d");
  item(OTHER, "od2", "e");

  const db = {
    cloudFileItem: cloud.cloudFileItem,
    cloudFileSource: cloud.cloudFileSource,
    m365DeltaCursor: cursors.delegate,
  } as unknown as DriveDataDb;
  return {
    db,
    cloud,
    cursors: cursors.rows,
    mine: () => cursors.rows.filter((r) => r.userId === USER).map((r) => `${r.workload}:${r.resourceId}`).sort(),
    items: (userId: string) => cloud.items.filter((r) => r.userId === userId).map((r) => r.externalId as string).sort(),
    sources: (userId: string) => cloud.sources.filter((r) => r.userId === userId).map((r) => r.sourceId as string).sort(),
  };
}

describe("purgeSharePointDataForUser — switching SharePoint off", () => {
  it("deletes the person's SharePoint cursors, sources and items, and reports how many", async () => {
    const t = seeded();
    expect(await purgeSharePointDataForUser(t.db, USER)).toEqual({ libraries: 2, cursors: 2, sources: 2, items: 2 });
    expect(t.mine()).toEqual(["files:-", "mail:inbox"]);
    expect(t.sources(USER)).toEqual(["od"]);
    expect(t.items(USER)).toEqual(["c"]);
  });

  it("leaves OneDrive and every other workload of the person alone", async () => {
    // Mutation: drop `workload: "sharepoint"` from the cursor filter, or make the
    // library list include OneDrive's source, and turning SharePoint off also
    // erases the person's OneDrive list and mail cursors — which the
    // confirmation dialog never said.
    const t = seeded();
    await purgeSharePointDataForUser(t.db, USER);
    expect(t.mine()).toContain("files:-");
    expect(t.mine()).toContain("mail:inbox");
    expect(t.sources(USER)).toContain("od");
    expect(t.items(USER)).toContain("c");
  });

  it("never touches another person's rows", async () => {
    // Mutation: drop `userId` from any of the filters and a person's switch
    // deletes everybody's SharePoint data.
    const t = seeded();
    await purgeSharePointDataForUser(t.db, USER);
    expect(t.cursors.filter((r) => r.userId === OTHER)).toHaveLength(1);
    expect(t.sources(OTHER)).toEqual(["d1"]);
    expect(t.items(OTHER)).toEqual(["d", "e"]);
  });

  it("finds a library by its CURSOR when no source row names it — and by its row when no cursor reads it", async () => {
    // A crash between the two writes of a discovery can leave either one alone;
    // removing "the libraries" from one list would never find the other.
    const t = seeded();
    t.cursors.push({ id: "x", userId: USER, workload: "sharepoint", resourceId: "orphan-cursor" });
    t.cloud.seedItem({ userId: USER, provider: "M365", sourceId: "orphan-cursor", externalId: "oc1", isFolder: false, nameEnc: "dcv1:x" });
    t.cloud.seedSource({ userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: "orphan-row", nameEnc: "dcv1:x" });
    t.cloud.seedItem({ userId: USER, provider: "M365", sourceId: "orphan-row", externalId: "or1", isFolder: false, nameEnc: "dcv1:x" });

    // Two libraries, found by two different lists, are TWO libraries — not the
    // one a count of source rows would report.
    expect(await purgeSharePointDataForUser(t.db, USER)).toMatchObject({ libraries: 4, sources: 3, cursors: 3 });
    expect(t.items(USER)).toEqual(["c"]);
    expect(t.sources(USER)).toEqual(["od"]);
    expect(t.mine().filter((c) => c.startsWith("sharepoint:"))).toEqual([]);
  });

  it("is a clean no-op for a person with nothing", async () => {
    const t = seeded();
    expect(await purgeSharePointDataForUser(t.db, "nobody")).toEqual({ libraries: 0, cursors: 0, sources: 0, items: 0 });
  });
});

describe("pruneSharePointLibraries — a complete discovery no longer sees them", () => {
  it("deletes the cursors, sources and items of every library NOT in the kept set — that person's, SharePoint's only", async () => {
    const t = seeded();
    expect(await pruneSharePointLibraries(t.db, USER, ["d1"])).toEqual({ libraries: 1, cursors: 1, sources: 1, items: 1 });

    expect(t.mine().filter((c) => c.startsWith("sharepoint:"))).toEqual(["sharepoint:d1"]);
    expect(t.sources(USER)).toEqual(["d1", "od"]);
    expect(t.items(USER)).toEqual(["a", "c"]);
    // OneDrive's `files` cursor, source and rows are not "a library that is gone".
    expect(t.mine()).toContain("files:-");
    // And nobody else's.
    expect(t.cursors.filter((r) => r.userId === OTHER)).toHaveLength(1);
    expect(t.items(OTHER)).toEqual(["d", "e"]);
  });

  it("an empty kept set prunes every SharePoint library the person has", async () => {
    // The CALLER decides whether an empty answer is believable (it does not trust
    // one while libraries are registered); this function does what it is told.
    const t = seeded();
    await pruneSharePointLibraries(t.db, USER, []);
    expect(t.sources(USER)).toEqual(["od"]);
    expect(t.mine().filter((c) => c.startsWith("sharepoint:"))).toEqual([]);
  });

  it("deletes nothing at all when everything registered is kept — and asks the database for no deletes", async () => {
    const t = seeded();
    expect(await pruneSharePointLibraries(t.db, USER, ["d1", "d2", "never-registered"])).toEqual({ libraries: 0, cursors: 0, sources: 0, items: 0 });
    expect(t.items(USER)).toEqual(["a", "b", "c"]);
    expect(t.cloud.cloudFileItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe("purgeM365FileDataForUser — disconnect and a leaver's deletion", () => {
  it("deletes every landed item and source the person has from Microsoft 365, OneDrive included", async () => {
    const t = seeded();
    expect(await purgeM365FileDataForUser(t.db, USER)).toEqual({ items: 3, sources: 3 });
    expect(t.items(USER)).toEqual([]);
    expect(t.sources(USER)).toEqual([]);
  });

  it("does not touch cursors — those have their own purge, and the order between them matters", async () => {
    const t = seeded();
    await purgeM365FileDataForUser(t.db, USER);
    expect(t.mine()).toHaveLength(4);
  });

  it("never touches another person's rows", async () => {
    // Mutation: drop `userId` and a disconnect wipes the whole box's file lists.
    const t = seeded();
    await purgeM365FileDataForUser(t.db, USER);
    expect(t.items(OTHER)).toEqual(["d", "e"]);
    expect(t.sources(OTHER)).toEqual(["d1"]);
  });

  it("leaves the person's files in ANOTHER cloud alone", async () => {
    // Google Drive and Dropbox land into the same tables, and each is removed by
    // its own disconnect. (A second provider is not in the enum yet; the row is
    // seeded under the name it will have.)
    const t = seeded();
    t.cloud.seedItem({ userId: USER, provider: "GOOGLE", sourceId: "g1", externalId: "gi", isFolder: false, nameEnc: "dcv1:x" });
    await purgeM365FileDataForUser(t.db, USER);
    expect(t.items(USER)).toEqual(["gi"]);
  });
});
