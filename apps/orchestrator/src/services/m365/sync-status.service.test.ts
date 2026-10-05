/**
 * WARP-3538 — what `GET /api/m365/sync-status` says about a person's Microsoft
 * 365 reading: per workload, their OneDrive, and each SharePoint library.
 *
 * The status is built from three places that know different things — the CURSORS
 * (is it being read, when did it last finish, is it failing), the cloud-file
 * SOURCES (what a library is called, sealed at rest) and the landed ITEMS (how
 * many files). The tests pin the joins and, above all, what must NOT reach the
 * card: another person's rows, a delta link, a name that could not be opened
 * passed off as another, and a library the person switched off.
 *
 * The tables are in-memory and EVALUATE their arguments; the names are sealed
 * with the real column crypto, so a name that comes back readable was genuinely
 * opened server-side.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { makeFakeM365World } from "../../__tests__/helpers/fake-m365-world.js";
import type { Row } from "../../__tests__/helpers/fake-table.js";
import { sealSourceField } from "../cloud-files/cloud-file-crypto.js";
import { getSyncStatus, type SyncStatusDb } from "./sync-status.service.js";

const USER = "user-1";
const OTHER = "user-2";
const BASE =
  "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All";
const WITH_SITES = `${BASE} Sites.Read.All`;
const T1 = new Date("2026-10-04T10:00:00.000Z");
const T2 = new Date("2026-10-04T11:30:00.000Z");

beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 6).toString("base64")));
afterEach(() => __setColumnCryptoKeyForTest(null));

/** The world, with sources whose names are really sealed so a name that comes back was opened. */
function world(connection: Row | null = null) {
  const w = makeFakeM365World(connection ? [connection] : []);
  const ref = (userId: string, sourceId: string) => ({ provider: "M365" as const, userId, sourceId });
  return {
    ...w,
    db: w.prisma as unknown as SyncStatusDb,
    oneDrive: (userId: string, sourceId: string, name = "OneDrive") =>
      w.oneDrive(userId, sourceId, { nameEnc: sealSourceField(ref(userId, sourceId), "name", name) }),
    library: (userId: string, sourceId: string, site: string, name: string, over: Row = {}) =>
      w.library(userId, sourceId, {
        siteId: `site-of-${sourceId}`,
        siteNameEnc: sealSourceField(ref(userId, sourceId), "siteName", site),
        nameEnc: sealSourceField(ref(userId, sourceId), "name", name),
        webUrlEnc: sealSourceField(ref(userId, sourceId), "webUrl", `https://contoso.sharepoint.com/sites/${sourceId}`),
        followed: false,
        ...over,
      }),
    file: (userId: string, sourceId: string, externalId: string, isFolder = false) =>
      w.item(userId, sourceId, externalId, { isFolder }),
  };
}

const connected = (over: Row = {}): Row => ({
  userId: USER,
  state: "CONNECTED",
  grantedScopes: BASE,
  sharePointEnabled: false,
  sharePointLibrariesCapped: 0,
  ...over,
});

describe("getSyncStatus — nothing yet", () => {
  it("is an honest empty answer for a person with no connection and no cursors", async () => {
    expect(await getSyncStatus(world().db, USER)).toEqual({
      workloads: [],
      oneDrive: null,
      sharePoint: { enabled: false, granted: false, needsConsent: false, capped: 0, libraries: [] },
    });
  });
});

describe("getSyncStatus — workloads", () => {
  it("counts each workload's cursors by state, newest read time, in the engine's workload order", async () => {
    const w = world(connected());
    w.cursor(USER, "files", "-", { lastSyncedAt: T1 });
    w.cursor(USER, "mail", "inbox", { lastSyncedAt: T1 });
    w.cursor(USER, "mail", "sent", { state: "BACKOFF", lastSyncedAt: T2 });
    w.cursor(USER, "mail", "drafts", { state: "FAILED" });
    w.cursor(USER, "mail", "archive", { state: "SYNCING" });
    w.cursor(USER, "calendar", "-", { state: "RESYNC_REQUIRED" });

    const status = await getSyncStatus(w.db, USER);
    expect(status.workloads).toEqual([
      // mail, calendar, contacts, files, todo, sharepoint — the order discovery visits them in.
      { workload: "mail", cursors: 4, idle: 1, backoff: 1, failed: 1, lastSyncedAt: T2.toISOString() },
      // A cursor that is syncing or starting over is counted in `cursors` and in none of the three.
      { workload: "calendar", cursors: 1, idle: 0, backoff: 0, failed: 0, lastSyncedAt: null },
      { workload: "files", cursors: 1, idle: 1, backoff: 0, failed: 0, lastSyncedAt: T1.toISOString() },
    ]);
  });

  it("lists only workloads the person has cursors for, and never one this build does not know", async () => {
    const w = world(connected());
    w.cursor(USER, "mail", "inbox");
    w.cursor(USER, "carrier-pigeon", "x"); // written by some other build
    expect((await getSyncStatus(w.db, USER)).workloads.map((x) => x.workload)).toEqual(["mail"]);
  });

  it("counts only the person's own cursors", async () => {
    // Mutation: drop `userId` from the cursor read and every person sees
    // everybody's counts.
    const w = world(connected());
    w.cursor(USER, "mail", "inbox");
    w.cursor(OTHER, "mail", "inbox");
    w.cursor(OTHER, "mail", "sent");
    expect((await getSyncStatus(w.db, USER)).workloads).toEqual([
      { workload: "mail", cursors: 1, idle: 1, backoff: 0, failed: 0, lastSyncedAt: null },
    ]);
  });
});

describe("getSyncStatus — OneDrive", () => {
  it("joins the OneDrive source, the `files` cursor and the landed files: files only, no folders", async () => {
    const w = world(connected());
    w.oneDrive(USER, "od-1");
    w.cursor(USER, "files", "-", { state: "IDLE", lastSyncedAt: T1 });
    w.file(USER, "od-1", "f1");
    w.file(USER, "od-1", "f2");
    w.file(USER, "od-1", "folder", true);
    w.file(USER, "other-drive", "elsewhere");

    expect((await getSyncStatus(w.db, USER)).oneDrive).toEqual({
      files: 2,
      lastSyncedAt: T1.toISOString(),
      state: "IDLE",
      lastError: null,
    });
  });

  it("is null until the box has registered the drive — nothing can land without it", async () => {
    const w = world(connected());
    w.cursor(USER, "files", "-", { state: "BACKOFF" });
    expect((await getSyncStatus(w.db, USER)).oneDrive).toBeNull();
  });

  it("is null when nothing reads it — a drive with no cursor has no state to report", async () => {
    const w = world(connected());
    w.oneDrive(USER, "od-1");
    expect((await getSyncStatus(w.db, USER)).oneDrive).toBeNull();
  });

  it("reports a never-read drive as zero files, no time, and the cursor's own state", async () => {
    const w = world(connected());
    w.oneDrive(USER, "od-1");
    w.cursor(USER, "files", "-", { state: "RESYNC_REQUIRED" });
    expect((await getSyncStatus(w.db, USER)).oneDrive).toEqual({
      files: 0,
      lastSyncedAt: null,
      state: "RESYNC_REQUIRED",
      lastError: null,
    });
  });

  it("never mixes in another person's drive, files or cursor", async () => {
    const w = world(connected());
    w.oneDrive(OTHER, "od-9");
    w.cursor(OTHER, "files", "-", { lastSyncedAt: T2 });
    w.file(OTHER, "od-9", "theirs");
    expect((await getSyncStatus(w.db, USER)).oneDrive).toBeNull();
  });

  it("passes a failure through with every delta token redacted", async () => {
    const w = world(connected());
    w.oneDrive(USER, "od-1");
    w.cursor(USER, "files", "-", {
      state: "FAILED",
      lastError: "GET https://graph.example/v1.0/me/drive/root/delta?token=SECRETDELTA failed with 400",
    });
    const od = (await getSyncStatus(w.db, USER)).oneDrive!;
    expect(od.state).toBe("FAILED");
    expect(od.lastError).toContain("failed with 400");
    expect(JSON.stringify(od)).not.toContain("SECRETDELTA");
  });
});

describe("getSyncStatus — SharePoint libraries", () => {
  function twoLibraries(over: Row = {}) {
    const w = world(connected({ sharePointEnabled: true, grantedScopes: WITH_SITES, sharePointLibrariesCapped: 4, ...over }));
    w.oneDrive(USER, "od-1");
    w.library(USER, "lib-b", "Front desk", "Policies", { followed: true });
    w.library(USER, "lib-a", "Front desk", "Forms");
    w.cursor(USER, "sharepoint", "lib-b", { state: "SYNCING" });
    w.cursor(USER, "sharepoint", "lib-a", { state: "IDLE", lastSyncedAt: T1 });
    w.file(USER, "lib-a", "f1");
    w.file(USER, "lib-a", "f2");
    w.file(USER, "lib-a", "dir", true);
    w.file(USER, "lib-b", "g1");
    return w;
  }

  it("lists each library with its decrypted names, link, followed flag, file count and the cursor's state", async () => {
    const status = await getSyncStatus(twoLibraries().db, USER);
    expect(status.sharePoint).toEqual({
      enabled: true,
      granted: true,
      needsConsent: false,
      capped: 4,
      libraries: [
        {
          driveId: "lib-a",
          siteName: "Front desk",
          libraryName: "Forms",
          webUrl: "https://contoso.sharepoint.com/sites/lib-a",
          followed: false,
          files: 2,
          lastSyncedAt: T1.toISOString(),
          state: "IDLE",
          lastError: null,
        },
        {
          driveId: "lib-b",
          siteName: "Front desk",
          libraryName: "Policies",
          webUrl: "https://contoso.sharepoint.com/sites/lib-b",
          followed: true,
          files: 1,
          lastSyncedAt: null,
          state: "SYNCING",
          lastError: null,
        },
      ],
    });
  });

  it("is ordered by site, then library, ignoring case — the same on every machine", async () => {
    const w = world(connected({ sharePointEnabled: true, grantedScopes: WITH_SITES }));
    for (const [id, site, name] of [
      ["1", "Warehouse", "docs"],
      ["2", "front desk", "Zebra"],
      ["3", "Front desk", "apple"],
      ["4", "Front desk", "Apple"],
    ] as const) {
      w.library(USER, `lib-${id}`, site, name);
      w.cursor(USER, "sharepoint", `lib-${id}`);
    }
    const names = (await getSyncStatus(w.db, USER)).sharePoint.libraries.map((l) => `${l.siteName} › ${l.libraryName}`);
    // Case is ignored first; two names that differ only in case fall back to plain code-unit order (capitals first).
    expect(names).toEqual(["Front desk › Apple", "Front desk › apple", "front desk › Zebra", "Warehouse › docs"]);
  });

  it("does not list the OneDrive among the libraries, nor a library nothing reads, nor a cursor with no row yet", async () => {
    const w = twoLibraries();
    w.library(USER, "lib-nocursor", "Old site", "Archive"); // a row left behind: nothing reads it
    w.cursor(USER, "sharepoint", "lib-norow"); // a cursor whose source row is not written yet
    const ids = (await getSyncStatus(w.db, USER)).sharePoint.libraries.map((l) => l.driveId);
    expect(ids).toEqual(["lib-a", "lib-b"]);
  });

  it("lists only the person's own libraries — and counts only their own files", async () => {
    // Mutation: drop `userId` from the sources, cursors or counts and one
    // person's card shows another's libraries and file totals.
    const w = twoLibraries();
    w.library(OTHER, "lib-a", "Their site", "Their library");
    w.cursor(OTHER, "sharepoint", "lib-a");
    for (let i = 0; i < 5; i++) w.file(OTHER, "lib-a", `theirs-${i}`);
    const libs = (await getSyncStatus(w.db, USER)).sharePoint.libraries;
    expect(libs.map((l) => l.siteName)).toEqual(["Front desk", "Front desk"]);
    expect(libs.find((l) => l.driveId === "lib-a")!.files).toBe(2);
  });

  it("shows a library whose names cannot be opened under a plain placeholder — with its REAL state — never as another name", async () => {
    // A rotated device key is the usual cause, and it heals at the next
    // reconnect. Hiding the library would hide a failing cursor; showing some
    // other name would be a lie. The card needs strings, so it gets generic ones.
    const w = twoLibraries();
    w.cloud.sources.find((r) => r.sourceId === "lib-b")!.nameEnc = "dcv1:not-a-real-blob";
    w.cloud.sources.find((r) => r.sourceId === "lib-b")!.webUrlEnc = "dcv1:not-a-real-blob";
    w.cursors.rows.find((r) => r.resourceId === "lib-b")!.state = "FAILED";

    const lib = (await getSyncStatus(w.db, USER)).sharePoint.libraries.find((l) => l.driveId === "lib-b")!;
    expect(lib.state).toBe("FAILED");
    expect(lib.files).toBe(1);
    expect(typeof lib.siteName).toBe("string");
    expect(typeof lib.libraryName).toBe("string");
    expect(lib.libraryName).not.toContain("Policies");
    expect(lib.webUrl).toBeNull();
  });

  it("opens a name only under the person and the library it was sealed for", async () => {
    // A blob moved onto another person's row must not open: the AAD binds it.
    const w = twoLibraries();
    const blob = sealSourceField({ provider: "M365", userId: OTHER, sourceId: "lib-a" }, "name", "SOMEBODY ELSES LIBRARY");
    w.cloud.sources.find((r) => r.sourceId === "lib-a")!.nameEnc = blob;
    const lib = (await getSyncStatus(w.db, USER)).sharePoint.libraries.find((l) => l.driveId === "lib-a")!;
    expect(JSON.stringify(lib)).not.toContain("SOMEBODY ELSES LIBRARY");
  });

  it("passes a library's failure through with every delta token redacted", async () => {
    const w = twoLibraries();
    w.cursors.rows.find((r) => r.resourceId === "lib-a")!.state = "BACKOFF";
    w.cursors.rows.find((r) => r.resourceId === "lib-a")!.lastError =
      "request to https://graph.example/v1.0/drives/lib-a/root/delta?token=SECRETDELTA&$top=100 failed";
    const status = await getSyncStatus(w.db, USER);
    const lib = status.sharePoint.libraries.find((l) => l.driveId === "lib-a")!;
    expect(lib.state).toBe("BACKOFF");
    expect(lib.lastError).toContain("failed");
    expect(JSON.stringify(status)).not.toContain("SECRETDELTA");
  });

  it("never selects, so can never return, a delta link or a resume checkpoint", async () => {
    // A delta link is a credential-shaped URL: replaying one reads the person's
    // files. The status needs none of it, so it is never asked for.
    const w = twoLibraries();
    w.cursors.rows.forEach((r) => {
      r.deltaLink = "https://graph.example/v1.0/drives/x/root/delta?token=LINKSECRET";
      r.resumeLink = "https://graph.example/v1.0/drives/x/root/delta?$skiptoken=RESUMESECRET";
    });
    const status = await getSyncStatus(w.db, USER);
    expect(JSON.stringify(status)).not.toMatch(/LINKSECRET|RESUMESECRET|deltaLink|resumeLink/);
    for (const [args] of w.cursors.delegate.findMany.mock.calls) {
      const select = (args as { select?: Record<string, boolean> }).select;
      expect(select, "the cursor read must name its columns").toBeDefined();
      expect(Object.keys(select!)).not.toContain("deltaLink");
      expect(Object.keys(select!)).not.toContain("resumeLink");
    }
  });

  it("shows no libraries and no cap while the switch is off — whatever a race has left is not the person's to see", async () => {
    // The deletion converges within a tick; until it does, listing a library the
    // person has just switched off would contradict the switch.
    const w = twoLibraries({ sharePointEnabled: false, sharePointLibrariesCapped: 4 });
    expect((await getSyncStatus(w.db, USER)).sharePoint).toEqual({
      enabled: false,
      granted: true,
      needsConsent: false,
      capped: 0,
      libraries: [],
    });
  });

  it("says Microsoft has not approved it when the switch is on and the grant lacks Sites.Read.All — the same words as the connection view", async () => {
    const w = world(connected({ sharePointEnabled: true, grantedScopes: BASE }));
    expect((await getSyncStatus(w.db, USER)).sharePoint).toMatchObject({
      enabled: true,
      granted: false,
      needsConsent: true,
      libraries: [],
    });
  });

  it("reports the cap count the last walk that could say recorded", async () => {
    const w = world(connected({ sharePointEnabled: true, grantedScopes: WITH_SITES, sharePointLibrariesCapped: 23 }));
    expect((await getSyncStatus(w.db, USER)).sharePoint.capped).toBe(23);
  });
});
