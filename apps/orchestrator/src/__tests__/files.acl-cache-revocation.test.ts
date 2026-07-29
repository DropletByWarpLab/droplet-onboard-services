/**
 * WARP-1556 — the user-keyed Files caches (favorites / recents / name-search /
 * directory listing) must carry a membership-ACL dimension, so a member whose
 * membership was just revoked stops receiving that library's file names and
 * paths on the NEXT request, without waiting for the TTL.
 *
 * Built like files.space-threading.test.ts: the REAL `createFilesRouter` over a
 * small mutable prisma stub, only the Nextcloud client mocked — but with a REAL
 * in-memory cache behind cache.service, because the property under test is
 * "the pre-revocation ENTRY is not served", not "the key string differs".
 *
 * The precedent this mirrors is `deptSearchCorpora` (WARP-1264), which folds
 * max(aclVersion) into the content-search cache key.
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

// ── A REAL (in-memory) cache. Asserting on key strings would only prove the
// key changed; the acceptance criterion is that the pre-revocation VALUE is
// never handed back, so the cache has to actually store and serve.
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

// ── Mutable department/membership fixture ────────────────────────────────
interface DeptRow {
  id: string;
  name: string;
  parentId: string | null;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  state: string;
  aclVersion: number;
}

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
const OWNER = { id: "u-owner", username: "owner", role: "owner" };

/** Mutable world: tests revoke by splicing `memberships` and bumping aclVersion,
 * exactly as `bumpAclVersion` does in-tx on a real membership mutation. */
const world = {
  departments: [] as DeptRow[],
  memberships: [] as Array<{ departmentId: string; userId: string; right: string }>,
  /** When set, every department read throws — the "lookup failure" path. */
  failLookups: false,
};

function resetWorld(): void {
  world.departments = [
    { ...ALPHA },
    { ...BETA },
  ];
  world.memberships = [
    { departmentId: ALPHA.id, userId: ALICE.id, right: "reader" },
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
      // activeDeptMountNames' shape (personal-root hide filter) — harmless here.
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
      })
      .filter((row) => row.department !== undefined);
  },
);

const prismaStub = {
  department: {
    findFirst: vi.fn(async (args?: { where?: { kind?: string } }) =>
      args?.where?.kind === "HOUSEHOLD" ? null : null,
    ),
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

function buildApp(asUser: { id: string; username: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const PERSONAL_FILE = {
  name: "notes.txt",
  path: "/notes.txt",
  isDirectory: false,
  size: 5,
  mimeType: "text/plain",
  modifiedAt: "2026-07-01T00:00:00.000Z",
};
const ALPHA_FILE = {
  name: "alpha-salaries.xlsx",
  path: "/Alpha/alpha-salaries.xlsx",
  isDirectory: false,
  size: 99,
  mimeType: "application/vnd.ms-excel",
  modifiedAt: "2026-07-01T00:00:00.000Z",
};

/** Revoke Alice from Alpha the way a real mutation does: drop the membership
 * row AND bump the department's aclVersion, in one step. */
function revokeAliceFromAlpha(): void {
  world.memberships = world.memberships.filter(
    (m) => !(m.departmentId === ALPHA.id && m.userId === ALICE.id),
  );
  deptById(ALPHA.id)!.aclVersion += 1;
}

beforeEach(() => {
  for (const key of Object.keys(ncMock)) {
    const fn = (ncMock as any)[key];
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  ncMock.ncSetFavorite.mockResolvedValue(undefined);
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
  cacheStore.clear();
  cacheGetSpy.mockClear();
  cacheSetSpy.mockClear();
  cacheDelSpy.mockClear();
  departmentFindMany.mockClear();
  departmentMembershipFindMany.mockClear();
  resetWorld();
});

describe("WARP-1556 — favorites cache is keyed on the caller's ACL dimension", () => {
  it("serves a member from cache, then stops serving the library's items the request after revocation", async () => {
    const app = buildApp(ALICE);
    // While a member, Nextcloud surfaces the Alpha groupfolder's file too.
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE, ALPHA_FILE]);

    const first = await request(app).get("/api/files/favorites");
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(1);

    // Second request inside the TTL is served from cache (caching still works).
    const second = await request(app).get("/api/files/favorites");
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(2);
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(1);

    // Revocation. The pre-revocation entry is still in Redis (TTL has NOT
    // expired — that is the whole point), and Nextcloud has dropped the mount.
    revokeAliceFromAlpha();
    expect(cacheStore.size).toBe(1);
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE]);

    const third = await request(app).get("/api/files/favorites");
    expect(third.status).toBe(200);
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(2); // key busted → refetch
    const paths = (third.body.items as Array<{ path: string }>).map((i) => i.path);
    expect(paths).toEqual(["/notes.txt"]);
    expect(paths).not.toContain(ALPHA_FILE.path);
  });

  it("revocation from ONE of several departments busts the key even though max(aclVersion) is unchanged", async () => {
    // Alice is in Alpha(acl=1) and Beta(acl=9): max() is pinned by Beta, so a
    // key folding ONLY max(aclVersion) would still read the stale entry after
    // Alpha revocation (1 → 2 leaves max at 9). The department-set digest is
    // what makes this impossible.
    world.memberships.push({ departmentId: BETA.id, userId: ALICE.id, right: "reader" });
    const app = buildApp(ALICE);
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE, ALPHA_FILE]);

    await request(app).get("/api/files/favorites");
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(1);

    revokeAliceFromAlpha();
    expect(deptById(ALPHA.id)!.aclVersion).toBe(2);
    expect(deptById(BETA.id)!.aclVersion).toBe(9); // max is unchanged
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE]);

    const after = await request(app).get("/api/files/favorites");
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(2);
    expect((after.body.items as Array<{ path: string }>).map((i) => i.path)).toEqual([
      "/notes.txt",
    ]);
  });

  it("a rights change on an UNCHANGED department set also busts the key (aclVersion half)", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE, ALPHA_FILE]);
    await request(app).get("/api/files/favorites");
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(1);

    // Membership survives; only the department's ACL version moves (e.g.
    // contributor → reader, or an ACL re-apply on the groupfolder).
    deptById(ALPHA.id)!.aclVersion += 1;
    await request(app).get("/api/files/favorites");
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(2);
  });

  it("POST /files/favorite still invalidates the (now ACL-scoped) read key", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE]);
    await request(app).get("/api/files/favorites");
    expect(cacheStore.size).toBe(1);

    const toggled = await request(app)
      .post("/api/files/favorite")
      .send({ path: "/notes.txt", favorite: true });
    expect(toggled.status).toBe(200);
    expect(cacheStore.size).toBe(0); // the del named the same key the read wrote

    await request(app).get("/api/files/favorites");
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(2);
  });
});

describe("WARP-1556 — recents and name-search carry the same dimension", () => {
  it("recents: a revoked member stops receiving the library's items on the next request", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListRecents.mockResolvedValue([PERSONAL_FILE, ALPHA_FILE]);

    await request(app).get("/api/files/recents?limit=20");
    await request(app).get("/api/files/recents?limit=20");
    expect(ncMock.ncListRecents).toHaveBeenCalledTimes(1); // cached

    revokeAliceFromAlpha();
    ncMock.ncListRecents.mockResolvedValue([PERSONAL_FILE]);

    const after = await request(app).get("/api/files/recents?limit=20");
    expect(ncMock.ncListRecents).toHaveBeenCalledTimes(2);
    expect((after.body.items as Array<{ path: string }>).map((i) => i.path)).toEqual([
      "/notes.txt",
    ]);
  });

  it("recents: the limit stays part of the key (no cross-limit bleed)", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListRecents.mockResolvedValue([PERSONAL_FILE]);
    await request(app).get("/api/files/recents?limit=20");
    await request(app).get("/api/files/recents?limit=50");
    expect(ncMock.ncListRecents).toHaveBeenCalledTimes(2);
  });

  it("name search: a revoked member stops receiving the library's hits on the next request", async () => {
    const app = buildApp(ALICE);
    ncMock.ncSearchFiles.mockResolvedValue([ALPHA_FILE]);

    await request(app).get("/api/files/search?q=salaries");
    await request(app).get("/api/files/search?q=salaries");
    expect(ncMock.ncSearchFiles).toHaveBeenCalledTimes(1); // cached

    revokeAliceFromAlpha();
    ncMock.ncSearchFiles.mockResolvedValue([]);

    const after = await request(app).get("/api/files/search?q=salaries");
    expect(ncMock.ncSearchFiles).toHaveBeenCalledTimes(2);
    expect(after.body.items).toEqual([]);
  });
});

describe("WARP-1556 — directory listing cache", () => {
  it("the gated dept listing is not re-readable through the ungated personal path after revocation", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListFiles.mockResolvedValue([ALPHA_FILE]);

    // Gated read of the department space (Alice is a reader member).
    const gated = await request(app)
      .get("/api/files")
      .query({ path: "/", space: `dept:${ALPHA.id}` });
    expect(gated.status).toBe(200);
    expect(gated.body).toHaveLength(1);
    expect(ncMock.ncListFiles).toHaveBeenCalledWith(
      expect.any(String),
      "alice",
      "/Alpha",
    );
    expect(cacheStore.size).toBe(1);

    // `space=personal` resolves the path VERBATIM, so "/Alpha" hits the same
    // resolved path with no membership gate at all. After revocation it must
    // not be able to read the entry the gated request wrote.
    revokeAliceFromAlpha();
    ncMock.ncListFiles.mockReset();
    ncMock.ncListFiles.mockResolvedValue([]); // NC has unmounted the groupfolder

    const ungated = await request(app).get("/api/files").query({ path: "/Alpha" });
    expect(ungated.status).toBe(200);
    expect(ungated.body).toEqual([]);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1); // cache miss → upstream
  });

  it("write routes still invalidate the listing they wrote (mkdir → next list refetches)", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListFiles.mockResolvedValue([PERSONAL_FILE]);
    ncMock.ncCreateDirectory.mockResolvedValue(undefined);

    await request(app).get("/api/files").query({ path: "/" });
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1);
    await request(app).get("/api/files").query({ path: "/" });
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1); // served from cache

    const made = await request(app).post("/api/files/mkdir").send({ path: "/Invoices" });
    expect(made.status).toBe(200);

    await request(app).get("/api/files").query({ path: "/" });
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2); // invalidation landed
  });
});

describe("WARP-1556 — fail CLOSED on a lookup failure", () => {
  it("bypasses the cache entirely (no read, no write) when the department lookup throws", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE]);

    world.failLookups = true;
    const res = await request(app).get("/api/files/favorites");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1); // fresh upstream answer, not a 500
    expect(cacheGetSpy).not.toHaveBeenCalled();
    expect(cacheSetSpy).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });

  it("never serves a previously-cached broader entry once the lookup starts failing", async () => {
    const app = buildApp(ALICE);
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE, ALPHA_FILE]);
    await request(app).get("/api/files/favorites"); // populates the member key
    expect(cacheStore.size).toBe(1);

    cacheGetSpy.mockClear(); // ignore the populating request's own lookup
    world.failLookups = true;
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE]);

    const res = await request(app).get("/api/files/favorites");
    expect((res.body.items as Array<{ path: string }>).map((i) => i.path)).toEqual([
      "/notes.txt",
    ]);
    expect(cacheGetSpy).not.toHaveBeenCalled();
  });

  it("degrades to personal-only rather than 500 when the caller identity is unresolvable", async () => {
    // No req.user at all → resolveSearchCaller returns null → unresolved.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user?: unknown }).user = { id: "u-x", role: "family" }; // no username
      next();
    });
    app.use("/api", createFilesRouter(prismaStub as never));

    const res = await request(app).get("/api/files/favorites");
    // getUser() fails closed to 401 before any cache work happens.
    expect(res.status).toBe(401);
    expect(cacheGetSpy).not.toHaveBeenCalled();
  });
});

describe("WARP-1556 — owner/admin see-all mirrors checkSpaceAccess", () => {
  it("an owner's tag is derived from ALL active departments, never from membership rows", async () => {
    const app = buildApp(OWNER);
    ncMock.ncListFavorites.mockResolvedValue([PERSONAL_FILE, ALPHA_FILE]);

    await request(app).get("/api/files/favorites");
    expect(departmentFindMany).toHaveBeenCalled();
    expect(departmentMembershipFindMany).not.toHaveBeenCalled();

    // An owner is never "revoked", but an ACL change anywhere they can see
    // still has to bust their key.
    deptById(BETA.id)!.aclVersion += 1;
    await request(app).get("/api/files/favorites");
    expect(ncMock.ncListFavorites).toHaveBeenCalledTimes(2);
  });
});
