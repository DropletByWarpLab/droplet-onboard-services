/**
 * WARP-1610 — the `files:list:` cache identity is (space, resolvedPath), not
 * the resolved path alone.
 *
 * The collision this pins down: a caller with a PERSONAL folder literally
 * named `Alpha` and membership of a DEPARTMENT named `Alpha` produces the same
 * resolved home-relative path `/Alpha` from two different spaces
 * (`?path=/Alpha` with no space, vs `?space=dept:<alpha>&path=/`). Before this
 * fix both landed on one cache entry and served each other's contents for the
 * whole CACHE_TTL.
 *
 * This is content-MIXING, not disclosure: Alice may legitimately see both
 * locations, which is exactly why WARP-1556's ACL tag cannot separate them —
 * same caller, same memberships, same tag. Only the space dimension can. Both
 * dimensions must survive, so the ACL-keying half is re-asserted here against
 * the LISTING key specifically (files.acl-cache-revocation.test.ts covers the
 * favorites/recents/search keys).
 *
 * Built like files.acl-cache-revocation.test.ts: the REAL `createFilesRouter`
 * over a small mutable prisma stub, only the Nextcloud client mocked, and a
 * REAL in-memory cache behind cache.service — the property under test is "the
 * other space's ENTRY is not served", not "the key string differs".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncListShares: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncListTrash: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncListVersions: vi.fn(),
    ncRestoreVersion: vi.fn(),
    ncSetFavorite: vi.fn(),
    ncListFavorites: vi.fn(),
    ncSearchFiles: vi.fn(),
    ncListRecents: vi.fn(),
    ncFetchThumbnail: vi.fn(),
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncListSharedWithMe: vi.fn(),
  };
});

const mockResolveNcToken = vi.fn();
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: (...a: unknown[]) => mockResolveNcToken(...a),
}));

const { cacheStore, cacheGetSpy, cacheSetSpy, cacheDelSpy } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    cacheStore: store,
    cacheGetSpy: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    cacheSetSpy: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    cacheDelSpy: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...a: [string]) => cacheGetSpy(...a),
  cacheSet: (...a: [string, unknown]) => cacheSetSpy(...a),
  cacheDel: (...a: [string]) => cacheDelSpy(...a),
}));

vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { createFilesRouter } from "../routes/files.js";
import * as nc from "../services/nextcloud.client.js";

type Mocked<T extends (...a: any[]) => any> = T & ReturnType<typeof vi.fn>;
const ncMock = nc as unknown as { [K in keyof typeof nc]: Mocked<any> };

// ── The colliding world ───────────────────────────────────────────────────
interface DeptRow {
  id: string;
  name: string;
  parentId: string | null;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
  aclVersion: number;
}

/** Mount name "Alpha" — the same string as Alice's own personal folder. */
const ALPHA: DeptRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Alpha",
  parentId: null,
  kind: "DEPARTMENT",
  state: "active",
  aclVersion: 1,
};
const BETA: DeptRow = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Beta",
  parentId: null,
  kind: "DEPARTMENT",
  state: "active",
  aclVersion: 9,
};

const ALICE = { id: "u-alice", username: "alice", role: "family" };

const world = {
  departments: [] as DeptRow[],
  memberships: [] as Array<{ departmentId: string; userId: string; right: string }>,
  failLookups: false,
};

function resetWorld(): void {
  world.departments = [{ ...ALPHA }, { ...BETA }];
  world.memberships = [
    { departmentId: ALPHA.id, userId: ALICE.id, right: "contributor" },
  ];
  world.failLookups = false;
}

function deptById(id: string): DeptRow | undefined {
  return world.departments.find((d) => d.id === id);
}

const departmentFindMany = vi.fn(async () => {
  if (world.failLookups) throw new Error("prisma: department lookup failed");
  return world.departments
    .filter((d) => d.state === "active")
    .map((d) => ({
      id: d.id,
      kind: d.kind,
      aclVersion: d.aclVersion,
      name: d.name,
      parentId: d.parentId,
      memberships: world.memberships.filter((m) => m.departmentId === d.id),
    }));
});

const departmentMembershipFindMany = vi.fn(
  async (args?: { where?: { userId?: string } }) => {
    if (world.failLookups) throw new Error("prisma: membership lookup failed");
    const userId = args?.where?.userId;
    return world.memberships
      .filter((m) => m.userId === userId)
      .map((m) => {
        const d = deptById(m.departmentId)!;
        return { department: { id: d.id, kind: d.kind, aclVersion: d.aclVersion } };
      });
  },
);

const prismaStub = {
  department: {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async (args?: { where?: { id?: string } }) => {
      const id = args?.where?.id;
      return (id && deptById(id)) ?? null;
    }),
    findMany: departmentFindMany,
  },
  departmentMembership: {
    findUnique: vi.fn(
      async (args?: {
        where?: { departmentId_userId?: { departmentId: string; userId: string } };
      }) => {
        const key = args?.where?.departmentId_userId;
        if (!key) return null;
        const found = world.memberships.find(
          (m) => m.departmentId === key.departmentId && m.userId === key.userId,
        );
        return found ? { right: found.right } : null;
      },
    ),
    findMany: departmentMembershipFindMany,
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof ALICE }).user = ALICE;
    next();
  });
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

/** Alice's OWN folder `/Alpha` — a personal directory that happens to share
 * its name with the department. */
const PERSONAL_ALPHA_ITEM = {
  name: "holiday-photos.jpg",
  path: "/Alpha/holiday-photos.jpg",
  isDirectory: false,
  size: 12,
  mimeType: "image/jpeg",
  modifiedAt: "2026-07-01T00:00:00.000Z",
};
/** Department Alpha's groupfolder, which mounts at the SAME `/Alpha`. */
const DEPT_ALPHA_ITEM = {
  name: "alpha-roadmap.md",
  path: "/Alpha/alpha-roadmap.md",
  isDirectory: false,
  size: 34,
  mimeType: "text/markdown",
  modifiedAt: "2026-07-01T00:00:00.000Z",
};

const DEPT_SPACE = `dept:${ALPHA.id}`;

/** Both spaces resolve to the WebDAV path `/Alpha`, so the Nextcloud stub
 * cannot tell them apart — that is precisely the collision. Distinguish by
 * call order instead, which models "two genuinely different listings". */
function serveInOrder(...responses: unknown[][]): void {
  ncMock.ncListFiles.mockReset();
  for (const r of responses) ncMock.ncListFiles.mockResolvedValueOnce(r);
  ncMock.ncListFiles.mockResolvedValue([]);
}

function listPersonalAlpha(app: express.Express) {
  return request(app).get("/api/files").query({ path: "/Alpha" });
}
function listDeptAlpha(app: express.Express) {
  return request(app).get("/api/files").query({ path: "/", space: DEPT_SPACE });
}
const names = (body: unknown) => (body as Array<{ name: string }>).map((e) => e.name);

beforeEach(() => {
  for (const key of Object.keys(ncMock)) {
    const fn = (ncMock as any)[key];
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  ncMock.ncCreateDirectory.mockResolvedValue(undefined);
  ncMock.ncMoveFile.mockResolvedValue(undefined);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
  cacheStore.clear();
  cacheGetSpy.mockClear();
  cacheSetSpy.mockClear();
  cacheDelSpy.mockClear();
  departmentFindMany.mockClear();
  departmentMembershipFindMany.mockClear();
  resetWorld();
});

describe("WARP-1610 — a personal folder and a same-named department library never cross-serve", () => {
  it("both resolve to /Alpha yet keep separate cache entries in both directions", async () => {
    const app = buildApp();
    serveInOrder([PERSONAL_ALPHA_ITEM], [DEPT_ALPHA_ITEM]);

    // 1. Personal read of the user's own `/Alpha` populates one entry.
    const personal = await listPersonalAlpha(app);
    expect(personal.status).toBe(200);
    expect(names(personal.body)).toEqual(["holiday-photos.jpg"]);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1);

    // 2. The gated department read resolves to the SAME path `/Alpha`...
    const dept = await listDeptAlpha(app);
    expect(dept.status).toBe(200);
    expect(ncMock.ncListFiles).toHaveBeenNthCalledWith(2, expect.any(String), "alice", "/Alpha");
    // ...and must NOT be served the personal entry (the pre-fix behaviour).
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2);
    expect(names(dept.body)).toEqual(["alpha-roadmap.md"]);
    expect(names(dept.body)).not.toContain("holiday-photos.jpg");

    // 3. Two live entries coexist — the dept read did not overwrite the
    //    personal one, so the personal listing is still served from cache and
    //    still shows the personal contents.
    expect(cacheStore.size).toBe(2);
    const personalAgain = await listPersonalAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2); // cache hit, no refetch
    expect(names(personalAgain.body)).toEqual(["holiday-photos.jpg"]);

    const deptAgain = await listDeptAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2); // cache hit, no refetch
    expect(names(deptAgain.body)).toEqual(["alpha-roadmap.md"]);
  });

  it("a write in ONE space invalidates only that space's listing", async () => {
    const app = buildApp();
    serveInOrder([PERSONAL_ALPHA_ITEM], [DEPT_ALPHA_ITEM]);
    await listPersonalAlpha(app);
    await listDeptAlpha(app);
    expect(cacheStore.size).toBe(2);

    // mkdir inside the PERSONAL /Alpha → parent "/Alpha" in space personal.
    const madePersonal = await request(app)
      .post("/api/files/mkdir")
      .send({ path: "/Alpha/Receipts" });
    expect(madePersonal.status).toBe(200);
    expect(cacheStore.size).toBe(1); // exactly one entry dropped

    serveInOrder([PERSONAL_ALPHA_ITEM, { ...PERSONAL_ALPHA_ITEM, name: "Receipts" }]);
    await listPersonalAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1); // refetched — invalidated
    await listDeptAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1); // untouched — still cached

    // mkdir inside the DEPARTMENT → resolves to "/Alpha/Specs", parent
    // "/Alpha" again, but in space dept:<alpha>.
    const madeDept = await request(app)
      .post("/api/files/mkdir")
      .send({ path: "/Specs", space: DEPT_SPACE });
    expect(madeDept.status).toBe(200);
    expect(cacheStore.size).toBe(1);

    serveInOrder([DEPT_ALPHA_ITEM]);
    await listDeptAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1); // refetched — invalidated
    await listPersonalAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1); // untouched — still cached
  });

  it("a CROSS-SPACE move invalidates BOTH sides even when both parents are /Alpha", async () => {
    // The per-path space threading this ticket is really about: one
    // `invalidateParents` call, two spaces, and — worst case — one parent
    // STRING. Deduping on the string alone would drop only one entry.
    const app = buildApp();
    serveInOrder([PERSONAL_ALPHA_ITEM], [DEPT_ALPHA_ITEM]);
    await listPersonalAlpha(app);
    await listDeptAlpha(app);
    expect(cacheStore.size).toBe(2);
    cacheDelSpy.mockClear();

    const moved = await request(app).post("/api/files/move").send({
      from: "/Alpha/holiday-photos.jpg",
      to: "/holiday-photos.jpg",
      toSpace: DEPT_SPACE, // fromSpace omitted → personal
    });
    expect(moved.status).toBe(200);
    expect(moved.body.moved).toEqual({
      from: "/Alpha/holiday-photos.jpg",
      to: "/Alpha/holiday-photos.jpg",
    });

    // Two distinct dels for the two distinct (space, "/Alpha") entries.
    expect(cacheDelSpy).toHaveBeenCalledTimes(2);
    const deleted = cacheDelSpy.mock.calls.map((c) => c[0]);
    expect(new Set(deleted).size).toBe(2);
    expect(cacheStore.size).toBe(0);

    // Both sides genuinely refetch.
    serveInOrder([], [DEPT_ALPHA_ITEM, PERSONAL_ALPHA_ITEM]);
    await listPersonalAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1);
    await listDeptAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2);
  });
});

describe("WARP-1610 — WARP-1556's ACL keying survives on the listing key", () => {
  it("a rights change on an unchanged department set still busts the listing (aclVersion half)", async () => {
    const app = buildApp();
    serveInOrder([DEPT_ALPHA_ITEM]);
    await listDeptAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1);
    await listDeptAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1); // cached

    deptById(ALPHA.id)!.aclVersion += 1;
    await listDeptAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2); // ACL tag moved
  });

  it("revocation from one of several departments busts it even though max(aclVersion) is unchanged (digest half)", async () => {
    // Alice in Alpha(acl=1) + Beta(acl=9): revoking Alpha leaves max() pinned
    // at 9, so only the department-set digest can bust the key.
    world.memberships.push({ departmentId: BETA.id, userId: ALICE.id, right: "reader" });
    const app = buildApp();
    // While a member, Nextcloud surfaces the mounted groupfolder's file too;
    // after revocation it has unmounted it.
    serveInOrder([DEPT_ALPHA_ITEM, PERSONAL_ALPHA_ITEM], [PERSONAL_ALPHA_ITEM]);

    // Read through the UNGATED personal path, which is where a revoked member
    // could otherwise keep reading the library out of Redis.
    const before = await listPersonalAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1);
    expect(names(before.body)).toContain("alpha-roadmap.md");

    world.memberships = world.memberships.filter(
      (m) => !(m.departmentId === ALPHA.id && m.userId === ALICE.id),
    );
    deptById(ALPHA.id)!.aclVersion += 1;
    expect(deptById(BETA.id)!.aclVersion).toBe(9); // max unchanged

    const after = await listPersonalAlpha(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2);
    expect(names(after.body)).toEqual(["holiday-photos.jpg"]);
  });

  it("fails CLOSED — no listing cache read or write while the department lookup throws", async () => {
    const app = buildApp();
    serveInOrder([PERSONAL_ALPHA_ITEM]);
    world.failLookups = true;

    const res = await listPersonalAlpha(app);
    expect(res.status).toBe(200); // fresh upstream answer, not a 500
    expect(names(res.body)).toEqual(["holiday-photos.jpg"]);
    expect(cacheGetSpy).not.toHaveBeenCalled();
    expect(cacheSetSpy).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });
});
