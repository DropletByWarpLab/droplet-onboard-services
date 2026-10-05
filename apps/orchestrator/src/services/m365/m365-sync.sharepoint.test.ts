/**
 * WARP-3538 — SharePoint library discovery, the OneDrive source, and the
 * per-person opt-in that gates SharePoint.
 *
 * `m365-sync.service.test.ts` pins the engine's own failure shapes and the
 * folder walk. This file pins the second kind of discovery: not a tree of
 * folders but a walk over SITES — the ones a person can open, found two ways —
 * down to each site's document libraries, one cursor and one cloud-file source
 * per library. And the small registration beside it: the person's OneDrive,
 * which has a cursor but needs a SOURCE to say which drive it is.
 *
 * What it defends, because every one of these fails silently:
 *   - a library is registered only for a person who opted in AND whose grant
 *     covers `Sites.Read.All`; an opted-out person is `disabled`, never
 *     `notGranted` (a fault-shaped word for a choice) and never `skipped`;
 *   - somebody's OneDrive is never read as a "SharePoint library";
 *   - PRUNING is the dangerous half. A partial listing must delete nothing,
 *     because "Microsoft hiccuped" must not look like "the library is gone" and
 *     take a person's landed file list with it.
 *
 * Prisma is an in-memory store whose cloud-file tables EVALUATE their arguments
 * (`helpers/fake-cloud-files.ts`), the Graph client a routed stub that REFUSES an
 * unexpected URL (a request nobody planned is a failure, not a silent empty
 * page), and the auth service is mocked at the module seam as in the sibling
 * file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAccessTokenMock } = vi.hoisted(() => ({ getAccessTokenMock: vi.fn() }));
vi.mock("./m365-auth.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./m365-auth.service.js")>();
  return { ...actual, getAccessToken: getAccessTokenMock };
});

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { makeFakeCloudFileDb } from "../../__tests__/helpers/fake-cloud-files.js";
import { unsealSourceField } from "../cloud-files/cloud-file-crypto.js";
import {
  MAX_PAGES_PER_TICK,
  MAX_SHAREPOINT_LIBRARIES_PER_PERSON,
  discoverResources,
  grantCoversNoWorkload,
  type M365SyncDeps,
} from "./m365-sync.service.js";
import { GRAPH_API_BASE_URL, GraphRequestError, type GraphPage } from "./graph-client.js";
import {
  FOLLOWED_SITES_PATH,
  ONEDRIVE_DRIVE_PATH,
  SHAREPOINT_SITE_SEARCH_PATH,
  siteDrivesPath,
} from "./graph-resources.js";

const USER = "user-1";
const OTHER = "user-2";
const NOW = new Date("2026-10-04T12:00:00Z");
const BASE_SCOPES =
  "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All";
const WITH_SITES = `${BASE_SCOPES} Sites.Read.All`;

const SEARCH_URL = `${GRAPH_API_BASE_URL}${SHAREPOINT_SITE_SEARCH_PATH}`;
const FOLLOWED_URL = `${GRAPH_API_BASE_URL}${FOLLOWED_SITES_PATH}`;
const ONEDRIVE_URL = `${GRAPH_API_BASE_URL}${ONEDRIVE_DRIVE_PATH}`;
const drivesUrl = (siteId: string) => `${GRAPH_API_BASE_URL}${siteDrivesPath(siteId)}`;

beforeEach(() => {
  getAccessTokenMock.mockReset();
  getAccessTokenMock.mockResolvedValue("tok");
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 4).toString("base64"));
});
afterEach(() => __setColumnCryptoKeyForTest(null));

// --- fixtures ----------------------------------------------------------------

const siteId = (n: string) => `contoso.sharepoint.com,${n},web-${n}`;
const site = (n: string, over: Record<string, unknown> = {}) => ({
  id: siteId(n),
  displayName: `Site ${n}`,
  webUrl: `https://contoso.sharepoint.com/sites/${n}`,
  ...over,
});
const drive = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Lib ${id}`,
  driveType: "documentLibrary",
  webUrl: `https://contoso.sharepoint.com/sites/x/${id}`,
  ...over,
});

type Route = GraphPage | Error;
function pageOf(items: Record<string, unknown>[], nextLink: string | null = null): GraphPage {
  return { items, links: { nextLink, deltaLink: null }, raw: {} } as unknown as GraphPage;
}
/** `GET /me/drive` answers ONE resource, which `GraphClient` hands back as `raw`. */
function oneDrive(raw: Record<string, unknown>): GraphPage {
  return { items: [], links: { nextLink: null, deltaLink: null }, raw } as unknown as GraphPage;
}
const MY_DRIVE = { id: "od-1", name: "OneDrive", driveType: "business", webUrl: "https://contoso-my.sharepoint.com/personal/sam/Documents" };

/**
 * The calls every discovery also makes: the mail and contact folder walks, and the
 * person's OneDrive. Answered with the quiet default so a test about SharePoint is
 * not also a test about mail — a person with no mail folders registers none and
 * reports no fault, and a OneDrive that answers is registered and reports none.
 */
const DEFAULT_ROUTES: Record<string, Route> = {
  [`${GRAPH_API_BASE_URL}/me/mailFolders?includeHiddenFolders=true`]: pageOf([]),
  [`${GRAPH_API_BASE_URL}/me/contactFolders`]: pageOf([]),
  [ONEDRIVE_URL]: oneDrive(MY_DRIVE),
};

/** A Graph that answers only the URLs it was told about and records every request. */
function graphStub(routes: Record<string, Route>, onRequest?: (url: string) => void) {
  const all = { ...DEFAULT_ROUTES, ...routes };
  const requested: string[] = [];
  const getPage = vi.fn(async (url: string) => {
    requested.push(url);
    onRequest?.(url);
    const route = all[url];
    if (!route) {
      throw new GraphRequestError({ statusCode: 404, code: "itemNotFound", message: `unplanned ${url}` });
    }
    if (route instanceof Error) throw route;
    return route;
  });
  return { requested, client: { getPage } as unknown as M365SyncDeps["client"] };
}

/** Only the requests SharePoint discovery made — sites, followed sites, a site's drives. */
const siteRequests = (requested: string[]) => requested.filter((u) => /\/sites|followedSites/.test(u));

const refused = (statusCode = 503) =>
  new GraphRequestError({ statusCode, code: "serviceNotAvailable", message: "no" });

interface Cursor { userId: string; workload: string; resourceId: string }

/**
 * The tables discovery touches, in memory. The cloud-file tables are the shared
 * evaluating fakes; the cursor and connection delegates are honest about the
 * filters they honour (userId, workload, resourceId `in`) because a fake that
 * ignored `in` would let a prune delete the wrong rows and still pass.
 */
function fakePrisma(opts: {
  grantedScopes: string | null;
  sharePointEnabled?: boolean;
  cursors?: Cursor[];
  /** SharePoint library sources, as discovery would have registered them earlier. */
  libraries?: Array<{ userId: string; sourceId: string }>;
  /** Landed items, as `[userId, sourceId, externalId]`. */
  items?: Array<[string, string, string]>;
  /** A OneDrive source already registered for these people (sourceId = `od-<user>`). */
  oneDriveFor?: string[];
  capped?: number;
}) {
  let sharePointEnabled = opts.sharePointEnabled ?? true;
  let capped = opts.capped ?? 0;
  const cursors: Cursor[] = [...(opts.cursors ?? [])];
  const cloud = makeFakeCloudFileDb();
  const order: string[] = [];

  for (const l of opts.libraries ?? []) {
    cloud.seedSource({ userId: l.userId, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: l.sourceId, siteId: "s", nameEnc: "dcv1:x" });
  }
  for (const user of opts.oneDriveFor ?? []) {
    cloud.seedSource({ userId: user, provider: "M365", kind: "ONEDRIVE", sourceId: `od-${user}`, nameEnc: "dcv1:x" });
  }
  for (const [userId, sourceId, externalId] of opts.items ?? []) {
    cloud.seedItem({ userId, provider: "M365", sourceId, externalId, isFolder: false, nameEnc: "dcv1:x" });
  }

  // The order discovery registers things in: the cursor must come BEFORE its source row.
  const realSourceUpsert = cloud.cloudFileSource.upsert.getMockImplementation()!;
  cloud.cloudFileSource.upsert.mockImplementation(async (args: any) => {
    order.push(`source:${args.where.userId_provider_sourceId.sourceId}`);
    return realSourceUpsert(args);
  });

  const matchesCursor = (c: Cursor, where: any) =>
    c.userId === where.userId &&
    (where.workload === undefined || c.workload === where.workload) &&
    (where.resourceId?.in === undefined || where.resourceId.in.includes(c.resourceId));

  return {
    __cursors: () => cursors,
    __cloud: cloud,
    __sources: () => cloud.sources,
    __items: () => cloud.items,
    __capped: () => capped,
    __order: () => order,
    /** The person flips the switch while a discovery is in flight. */
    __setEnabled: (v: boolean) => {
      sharePointEnabled = v;
    },
    cloudFileItem: cloud.cloudFileItem,
    cloudFileSource: cloud.cloudFileSource,
    m365Connection: {
      findUnique: vi.fn(async () => ({ grantedScopes: opts.grantedScopes, sharePointEnabled })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.sharePointLibrariesCapped?.not !== undefined && where.sharePointLibrariesCapped.not === capped) {
          return { count: 0 };
        }
        capped = data.sharePointLibrariesCapped;
        return { count: 1 };
      }),
    },
    m365DeltaCursor: {
      upsert: vi.fn(async ({ where }: any) => {
        const k = where.userId_workload_resourceId;
        order.push(`cursor:${k.resourceId}`);
        if (!cursors.some((c) => c.userId === k.userId && c.workload === k.workload && c.resourceId === k.resourceId)) {
          cursors.push({ userId: k.userId, workload: k.workload, resourceId: k.resourceId });
        }
        return {};
      }),
      findMany: vi.fn(async ({ where }: any) =>
        cursors.filter((c) => matchesCursor(c, where)).map((c) => ({ resourceId: c.resourceId })),
      ),
      count: vi.fn(async ({ where }: any) => cursors.filter((c) => matchesCursor(c, where)).length),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = cursors.length;
        for (let i = cursors.length - 1; i >= 0; i -= 1) {
          if (matchesCursor(cursors[i]!, where)) cursors.splice(i, 1);
        }
        return { count: before - cursors.length };
      }),
    },
  };
}

function depsFor(prisma: ReturnType<typeof fakePrisma>, client: M365SyncDeps["client"]): M365SyncDeps {
  return {
    prisma: prisma as never,
    client,
    entra: {} as never,
    initialUrlFor: () => null,
    now: () => NOW,
  };
}

const spCursors = (p: ReturnType<typeof fakePrisma>) =>
  p.__cursors().filter((c) => c.userId === USER && c.workload === "sharepoint").map((c) => c.resourceId);
const libraries = (p: ReturnType<typeof fakePrisma>, userId = USER) =>
  p.__sources().filter((s) => s.userId === userId && s.kind === "SHAREPOINT_LIBRARY");
const libIds = (p: ReturnType<typeof fakePrisma>, userId = USER) => libraries(p, userId).map((s) => s.sourceId as string);
const itemIds = (p: ReturnType<typeof fakePrisma>) => p.__items().map((i) => `${i.userId}/${i.sourceId}/${i.externalId}`).sort();

// --- the opt-in --------------------------------------------------------------

describe("discoverResources — SharePoint is the person's choice (WARP-3538)", () => {
  it("reports an opted-out person's SharePoint as `disabled` — not notGranted, not skipped — and never calls Graph for sites", async () => {
    // A choice is not a fault. `notGranted` would read as "Microsoft refused"
    // and `skipped` as "it broke"; neither is true of a person who said no.
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, sharePointEnabled: false });
    const { client, requested } = graphStub({});

    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(found.disabled).toEqual(["calendar", "sharepoint"]);
    expect(found.notGranted).toEqual(["todo"]);
    expect(found.skipped).toEqual([]);
    expect(found.sharePoint).toBeNull();
    expect(siteRequests(requested)).toEqual([]);
  });

  it("is disabled for an opted-out person whatever their grant says — the choice comes first", async () => {
    // Even a grant that covers Sites.Read.All must not start a discovery the
    // person did not ask for: the scope may simply have been approved tenant-wide.
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, sharePointEnabled: false });
    const withGrant = await discoverResources(depsFor(prisma, graphStub({}).client), USER);
    const noGrant = await discoverResources(
      depsFor(fakePrisma({ grantedScopes: BASE_SCOPES, sharePointEnabled: false }), graphStub({}).client),
      USER,
    );
    expect(withGrant.disabled).toEqual(["calendar", "sharepoint"]);
    expect(noGrant.disabled).toEqual(["calendar", "sharepoint"]);
    expect(noGrant.notGranted).not.toContain("sharepoint");
  });

  it("treats an absent or non-boolean flag as OFF — explicit state, never inferred", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    prisma.m365Connection.findUnique.mockResolvedValue({ grantedScopes: WITH_SITES } as never);
    const found = await discoverResources(depsFor(prisma, graphStub({}).client), USER);
    expect(found.disabled).toEqual(["calendar", "sharepoint"]);
    prisma.m365Connection.findUnique.mockResolvedValue({ grantedScopes: WITH_SITES, sharePointEnabled: "true" } as never);
    expect((await discoverResources(depsFor(prisma, graphStub({}).client), USER)).disabled).toEqual(["calendar", "sharepoint"]);
  });

  it("reports an opted-in person whose grant lacks Sites.Read.All as notGranted, and reads nothing", async () => {
    // The state an EXISTING connection is in the moment its owner turns
    // SharePoint on: it holds the base set, which can read a drive but cannot
    // find one. Expected, not a fault — the card says "needs permission".
    const prisma = fakePrisma({ grantedScopes: BASE_SCOPES, sharePointEnabled: true });
    const { client, requested } = graphStub({});
    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(found.notGranted).toEqual(["todo", "sharepoint"]);
    expect(found.disabled).toEqual(["calendar"]);
    expect(found.skipped).toEqual([]);
    expect(siteRequests(requested)).toEqual([]);
    expect(spCursors(prisma)).toEqual([]);
    expect(found.sharePoint).toBeNull();
  });

  it("removes what an opted-out person still holds, so 'off' converges even after a race", async () => {
    // "Droplet deletes the list of SharePoint files it kept and stops reading
    // them" is the promise the switch makes. A discovery already in flight when
    // the person turned it off can re-create cursors after the purge; the next
    // tick finds the switch off and cleans up, so the residue is one tick, not
    // forever. Nothing of another person's, nor of OneDrive, is touched.
    const prisma = fakePrisma({
      grantedScopes: WITH_SITES,
      sharePointEnabled: false,
      oneDriveFor: [USER],
      cursors: [
        { userId: USER, workload: "sharepoint", resourceId: "d1" },
        { userId: USER, workload: "files", resourceId: "-" },
        { userId: OTHER, workload: "sharepoint", resourceId: "d9" },
      ],
      libraries: [
        { userId: USER, sourceId: "d1" },
        { userId: OTHER, sourceId: "d9" },
      ],
      items: [
        [USER, "d1", "i1"],
        [USER, `od-${USER}`, "i2"],
        [OTHER, "d9", "i3"],
      ],
    });
    await discoverResources(depsFor(prisma, graphStub({}).client), USER);

    expect(prisma.__cursors().filter((c) => c.workload === "sharepoint")).toEqual([
      { userId: OTHER, workload: "sharepoint", resourceId: "d9" },
    ]);
    expect(prisma.__cursors()).toContainEqual({ userId: USER, workload: "files", resourceId: "-" }); // OneDrive's own cursor stays
    expect(libIds(prisma, USER)).toEqual([]);
    expect(libIds(prisma, OTHER)).toEqual(["d9"]);
    expect(itemIds(prisma)).toEqual([`${USER}/od-${USER}/i2`, `${OTHER}/d9/i3`]);
  });

  it("removes a library that has a cursor and no source row — a crash between the two writes must not leave it read for ever", async () => {
    // Discovery registers the cursor first and the row second, so a crash can
    // leave a cursor with no row. Removing "the libraries" from the rows alone
    // would never find it, and it would keep being read and landed.
    const prisma = fakePrisma({
      grantedScopes: WITH_SITES,
      sharePointEnabled: false,
      cursors: [{ userId: USER, workload: "sharepoint", resourceId: "orphan" }],
      items: [[USER, "orphan", "i1"]],
    });
    await discoverResources(depsFor(prisma, graphStub({}).client), USER);
    expect(spCursors(prisma)).toEqual([]);
    expect(prisma.__items()).toEqual([]);
  });
});

describe("grantCoversNoWorkload — a person with SharePoint off is judged on the other workloads (WARP-3538)", () => {
  const found = (over: Partial<Parameters<typeof grantCoversNoWorkload>[0]>) => ({
    registered: 0,
    notGranted: [] as string[],
    disabled: [] as string[],
    ...over,
  });

  it("is true when every workload that COULD sync is not granted, with SharePoint off", async () => {
    // Before this, five not-granted workloads out of six was "some workload is
    // covered" — so a person whose grant covered nothing, and who simply had not
    // opted in to SharePoint, was never warned that nothing syncs for them.
    expect(
      grantCoversNoWorkload(found({ notGranted: ["mail", "calendar", "contacts", "files", "todo"], disabled: ["sharepoint"] })),
    ).toBe(true);
  });

  it("is false when SharePoint is off but something else is covered", () => {
    expect(grantCoversNoWorkload(found({ notGranted: ["todo"], disabled: ["sharepoint"] }))).toBe(false);
  });

  it("is true for an opted-in person when all six are not granted", () => {
    expect(
      grantCoversNoWorkload(found({ notGranted: ["mail", "calendar", "contacts", "files", "todo", "sharepoint"] })),
    ).toBe(true);
  });

  it("is false once anything registered", () => {
    expect(grantCoversNoWorkload(found({ registered: 1, notGranted: ["mail", "calendar", "contacts", "todo"], disabled: ["sharepoint"] }))).toBe(false);
  });

  it("still takes the two-field shape older callers pass", () => {
    expect(grantCoversNoWorkload({ registered: 0, notGranted: ["mail", "calendar", "contacts", "files", "todo", "sharepoint"] })).toBe(true);
  });
});

// --- the OneDrive source -----------------------------------------------------

describe("discoverResources — the person's OneDrive is registered as a source (WARP-3538)", () => {
  const onedrives = (p: ReturnType<typeof fakePrisma>, userId = USER) => p.__sources().filter((s) => s.userId === userId && s.kind === "ONEDRIVE");

  it("reads GET /me/drive once and registers the drive as a ONEDRIVE source, names sealed", async () => {
    const prisma = fakePrisma({ grantedScopes: BASE_SCOPES, sharePointEnabled: false });
    const { client, requested } = graphStub({
      [ONEDRIVE_URL]: oneDrive({ ...MY_DRIVE, name: "OneDrive — Smith, John", webUrl: "https://contoso-my.sharepoint.com/personal/john_smith/Documents" }),
    });
    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(requested.filter((u) => u === ONEDRIVE_URL)).toHaveLength(1);
    expect(found.skipped).toEqual([]);
    const row = onedrives(prisma)[0]!;
    expect(row).toMatchObject({ provider: "M365", kind: "ONEDRIVE", sourceId: "od-1", siteId: null, siteNameEnc: null, followed: false });
    // Ciphertext at rest: a drive's name can carry a person's.
    expect(JSON.stringify([row.nameEnc, row.webUrlEnc])).not.toContain("Smith");
    const ref = { provider: "M365", userId: USER, sourceId: "od-1" } as const;
    expect(unsealSourceField(ref, "name", row.nameEnc as string)).toBe("OneDrive — Smith, John");
    expect(unsealSourceField(ref, "webUrl", row.webUrlEnc as string)).toBe("https://contoso-my.sharepoint.com/personal/john_smith/Documents");
  });

  it("does not call Microsoft again once the source exists — one indexed lookup per tick, not one request", async () => {
    const prisma = fakePrisma({ grantedScopes: BASE_SCOPES, sharePointEnabled: false, oneDriveFor: [USER] });
    const { client, requested } = graphStub({});
    await discoverResources(depsFor(prisma, client), USER);
    await discoverResources(depsFor(prisma, client), USER);
    expect(requested).not.toContain(ONEDRIVE_URL);
    expect(onedrives(prisma)).toHaveLength(1);
  });

  it("leaves an existing row exactly as it was — create-only, never a rewrite", async () => {
    const prisma = fakePrisma({ grantedScopes: BASE_SCOPES, sharePointEnabled: false, oneDriveFor: [USER] });
    const before = { ...onedrives(prisma)[0]! };
    await discoverResources(depsFor(prisma, graphStub({ [ONEDRIVE_URL]: oneDrive({ ...MY_DRIVE, name: "Renamed" }) }).client), USER);
    expect(onedrives(prisma)[0]).toEqual(before);
  });

  it.each([
    ["Microsoft refuses the call", refused()],
    ["the body names no drive", oneDrive({ name: "OneDrive" })],
  ])("names it in `skipped` — and still registers the OneDrive cursor — when %s", async (_label, answer) => {
    // Until the source exists the landing handler refuses OneDrive's pages, so
    // "synced" would look the same as "nothing to sync" if this were silent. The
    // cursor is registered regardless: the next tick retries the drive details.
    const prisma = fakePrisma({ grantedScopes: BASE_SCOPES, sharePointEnabled: false });
    const found = await discoverResources(depsFor(prisma, graphStub({ [ONEDRIVE_URL]: answer }).client), USER);

    expect(found.skipped).toEqual(["files (drive details)"]);
    expect(onedrives(prisma)).toEqual([]);
    expect(prisma.__cursors()).toContainEqual({ userId: USER, workload: "files", resourceId: "-" });
  });

  it("asks nothing about a OneDrive the grant does not cover", async () => {
    const prisma = fakePrisma({ grantedScopes: "offline_access User.Read", sharePointEnabled: false });
    const { client, requested } = graphStub({});
    const found = await discoverResources(depsFor(prisma, client), USER);
    expect(found.notGranted).toContain("files");
    expect(requested).not.toContain(ONEDRIVE_URL);
  });

  it("is per person: one person's OneDrive source never satisfies another's", async () => {
    const prisma = fakePrisma({ grantedScopes: BASE_SCOPES, sharePointEnabled: false, oneDriveFor: [OTHER] });
    const { client, requested } = graphStub({});
    await discoverResources(depsFor(prisma, client), USER);
    expect(requested).toContain(ONEDRIVE_URL);
    expect(onedrives(prisma)).toHaveLength(1);
  });
});

// --- the walk ----------------------------------------------------------------

describe("discoverResources — SharePoint libraries (WARP-3538)", () => {
  it("registers a cursor and a source row for every document library, across both site sources", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub({
      [SEARCH_URL]: pageOf([site("a"), site("b")]),
      [FOLLOWED_URL]: pageOf([site("b"), site("c")]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1")]),
      [drivesUrl(siteId("b"))]: pageOf([drive("db1"), drive("db2")]),
      [drivesUrl(siteId("c"))]: pageOf([drive("dc1")]),
    });

    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(spCursors(prisma).sort()).toEqual(["da1", "db1", "db2", "dc1"]);
    expect(libIds(prisma).sort()).toEqual(["da1", "db1", "db2", "dc1"]);
    expect(found.sharePoint).toMatchObject({ registered: 4, dropped: 0, complete: true, pruned: 0 });
    // Libraries count toward what was registered, so "registered 0" still means
    // "this person syncs nothing": the OneDrive singleton plus four libraries.
    expect(found.registered).toBe(5);
    expect(found.skipped).toEqual([]);
    expect(found.disabled).toEqual(["calendar"]);
  });

  it("unions the sites by id, and marks a site the person follows as followed — even when search found it too", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client, requested } = graphStub({
      [SEARCH_URL]: pageOf([site("a"), site("b")]),
      [FOLLOWED_URL]: pageOf([site("b")]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1")]),
      [drivesUrl(siteId("b"))]: pageOf([drive("db1")]),
    });
    await discoverResources(depsFor(prisma, client), USER);

    // One site, found twice, is listed ONCE.
    expect(requested.filter((u) => u === drivesUrl(siteId("b")))).toHaveLength(1);
    const byDrive = Object.fromEntries(libraries(prisma).map((l) => [l.sourceId, l.followed]));
    expect(byDrive).toEqual({ da1: false, db1: true });
  });

  it("stores the library's names encrypted, bound to the person and the drive", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub({
      [SEARCH_URL]: pageOf([site("a", { displayName: "Front desk — Smith, John" })]),
      [FOLLOWED_URL]: pageOf([]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1", { name: "Patient consents", webUrl: "https://contoso.sharepoint.com/sites/a/Consents" })]),
    });
    await discoverResources(depsFor(prisma, client), USER);

    const row = libraries(prisma)[0]!;
    // Ciphertext at rest: none of the names appears in what the database holds.
    // (The site id is an id, not a name, and is clear on purpose.)
    const serialized = JSON.stringify([row.siteNameEnc, row.nameEnc, row.webUrlEnc]);
    expect(serialized).not.toContain("Smith");
    expect(serialized).not.toContain("Patient consents");
    expect(serialized).not.toContain("sharepoint.com");
    expect((row.siteNameEnc as string).startsWith("dcv1:")).toBe(true);
    const ref = { provider: "M365", userId: USER, sourceId: "da1" } as const;
    expect(unsealSourceField(ref, "siteName", row.siteNameEnc as string)).toBe("Front desk — Smith, John");
    expect(unsealSourceField(ref, "name", row.nameEnc as string)).toBe("Patient consents");
    expect(unsealSourceField(ref, "webUrl", row.webUrlEnc as string)).toBe("https://contoso.sharepoint.com/sites/a/Consents");
    expect(row).toMatchObject({ provider: "M365", kind: "SHAREPOINT_LIBRARY", siteId: siteId("a") });
    // …and a blob copied to another person's row fails closed.
    expect(() => unsealSourceField({ ...ref, userId: OTHER }, "siteName", row.siteNameEnc as string)).toThrow();
  });

  it("never reads a personal site — by flag, or by its -my host — and never lists its drives", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const flagged = site("p1", { isPersonalSite: true });
    const byHost = site("p2", { webUrl: "https://contoso-my.sharepoint.com/personal/sam_contoso_com" });
    const { client, requested } = graphStub({
      [SEARCH_URL]: pageOf([site("a"), flagged, byHost]),
      [FOLLOWED_URL]: pageOf([byHost]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1")]),
    });
    await discoverResources(depsFor(prisma, client), USER);

    expect(libIds(prisma)).toEqual(["da1"]);
    expect(requested).not.toContain(drivesUrl(siteId("p1")));
    expect(requested).not.toContain(drivesUrl(siteId("p2")));
  });

  it("keeps document libraries only — no OneDrive, no system drive", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub({
      [SEARCH_URL]: pageOf([site("a")]),
      [FOLLOWED_URL]: pageOf([]),
      [drivesUrl(siteId("a"))]: pageOf([
        drive("lib"),
        drive("od", { driveType: "business" }),
        drive("sys", { system: {} }),
        drive("pers", { driveType: "personal" }),
      ]),
    });
    await discoverResources(depsFor(prisma, client), USER);
    expect(libIds(prisma)).toEqual(["lib"]);
  });

  it("follows @odata.nextLink on every listing it reads", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const next = (path: string) => `${GRAPH_API_BASE_URL}${path}`;
    const { client } = graphStub({
      [SEARCH_URL]: pageOf([site("a")], next("/sites?search=*&$skiptoken=s2")),
      [next("/sites?search=*&$skiptoken=s2")]: pageOf([site("b")]),
      [FOLLOWED_URL]: pageOf([site("c")], next("/me/followedSites?$skiptoken=f2")),
      [next("/me/followedSites?$skiptoken=f2")]: pageOf([site("d")]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1")], next("/sites/a/drives?$skiptoken=d2")),
      [next("/sites/a/drives?$skiptoken=d2")]: pageOf([drive("da2")]),
      [drivesUrl(siteId("b"))]: pageOf([drive("db1")]),
      [drivesUrl(siteId("c"))]: pageOf([drive("dc1")]),
      [drivesUrl(siteId("d"))]: pageOf([drive("dd1")]),
    });
    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(libIds(prisma).sort()).toEqual(["da1", "da2", "db1", "dc1", "dd1"]);
    expect(found.sharePoint?.complete).toBe(true);
  });

  it("registers in a deterministic order: followed sites first, then by web URL", async () => {
    // The cap keeps the FIRST 100, so the order decides which libraries survive
    // it. It must not depend on which source answered first or on how Graph
    // happened to order a page.
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub({
      [SEARCH_URL]: pageOf([site("m"), site("c"), site("x")]),
      [FOLLOWED_URL]: pageOf([site("z"), site("b")]),
      [drivesUrl(siteId("m"))]: pageOf([drive("dm")]),
      [drivesUrl(siteId("c"))]: pageOf([drive("dc")]),
      [drivesUrl(siteId("x"))]: pageOf([drive("dx")]),
      [drivesUrl(siteId("z"))]: pageOf([drive("dz")]),
      [drivesUrl(siteId("b"))]: pageOf([drive("db")]),
    });
    await discoverResources(depsFor(prisma, client), USER);

    const registeredDrives = prisma.__order().filter((o) => o.startsWith("source:")).map((o) => o.slice("source:".length));
    // The OneDrive source registers too (it has no site and comes first, from the
    // `files` workload); the libraries follow it in site order.
    expect(registeredDrives.filter((d) => d !== "od-1")).toEqual(["db", "dz", "dc", "dm", "dx"]);
  });

  it("registers the cursor BEFORE its source row, so a crash between leaves a syncing cursor, not a row that claims one", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub({
      [SEARCH_URL]: pageOf([site("a")]),
      [FOLLOWED_URL]: pageOf([]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1")]),
    });
    await discoverResources(depsFor(prisma, client), USER);
    // (The calendar and OneDrive singletons register too: cursor "-", and the
    // OneDrive's own source.)
    expect(prisma.__order().filter((o) => !o.endsWith(":-") && o !== "source:od-1")).toEqual(["cursor:da1", "source:da1"]);
  });

  it("is idempotent: a second pass over the same answer changes nothing it should not", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const routes = {
      [SEARCH_URL]: pageOf([site("a")]),
      [FOLLOWED_URL]: pageOf([]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1")]),
    };
    await discoverResources(depsFor(prisma, graphStub(routes).client), USER);
    await discoverResources(depsFor(prisma, graphStub(routes).client), USER);
    expect(spCursors(prisma)).toEqual(["da1"]);
    expect(libIds(prisma)).toEqual(["da1"]);
  });

  it("refreshes a renamed library's names in place", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const answer = (name: string) => ({
      [SEARCH_URL]: pageOf([site("a")]),
      [FOLLOWED_URL]: pageOf([]),
      [drivesUrl(siteId("a"))]: pageOf([drive("da1", { name })]),
    });
    await discoverResources(depsFor(prisma, graphStub(answer("Consents")).client), USER);
    await discoverResources(depsFor(prisma, graphStub(answer("Signed consents")).client), USER);
    expect(libraries(prisma)).toHaveLength(1);
    expect(unsealSourceField({ provider: "M365", userId: USER, sourceId: "da1" }, "name", libraries(prisma)[0]!.nameEnc as string)).toBe("Signed consents");
  });
});

// --- the cap -----------------------------------------------------------------

describe("discoverResources — the per-person library cap (WARP-3538)", () => {
  /** One site with `n` libraries named d000, d001, … */
  function oneSiteWith(n: number) {
    const ids = Array.from({ length: n }, (_, i) => `d${String(i).padStart(3, "0")}`);
    return graphStub({
      [SEARCH_URL]: pageOf([site("a")]),
      [FOLLOWED_URL]: pageOf([]),
      [drivesUrl(siteId("a"))]: pageOf(ids.map((id) => drive(id))),
    });
  }

  it("is 100, exported and documented", () => {
    expect(MAX_SHAREPOINT_LIBRARIES_PER_PERSON).toBe(100);
  });

  it("registers the first 100 and reports how many it did not", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const found = await discoverResources(depsFor(prisma, oneSiteWith(105).client), USER);

    expect(spCursors(prisma)).toHaveLength(MAX_SHAREPOINT_LIBRARIES_PER_PERSON);
    expect(libIds(prisma)).toHaveLength(MAX_SHAREPOINT_LIBRARIES_PER_PERSON);
    expect(found.sharePoint).toMatchObject({ registered: 100, dropped: 5, complete: true });
    // The ones dropped are the tail of the deterministic order — never a random 5.
    expect(libIds(prisma)).not.toContain("d100");
    expect(libIds(prisma)).toContain("d099");
    // …and the count is kept where the card can read it.
    expect(prisma.__capped()).toBe(5);
  });

  it("registers everything and records zero when there is room — and clears a stale count", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, capped: 7 });
    const found = await discoverResources(depsFor(prisma, oneSiteWith(3).client), USER);
    expect(found.sharePoint).toMatchObject({ registered: 3, dropped: 0, complete: true });
    expect(prisma.__capped()).toBe(0);
  });

  it("does not rewrite a count that has not changed", async () => {
    // The row carries @updatedAt; a write per tick per person for nothing is
    // churn the sync tick should not add.
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, capped: 5 });
    await discoverResources(depsFor(prisma, oneSiteWith(105).client), USER);
    expect(prisma.m365Connection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sharePointLibrariesCapped: { not: 5 } }) }),
    );
    expect(prisma.__capped()).toBe(5);
  });

  it("prunes a library that fell off the end of the cap, along with its cursor and landed rows", async () => {
    // Followed-first ordering means a newly followed site can displace the
    // tail. What is no longer registered is no longer READ, and what it landed
    // goes with it — a dropped library's files must not linger as search hits.
    const prisma = fakePrisma({
      grantedScopes: WITH_SITES,
      cursors: [{ userId: USER, workload: "sharepoint", resourceId: "d100" }],
      libraries: [{ userId: USER, sourceId: "d100" }],
      items: [[USER, "d100", "i1"]],
    });
    await discoverResources(depsFor(prisma, oneSiteWith(105).client), USER);

    expect(spCursors(prisma)).not.toContain("d100");
    expect(libIds(prisma)).not.toContain("d100");
    expect(prisma.__items()).toEqual([]);
  });
});

// --- pruning -----------------------------------------------------------------

describe("discoverResources — pruning libraries that are gone (WARP-3538)", () => {
  const seeded = () => ({
    oneDriveFor: [USER],
    cursors: [
      { userId: USER, workload: "sharepoint", resourceId: "keep" },
      { userId: USER, workload: "sharepoint", resourceId: "gone" },
      { userId: USER, workload: "files", resourceId: "-" },
      { userId: OTHER, workload: "sharepoint", resourceId: "gone" },
    ],
    libraries: [
      { userId: USER, sourceId: "keep" },
      { userId: USER, sourceId: "gone" },
      { userId: OTHER, sourceId: "gone" },
    ],
    items: [
      [USER, "keep", "k1"],
      [USER, "gone", "g1"],
      [USER, `od-${USER}`, "o1"],
      [OTHER, "gone", "g2"],
    ] as Array<[string, string, string]>,
  });

  const answer = (sites: Route, drives: Route) =>
    graphStub({
      [SEARCH_URL]: sites,
      [FOLLOWED_URL]: pageOf([]),
      [drivesUrl(siteId("a"))]: drives,
    });

  it("after a COMPLETE discovery, deletes the cursors, rows and landed items of a library no longer found", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, ...seeded() });
    const { client } = answer(pageOf([site("a")]), pageOf([drive("keep")]));

    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(found.sharePoint).toMatchObject({ complete: true, pruned: 1 });
    expect(spCursors(prisma)).toEqual(["keep"]);
    expect(libIds(prisma)).toEqual(["keep"]);
    expect(itemIds(prisma)).toEqual([`${USER}/keep/k1`, `${USER}/od-${USER}/o1`, `${OTHER}/gone/g2`]);
  });

  it("touches nobody else's rows and never OneDrive's", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, ...seeded() });
    await discoverResources(depsFor(prisma, answer(pageOf([site("a")]), pageOf([drive("keep")])).client), USER);

    expect(prisma.__cursors()).toContainEqual({ userId: OTHER, workload: "sharepoint", resourceId: "gone" });
    expect(prisma.__cursors()).toContainEqual({ userId: USER, workload: "files", resourceId: "-" });
    expect(libIds(prisma, OTHER)).toEqual(["gone"]);
    expect(itemIds(prisma)).toContain(`${OTHER}/gone/g2`);
    expect(itemIds(prisma)).toContain(`${USER}/od-${USER}/o1`);
    expect(prisma.__sources().some((s) => s.userId === USER && s.kind === "ONEDRIVE")).toBe(true);
  });

  // 🔴 The guard this whole block exists for. Each case below fails PARTWAY and
  // must delete nothing: pruning on a partial listing would remove a library
  // because Microsoft hiccuped, and take the person's landed file list with it.
  it.each([
    ["the site search fails", { search: refused(), followed: pageOf([site("a")]), drives: pageOf([drive("keep")]) }],
    ["the followed-sites listing fails", { search: pageOf([site("a")]), followed: refused(), drives: pageOf([drive("keep")]) }],
    ["one site's library listing fails", { search: pageOf([site("a")]), followed: pageOf([]), drives: refused() }],
  ])("prunes NOTHING when %s", async (_label, r) => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, ...seeded() });
    const { client } = graphStub({
      [SEARCH_URL]: r.search,
      [FOLLOWED_URL]: r.followed,
      [drivesUrl(siteId("a"))]: r.drives,
    });

    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(found.sharePoint?.complete).toBe(false);
    expect(found.sharePoint?.incompleteBecause).toBe("listing_failed");
    expect(found.sharePoint?.pruned).toBe(0);
    expect(spCursors(prisma).sort()).toEqual(["gone", "keep"]);
    expect(libIds(prisma).sort()).toEqual(["gone", "keep"]);
    expect(prisma.__items()).toHaveLength(4);
    // Said out loud, not passed over: a partial walk that looks complete is the
    // silent gap this reports against.
    expect(found.skipped).toEqual(["sharepoint (partial)"]);
  });

  it("prunes NOTHING when a listing runs into the page bound — and says so", async () => {
    // A tenant with more sites than one tick may read. The walk stops, registers
    // what it reached, and must not read "I did not get to it" as "it is gone".
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, ...seeded() });
    const endless = (n: number) => `${GRAPH_API_BASE_URL}/sites?search=*&$skiptoken=p${n}`;
    const getPage = vi.fn(async (url: string) => {
      if (url === SEARCH_URL) return pageOf([], endless(1));
      if (url === ONEDRIVE_URL) return oneDrive(MY_DRIVE);
      const m = /\$skiptoken=p(\d+)$/.exec(url);
      if (m) return pageOf([], endless(Number(m[1]) + 1));
      return pageOf([]); // followed sites, and the mail and contact folder walks
    });

    const found = await discoverResources(depsFor(prisma, { getPage } as never), USER);

    expect(found.sharePoint?.complete).toBe(false);
    expect(found.sharePoint?.incompleteBecause).toBe("page_bound");
    expect(found.skipped).toEqual(["sharepoint (partial)"]);
    expect(spCursors(prisma).sort()).toEqual(["gone", "keep"]);
    // Bounded: the whole discovery shares ONE page budget, so an endless listing
    // cannot turn a tick into an unbounded crawl of the tenant.
    expect(siteRequests(getPage.mock.calls.map((c) => String(c[0]))).length).toBeLessThanOrEqual(
      MAX_PAGES_PER_TICK,
    );
  });

  it("shares one page budget across every listing, so many sites cannot multiply the bound", async () => {
    // 150 sites, each with a library listing: 1 search page + 1 followed page +
    // 150 drive pages is inside the budget; 250 sites is not, and the walk must
    // stop and say so rather than spend 250 requests per tick per person.
    const many = (n: number) => Array.from({ length: n }, (_, i) => site(`s${String(i).padStart(3, "0")}`));
    const run = async (n: number) => {
      const sites = many(n);
      const routes: Record<string, Route> = { [SEARCH_URL]: pageOf(sites), [FOLLOWED_URL]: pageOf([]) };
      for (const s of sites) routes[drivesUrl(String(s.id))] = pageOf([drive(`d-${String(s.id)}`)]);
      const stub = graphStub(routes);
      const prisma = fakePrisma({ grantedScopes: WITH_SITES });
      const found = await discoverResources(depsFor(prisma, stub.client), USER);
      return { found, requests: siteRequests(stub.requested).length };
    };

    const within = await run(150);
    expect(within.found.sharePoint?.complete).toBe(true);

    const beyond = await run(250);
    expect(beyond.found.sharePoint?.complete).toBe(false);
    expect(beyond.found.sharePoint?.incompleteBecause).toBe("page_bound");
    expect(beyond.requests).toBeLessThanOrEqual(MAX_PAGES_PER_TICK);
  });

  it("prunes NOTHING when a complete walk finds no libraries at all while some are registered", async () => {
    // An EMPTY answer to a question that had answers yesterday is not a complete
    // answer. `search=*` is an undocumented spelling (graph-resources.ts): if
    // Microsoft ever stops honouring it, "no sites" would read as "every library
    // is gone" and delete the person's whole landed file list in one tick.
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, ...seeded() });
    const { client } = graphStub({ [SEARCH_URL]: pageOf([]), [FOLLOWED_URL]: pageOf([]) });

    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(found.sharePoint?.complete).toBe(false);
    expect(found.sharePoint?.incompleteBecause).toBe("empty_answer");
    expect(spCursors(prisma).sort()).toEqual(["gone", "keep"]);
    expect(prisma.__items()).toHaveLength(4);
  });

  it("distrusts an empty answer when only a CURSOR is registered — the thing that is actually read", async () => {
    // "Registered" is the cursor, not the display row: a crash between the two
    // writes of an earlier discovery leaves a cursor with no row, and an empty
    // answer must not be trusted to delete it either.
    const prisma = fakePrisma({
      grantedScopes: WITH_SITES,
      cursors: [{ userId: USER, workload: "sharepoint", resourceId: "orphan" }],
      items: [[USER, "orphan", "i1"]],
    });
    const { client } = graphStub({ [SEARCH_URL]: pageOf([]), [FOLLOWED_URL]: pageOf([]) });
    const found = await discoverResources(depsFor(prisma, client), USER);
    expect(found.sharePoint?.incompleteBecause).toBe("empty_answer");
    expect(spCursors(prisma)).toEqual(["orphan"]);
    expect(prisma.__items()).toHaveLength(1);
  });

  it("removes a library that has a cursor and no row once a complete walk no longer sees it", async () => {
    const prisma = fakePrisma({
      grantedScopes: WITH_SITES,
      cursors: [{ userId: USER, workload: "sharepoint", resourceId: "orphan" }],
      items: [[USER, "orphan", "i1"]],
    });
    const { client } = answer(pageOf([site("a")]), pageOf([drive("keep")]));
    await discoverResources(depsFor(prisma, client), USER);
    expect(spCursors(prisma)).toEqual(["keep"]);
    expect(itemIds(prisma)).toEqual([]);
  });

  it("is complete, with nothing to prune, when there are none registered and none found", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub({ [SEARCH_URL]: pageOf([]), [FOLLOWED_URL]: pageOf([]) });
    const found = await discoverResources(depsFor(prisma, client), USER);
    expect(found.sharePoint).toMatchObject({ registered: 0, dropped: 0, complete: true, pruned: 0 });
    expect(found.skipped).toEqual([]);
  });

  it("does not overwrite the cap count from a discovery that could not tell", async () => {
    const prisma = fakePrisma({ grantedScopes: WITH_SITES, capped: 5 });
    const { client } = graphStub({ [SEARCH_URL]: refused(), [FOLLOWED_URL]: pageOf([site("a")]), [drivesUrl(siteId("a"))]: pageOf([drive("d1")]) });
    await discoverResources(depsFor(prisma, client), USER);
    expect(prisma.__capped()).toBe(5);
  });
});

// --- failure -----------------------------------------------------------------

describe("discoverResources — SharePoint failing is non-fatal and named (WARP-3538)", () => {
  it("names `sharepoint` as skipped when no site listing answers, and changes nothing", async () => {
    const prisma = fakePrisma({
      grantedScopes: WITH_SITES,
      cursors: [{ userId: USER, workload: "sharepoint", resourceId: "keep" }],
      libraries: [{ userId: USER, sourceId: "keep" }],
    });
    const { client } = graphStub({ [SEARCH_URL]: refused(), [FOLLOWED_URL]: refused(503) });

    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(found.skipped).toEqual(["sharepoint"]);
    expect(found.sharePoint).toBeNull();
    expect(spCursors(prisma)).toEqual(["keep"]);
    expect(libIds(prisma)).toEqual(["keep"]);
  });

  it("does not let SharePoint stop the other workloads from registering", async () => {
    // A tenant whose SharePoint is unreachable must still sync OneDrive and the
    // calendar: failure is per-workload, like every other.
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub({ [SEARCH_URL]: refused(), [FOLLOWED_URL]: refused() });
    const found = await discoverResources(depsFor(prisma, client), USER);
    expect(found.registered).toBe(1); // OneDrive still runs when calendar import is off
    expect(prisma.__cursors().map((c) => c.workload).sort()).toEqual(["files"]);
  });

  it("registers nothing if the person switched SharePoint off while the walk was in flight", async () => {
    // The listing takes seconds; the switch takes a click. Re-reading the flag
    // right before the writes shrinks the race from "the whole walk" to a few
    // milliseconds — the tick after that cleans up whatever is left.
    const prisma = fakePrisma({ grantedScopes: WITH_SITES });
    const { client } = graphStub(
      {
        [SEARCH_URL]: pageOf([site("a")]),
        [FOLLOWED_URL]: pageOf([]),
        [drivesUrl(siteId("a"))]: pageOf([drive("da1")]),
      },
      (url) => {
        if (url === drivesUrl(siteId("a"))) prisma.__setEnabled(false); // clicked mid-walk
      },
    );

    const found = await discoverResources(depsFor(prisma, client), USER);

    expect(spCursors(prisma)).toEqual([]);
    expect(libIds(prisma)).toEqual([]);
    expect(found.sharePoint).toBeNull();
    expect(found.disabled).toEqual(["calendar", "sharepoint"]);
  });
});
