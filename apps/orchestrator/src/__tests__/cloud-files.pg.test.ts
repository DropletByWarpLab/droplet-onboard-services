/**
 * WARP-3538 — the provider-agnostic cloud-file store, the sweep, the search, the
 * claim order and the SharePoint switch, against REAL Postgres.
 *
 * 🔴 Why this file exists. Everything the DB-less suites say about these tables
 * is said through an in-memory delegate that EVALUATES the arguments it is handed
 * (`helpers/fake-cloud-files.ts`). That makes a dropped `userId` predicate visible,
 * but it cannot say whether Postgres agrees with the fake about the things that
 * only a database decides:
 *
 *   - the compound unique key an upsert is addressed by, and that the same item id
 *     in two sources, or under two people, is two rows;
 *   - `BigInt` — a file past 2 GiB — surviving the round trip;
 *   - `groupBy` + `_count` for a library's file total;
 *   - `orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } }`, which is the
 *     whole of the claim's fairness: if `nulls: "first"` meant something else, the
 *     same cursors would starve for ever and no other test would notice;
 *   - a transaction that really rolls back, which is what makes "switching
 *     SharePoint off is all or nothing" true rather than asserted;
 *   - the migration, which `prisma migrate deploy` replays before any of this runs.
 *
 * The cases drive the REAL services (store, landing handler, search, claim, the
 * switch) so what is checked is the pipeline as it will run, over the real schema.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every other `*.pg.test.ts`.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — this DB is shared and the lane runs --no-file-parallelism.
 * Every row this suite writes belongs to a `userId` prefixed `warp3538-`, and
 * cleanup is scoped to that prefix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn(async () => null) }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { __setColumnCryptoKeyForTest } from "../services/column-crypto.service.js";
import {
  countFilesBySource,
  deleteItemTree,
  ensureSource,
  hasSource,
  markSourceForSweep,
  purgeProviderForUser,
  sweepSource,
  upsertItem,
  upsertSource,
  type CloudFileDb,
  type CloudFileItemInput,
  type CloudFileSourceInput,
} from "../services/cloud-files/cloud-file-store.service.js";
import { searchCloudFiles } from "../services/cloud-files/cloud-file-search.service.js";
import { createDriveLandingHandler } from "../services/m365/drive-landing.service.js";
import { claimDueCursors } from "../services/m365/delta-cursor.service.js";
import { setSharePointEnabled } from "../services/m365/m365-auth.service.js";
import type { GraphPage } from "../services/m365/graph-client.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const P = "warp3538-";
const USER = `${P}alice`;
const OTHER = `${P}bob`;
const OD = "b!onedrive";
const LIB = "b!library-front-desk";

describe.skipIf(!RUN)("cloud files — real Postgres (WARP-3538)", () => {
  let prisma: PrismaClient;
  let db: CloudFileDb;

  const item = (over: Partial<CloudFileItemInput> = {}): CloudFileItemInput => ({
    userId: USER,
    provider: "M365",
    sourceId: LIB,
    externalId: "f1",
    parentExternalId: null,
    isFolder: false,
    name: "Smith, John — consent.pdf",
    webUrl: "https://contoso.sharepoint.com/f1",
    lastModifiedBy: "Sam Rivera",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    remoteCreatedAt: new Date("2026-09-01T10:00:00Z"),
    remoteModifiedAt: new Date("2026-10-01T14:03:00Z"),
    ...over,
  });
  const source = (over: Partial<CloudFileSourceInput> = {}): CloudFileSourceInput => ({
    userId: USER,
    provider: "M365",
    sourceId: LIB,
    kind: "SHAREPOINT_LIBRARY",
    siteId: "contoso.sharepoint.com,site,web",
    siteName: "Front desk",
    name: "Documents",
    webUrl: "https://contoso.sharepoint.com/sites/front",
    followed: true,
    ...over,
  });
  const idsIn = async (sourceId: string, userId = USER) =>
    (await prisma.cloudFileItem.findMany({ where: { userId, sourceId }, select: { externalId: true } }))
      .map((r) => r.externalId)
      .sort();

  async function wipe() {
    const mine = { userId: { startsWith: P } };
    await prisma.cloudFileItem.deleteMany({ where: mine });
    await prisma.cloudFileSource.deleteMany({ where: mine });
    await prisma.m365DeltaCursor.deleteMany({ where: mine });
    await prisma.m365Connection.deleteMany({ where: mine });
  }

  beforeAll(async () => {
    // `setup.ts` mocks `@prisma/client` GLOBALLY for the DB-less lane, so a plain
    // `new PrismaClient()` would return the mock and every assertion here would be
    // vacuous.
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    db = prisma as unknown as CloudFileDb;
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 3).toString("base64"));
  });

  afterAll(async () => {
    await wipe();
    __setColumnCryptoKeyForTest(null);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    recordActivityMock.mockClear();
  });

  describe("the store", () => {
    it("an upsert is addressed by (person, cloud, source, item): a repeat is one row, a different address is another", async () => {
      await upsertItem(db, item());
      await upsertItem(db, item({ name: "renamed.pdf" }));
      await upsertItem(db, item({ sourceId: "b!other-library" })); // same item id, another source
      await upsertItem(db, item({ userId: OTHER })); // same item id and source, another person

      expect(await prisma.cloudFileItem.count({ where: { userId: { startsWith: P } } })).toBe(3);
      expect(await idsIn(LIB)).toEqual(["f1"]);
    });

    it("keeps a file past 2 GiB exactly, a folder with no size, and the clear columns clear", async () => {
      await upsertItem(db, item({ externalId: "big", sizeBytes: 5_000_000_000 }));
      await upsertItem(db, item({ externalId: "dir", isFolder: true, sizeBytes: null, mimeType: null }));
      const big = await prisma.cloudFileItem.findFirstOrThrow({ where: { userId: USER, externalId: "big" } });
      expect(big.sizeBytes).toBe(5_000_000_000n);
      expect(big).toMatchObject({ provider: "M365", sourceId: LIB, mimeType: "application/pdf", sweepPending: false });
      const dir = await prisma.cloudFileItem.findFirstOrThrow({ where: { userId: USER, externalId: "dir" } });
      expect(dir).toMatchObject({ isFolder: true, sizeBytes: null });
      // The human-readable columns are ciphertext in the table.
      expect(big.nameEnc.startsWith("dcv1:")).toBe(true);
      expect(JSON.stringify(big)).not.toContain("Smith");
    });

    it("rejects a provider the schema does not have — a later connector adds its value with its writer", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "CloudFileItem" ("id","userId","provider","sourceId","externalId","isFolder","nameEnc","updatedAt")
           VALUES ('x','${USER}','GOOGLE','s','e',false,'dcv1:x',now())`,
        ),
      ).rejects.toThrow();
    });

    it("counts files per source, folders excluded", async () => {
      await upsertItem(db, item({ externalId: "a" }));
      await upsertItem(db, item({ externalId: "b" }));
      await upsertItem(db, item({ externalId: "d", isFolder: true, sizeBytes: null }));
      await upsertItem(db, item({ externalId: "c", sourceId: OD }));
      await upsertItem(db, item({ externalId: "z", userId: OTHER }));
      expect([...(await countFilesBySource(db, { userId: USER, provider: "M365" })).entries()].sort()).toEqual([
        [LIB, 2],
        [OD, 1],
      ]);
    });

    it("marks and sweeps ONE source of ONE person", async () => {
      for (const id of ["keep", "stale"]) await upsertItem(db, item({ externalId: id }));
      await upsertItem(db, item({ externalId: "elsewhere", sourceId: OD }));
      await upsertItem(db, item({ externalId: "theirs", userId: OTHER }));

      await markSourceForSweep(db, { userId: USER, provider: "M365", sourceId: LIB });
      await upsertItem(db, item({ externalId: "keep" })); // the run returns it: un-marked
      await sweepSource(db, { userId: USER, provider: "M365", sourceId: LIB });

      expect(await idsIn(LIB)).toEqual(["keep"]);
      expect(await idsIn(OD)).toEqual(["elsewhere"]);
      expect(await idsIn(LIB, OTHER)).toEqual(["theirs"]);
    });

    it("deletes a folder's whole subtree, wider than one statement carries, and nothing beside it", async () => {
      await upsertItem(db, item({ externalId: "dir", isFolder: true, sizeBytes: null }));
      // 1,200 children: past the 500-id chunk, so the walk is several statements.
      await prisma.cloudFileItem.createMany({
        data: Array.from({ length: 1200 }, (_, i) => ({
          userId: USER,
          provider: "M365" as const,
          sourceId: LIB,
          externalId: `child-${i}`,
          parentExternalId: i === 0 ? "dir" : "dir",
          isFolder: false,
          nameEnc: "dcv1:x",
        })),
      });
      await prisma.cloudFileItem.create({
        data: { userId: USER, provider: "M365", sourceId: LIB, externalId: "grandchild", parentExternalId: "child-7", isFolder: false, nameEnc: "dcv1:x" },
      });
      await upsertItem(db, item({ externalId: "sibling" }));
      await upsertItem(db, item({ externalId: "dir", userId: OTHER, isFolder: true, sizeBytes: null }));

      expect(await deleteItemTree(db, { userId: USER, provider: "M365", sourceId: LIB, externalId: "dir" })).toBe(1202);
      expect(await idsIn(LIB)).toEqual(["sibling"]);
      expect(await idsIn(LIB, OTHER)).toEqual(["dir"]);
    });

    it("answers whether a source is the person's, of the kind asked, in the cloud asked", async () => {
      await upsertSource(db, source());
      await upsertSource(db, source({ userId: OTHER, sourceId: "b!theirs" }));
      const has = (over: Record<string, unknown>) =>
        hasSource(db, { userId: USER, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: LIB, ...over } as never);
      expect(await has({})).toBe(true);
      expect(await has({ kind: "ONEDRIVE" })).toBe(false);
      expect(await has({ sourceId: "b!theirs" })).toBe(false);
    });

    it("ensureSource creates once and never rewrites; upsertSource refreshes", async () => {
      await ensureSource(db, source({ kind: "ONEDRIVE", sourceId: OD, siteId: null, siteName: null, name: "OneDrive" }));
      const before = await prisma.cloudFileSource.findFirstOrThrow({ where: { userId: USER, sourceId: OD } });
      await ensureSource(db, source({ kind: "ONEDRIVE", sourceId: OD, siteId: null, siteName: null, name: "Renamed" }));
      const after = await prisma.cloudFileSource.findFirstOrThrow({ where: { userId: USER, sourceId: OD } });
      expect(after.nameEnc).toBe(before.nameEnc);

      await upsertSource(db, source());
      const lib1 = await prisma.cloudFileSource.findFirstOrThrow({ where: { userId: USER, sourceId: LIB } });
      await upsertSource(db, source({ name: "Renamed" }));
      const lib2 = await prisma.cloudFileSource.findFirstOrThrow({ where: { userId: USER, sourceId: LIB } });
      expect(lib2.nameEnc).not.toBe(lib1.nameEnc);
      expect(await prisma.cloudFileSource.count({ where: { userId: USER, sourceId: LIB } })).toBe(1);
    });

    it("purgeProviderForUser removes one person's Microsoft 365 rows and nobody else's", async () => {
      await upsertSource(db, source());
      await upsertItem(db, item());
      await upsertSource(db, source({ userId: OTHER }));
      await upsertItem(db, item({ userId: OTHER }));
      expect(await purgeProviderForUser(db, { userId: USER, provider: "M365" })).toEqual({ items: 1, sources: 1 });
      expect(await prisma.cloudFileItem.count({ where: { userId: OTHER } })).toBe(1);
      expect(await prisma.cloudFileSource.count({ where: { userId: OTHER } })).toBe(1);
    });
  });

  describe("landing and finding, end to end over the real tables", () => {
    const page = (items: unknown[], deltaLink: string | null = null): GraphPage =>
      ({ items, links: { nextLink: null, deltaLink }, raw: {} }) as unknown as GraphPage;
    const file = (id: string, name: string, parent = "root-id") => ({
      id,
      name,
      size: 100,
      webUrl: `https://contoso.sharepoint.com/${id}`,
      lastModifiedDateTime: "2026-10-02T09:00:00Z",
      lastModifiedBy: { user: { displayName: "Sam Rivera" } },
      parentReference: { id: parent },
      file: { mimeType: "application/pdf" },
    });
    const folder = (id: string, name: string, parent = "root-id") => ({
      ...file(id, name, parent),
      file: undefined,
      folder: { childCount: 1 },
    });
    const cursor = { id: "c1", userId: USER, workload: "sharepoint", resourceId: LIB, deltaLink: null, resumeLink: null, state: "SYNCING" } as never;

    it("a full enumeration lands, sweeps what is gone, and the search finds exactly what is left — with its folder path", async () => {
      await upsertSource(db, source());
      const handle = createDriveLandingHandler(db);
      await upsertItem(db, item({ externalId: "stale" })); // landed by an earlier run, since deleted upstream

      await handle(cursor, page([folder("forms", "Forms"), file("f1", "Consent form.pdf", "forms")]), {
        fullEnumeration: true,
        isFirstPage: true,
        isLastPage: false,
      });
      await handle(cursor, page([file("f2", "Invoice.pdf")], "https://graph/delta?token=x"), {
        fullEnumeration: true,
        isFirstPage: false,
        isLastPage: true,
      });

      expect(await idsIn(LIB)).toEqual(["f1", "f2", "forms"]);
      const found = await searchCloudFiles(db, { userId: USER, providers: ["M365"], query: "consent", limit: 25 });
      expect(found.items).toEqual([
        {
          name: "Consent form.pdf",
          isFolder: false,
          provider: "m365",
          location: "Front desk › Documents",
          path: "Forms",
          webUrl: "https://contoso.sharepoint.com/f1",
          lastModifiedAt: "2026-10-02T09:00:00.000Z",
          lastModifiedBy: "Sam Rivera",
          sizeBytes: 100,
        },
      ]);
    });

    it("never finds another person's files, a file whose library is gone, or a cloud that is not connected", async () => {
      await upsertSource(db, source());
      await upsertItem(db, item({ externalId: "mine", name: "budget.xlsx" }));
      await upsertItem(db, item({ externalId: "theirs", name: "budget.xlsx", userId: OTHER }));
      await upsertItem(db, item({ externalId: "orphan", name: "budget leftover.xlsx", sourceId: "b!removed" }));

      const search = (providers: Array<"M365">) => searchCloudFiles(db, { userId: USER, providers, query: "budget", limit: 25 });
      expect((await search(["M365"])).items.map((i) => i.name)).toEqual(["budget.xlsx"]);
      expect((await search([])).items).toEqual([]);
    });

    it("filters by modified-since and by location inside the database, newest first", async () => {
      await upsertSource(db, source());
      await upsertSource(db, source({ kind: "ONEDRIVE", sourceId: OD, siteId: null, siteName: null, name: "OneDrive" }));
      await upsertItem(db, item({ externalId: "old", name: "old.pdf", remoteModifiedAt: new Date("2026-01-01T00:00:00Z") }));
      await upsertItem(db, item({ externalId: "new", name: "new.pdf", remoteModifiedAt: new Date("2026-10-03T00:00:00Z") }));
      await upsertItem(db, item({ externalId: "mine", name: "mine.pdf", sourceId: OD, remoteModifiedAt: new Date("2026-10-02T00:00:00Z") }));

      const names = async (over: object) =>
        (await searchCloudFiles(db, { userId: USER, providers: ["M365"], limit: 25, ...over })).items.map((i) => i.name);
      expect(await names({})).toEqual(["new.pdf", "mine.pdf", "old.pdf"]);
      expect(await names({ modifiedSince: new Date("2026-10-02T00:00:00Z") })).toEqual(["new.pdf", "mine.pdf"]);
      expect(await names({ source: "onedrive" })).toEqual(["mine.pdf"]);
    });

    it("refuses a page for a library that is no longer registered, and writes nothing", async () => {
      const handle = createDriveLandingHandler(db);
      await expect(
        handle(cursor, page([file("f1", "x.pdf")]), { fullEnumeration: false, isFirstPage: true, isLastPage: true }),
      ).rejects.toThrow(/not registered/);
      expect(await prisma.cloudFileItem.count({ where: { userId: USER } })).toBe(0);
    });
  });

  describe("the claim order", () => {
    it("serves a never-synced cursor first, then the least recently synced — so past the limit nothing starves", async () => {
      await prisma.m365Connection.create({ data: { userId: USER, state: "CONNECTED" } });
      const at = (iso: string) => new Date(iso);
      const make = (resourceId: string, lastSyncedAt: Date | null, createdAt: Date) =>
        prisma.m365DeltaCursor.create({ data: { userId: USER, workload: "mail", resourceId, lastSyncedAt, createdAt } });
      await make("recent", at("2026-10-04T00:00:00Z"), at("2026-01-01T00:00:00Z"));
      await make("oldest", at("2026-09-01T00:00:00Z"), at("2026-01-02T00:00:00Z"));
      await make("never-b", null, at("2026-03-01T00:00:00Z"));
      await make("never-a", null, at("2026-02-01T00:00:00Z"));
      await make("older", at("2026-09-20T00:00:00Z"), at("2026-01-03T00:00:00Z"));

      const ids = (await claimDueCursors(prisma, 10, at("2026-10-05T00:00:00Z"))).map((c) => c.resourceId);
      expect(ids).toEqual(["never-a", "never-b", "oldest", "older", "recent"]);
      // …and a limit takes the head of that order, not whichever rows the planner met first.
      expect((await claimDueCursors(prisma, 2, at("2026-10-05T00:00:00Z"))).map((c) => c.resourceId)).toEqual(["never-a", "never-b"]);
    });
  });

  describe("the SharePoint switch", () => {
    async function populated() {
      await prisma.m365Connection.create({
        data: { userId: USER, state: "CONNECTED", sharePointEnabled: true, sharePointLibrariesCapped: 4, grantedScopes: "Sites.Read.All Files.ReadWrite.All" },
      });
      await prisma.m365DeltaCursor.createMany({
        data: [
          { userId: USER, workload: "sharepoint", resourceId: LIB },
          { userId: USER, workload: "files", resourceId: "-" },
          { userId: OTHER, workload: "sharepoint", resourceId: LIB },
        ],
      });
      await upsertSource(db, source());
      await upsertSource(db, source({ kind: "ONEDRIVE", sourceId: OD, siteId: null, siteName: null, name: "OneDrive" }));
      await upsertItem(db, item({ externalId: "sp" }));
      await upsertItem(db, item({ externalId: "od", sourceId: OD }));
      await upsertItem(db, item({ externalId: "theirs", userId: OTHER }));
    }

    it("turns off in one real transaction: the flag, the cursors, the library and its files go; OneDrive and everyone else stay", async () => {
      await populated();
      const result = await setSharePointEnabled(prisma, USER, false);
      expect(result).toMatchObject({ ok: true, changed: true, view: { sharePoint: { enabled: false } } });

      expect(await prisma.m365Connection.findUniqueOrThrow({ where: { userId: USER } })).toMatchObject({
        sharePointEnabled: false,
        sharePointLibrariesCapped: 0,
      });
      expect((await prisma.m365DeltaCursor.findMany({ where: { userId: USER } })).map((c) => c.workload)).toEqual(["files"]);
      expect(await idsIn(LIB)).toEqual([]);
      expect(await idsIn(OD)).toEqual(["od"]);
      expect(await prisma.cloudFileSource.count({ where: { userId: USER, sourceId: LIB } })).toBe(0);
      expect(await idsIn(LIB, OTHER)).toEqual(["theirs"]);
      expect(await prisma.m365DeltaCursor.count({ where: { userId: OTHER } })).toBe(1);
    });

    it("rolls EVERYTHING back when its last statement fails — all or nothing, in the database", async () => {
      await populated();
      // The same client, but the transaction's handle fails on the final delete.
      const failing = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
          return (fn: (tx: PrismaClient) => Promise<unknown>) =>
            target.$transaction(async (tx) =>
              fn(
                new Proxy(tx as unknown as PrismaClient, {
                  get(inner, name, innerReceiver) {
                    if (name !== "cloudFileSource") return Reflect.get(inner, name, innerReceiver);
                    return new Proxy(inner.cloudFileSource, {
                      get(delegate, method, r) {
                        if (method === "deleteMany") return async () => { throw new Error("connection reset"); };
                        return Reflect.get(delegate, method, r);
                      },
                    });
                  },
                }),
              ),
            );
        },
      }) as PrismaClient;

      await expect(setSharePointEnabled(failing, USER, false)).rejects.toThrow("connection reset");

      expect(await prisma.m365Connection.findUniqueOrThrow({ where: { userId: USER } })).toMatchObject({
        sharePointEnabled: true,
        sharePointLibrariesCapped: 4,
      });
      expect(await prisma.m365DeltaCursor.count({ where: { userId: USER } })).toBe(2);
      expect(await idsIn(LIB)).toEqual(["sp"]);
      expect(await prisma.cloudFileSource.count({ where: { userId: USER } })).toBe(2);
    });
  });
});
