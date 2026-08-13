/**
 * WARP-1652 — two cache defects on the Files routes, both pre-existing.
 *
 * 1. The SEARCH key could collide across different searches.
 *    `aclScopedKey` joins its suffix segments with ":", which is unambiguous
 *    only while at most one segment is free-form and it comes last. `q` and
 *    `mime` are BOTH free-form and neither was terminal, so
 *      q="a",   mime="b:c"   and
 *      q="a:b", mime="c"
 *    produced the identical key: two different searches sharing one entry for
 *    the full SEARCH_TTL, the second caller served the first one's results.
 *
 *    Same class as WARP-1610 (the listing key) and the same blast radius —
 *    the key still carries the caller's own username and ACL tag, so this is
 *    content-MIXING for one user, not cross-tenant disclosure. Worth pinning
 *    precisely because WARP-1610 raised the bar on the sibling key while this
 *    one two functions away still concatenated raw user input.
 *
 * 2. `POST /files/trash/restore` invalidated nothing.
 *    Every other mutating route calls invalidateListing/invalidateParents.
 *    Restore did not, so a file restored into a cached directory stayed
 *    invisible for the full CACHE_TTL — it looked like the restore silently
 *    did nothing.
 *
 * Built like files.list-cache-space-key.test.ts: the REAL `createFilesRouter`
 * over a small prisma stub, only the Nextcloud client mocked, and a REAL
 * in-memory cache behind cache.service — so the property under test is "the
 * other search's ENTRY is not served", not "the key string differs".
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

const { cacheStore, cacheGetSpy, cacheSetSpy, cacheDelSpy, invalidatePrefixSpy } =
  vi.hoisted(() => {
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
      // The real one drops every key under the prefix; the stub does the same
      // over the in-memory map so "the listing is really gone" is observable.
      invalidatePrefixSpy: vi.fn(async (prefix: string) => {
        for (const key of [...store.keys()]) {
          if (key.startsWith(prefix)) store.delete(key);
        }
      }),
    };
  });

vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...a: [string]) => cacheGetSpy(...a),
  cacheSet: (...a: [string, unknown]) => cacheSetSpy(...a),
  cacheDel: (...a: [string]) => cacheDelSpy(...a),
  invalidatePrefix: (...a: [string]) => invalidatePrefixSpy(...a),
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

const ALICE = { id: "u-alice", username: "alice", role: "family" };

// No departments — the ACL dimension is not what this test is about, and an
// empty membership set still resolves a stable tag (see aclCacheTag).
const prismaStub = {
  department: {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
  },
  departmentMembership: {
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
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

const hit = (name: string) => ({
  name,
  path: `/${name}`,
  isDirectory: false,
  size: 1,
  mimeType: "text/plain",
  modifiedAt: "2026-04-16T00:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks drops call history but KEEPS queued `…Once` implementations,
  // so an unconsumed one would answer the next test. Reset the two upstreams
  // this file queues on. (Not resetAllMocks: that would also strip the prisma
  // stub's implementations, which the ACL tag needs.)
  ncMock.ncSearchFiles.mockReset();
  ncMock.ncListFiles.mockReset();
  ncMock.ncRestoreTrashItem.mockReset();
  cacheStore.clear();
  mockResolveNcToken.mockResolvedValue("nc-token");
});

describe("GET /api/files/search — cache key cannot alias two searches (WARP-1652)", () => {
  it("does not serve one search's results to a different search", async () => {
    const app = buildApp();

    // (q, mime) = ("ab", "c:d") — the colon inside the mime. Both queries are
    // ≥2 chars, below which the route short-circuits before the cache.
    ncMock.ncSearchFiles.mockResolvedValueOnce([hit("from-first-search.txt")]);
    const first = await request(app).get("/api/files/search").query({ q: "ab", mime: "c:d" });
    expect(first.status).toBe(200);
    expect(first.body.items).toEqual([hit("from-first-search.txt")]);

    // (q, mime) = ("ab:c", "d") — the SAME characters, a different split. Raw
    // ":"-joined both give the suffix "ab:c:d", so the call below was answered
    // out of the entry above without ever reaching Nextcloud.
    ncMock.ncSearchFiles.mockResolvedValueOnce([hit("from-second-search.txt")]);
    const second = await request(app).get("/api/files/search").query({ q: "ab:c", mime: "d" });

    expect(second.status).toBe(200);
    expect(second.body.items).toEqual([hit("from-second-search.txt")]);
    // The upstream really was consulted for the second search.
    expect(ncMock.ncSearchFiles).toHaveBeenCalledTimes(2);
  });

  it("still serves a REPEAT of the same search from cache", async () => {
    // The point of the key is to hit when the search is genuinely the same —
    // a digest that varied per call would "fix" the collision by disabling
    // the cache outright.
    const app = buildApp();
    ncMock.ncSearchFiles.mockResolvedValue([hit("stable.txt")]);

    await request(app).get("/api/files/search").query({ q: "budget", mime: "text/plain" });
    const again = await request(app)
      .get("/api/files/search")
      .query({ q: "budget", mime: "text/plain" });

    expect(again.body.items).toEqual([hit("stable.txt")]);
    expect(ncMock.ncSearchFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps distinguishing searches that differ only in mime", async () => {
    const app = buildApp();

    ncMock.ncSearchFiles.mockResolvedValueOnce([hit("as-pdf.pdf")]);
    await request(app).get("/api/files/search").query({ q: "report", mime: "application/pdf" });

    ncMock.ncSearchFiles.mockResolvedValueOnce([hit("as-text.txt")]);
    const text = await request(app)
      .get("/api/files/search")
      .query({ q: "report", mime: "text/plain" });

    expect(text.body.items).toEqual([hit("as-text.txt")]);
    expect(ncMock.ncSearchFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps distinguishing an absent mime from an empty one", async () => {
    const app = buildApp();

    ncMock.ncSearchFiles.mockResolvedValueOnce([hit("unfiltered.txt")]);
    await request(app).get("/api/files/search").query({ q: "report" });

    ncMock.ncSearchFiles.mockResolvedValueOnce([hit("filtered.txt")]);
    const filtered = await request(app)
      .get("/api/files/search")
      .query({ q: "report", mime: "text/plain" });

    expect(filtered.body.items).toEqual([hit("filtered.txt")]);
    expect(ncMock.ncSearchFiles).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/files/trash/restore — invalidates the listing (WARP-1652)", () => {
  it("stops serving a stale directory listing after a restore", async () => {
    const app = buildApp();

    // Prime the listing cache for the caller's root.
    ncMock.ncListFiles.mockResolvedValueOnce([hit("kept.txt")]);
    const before = await request(app).get("/api/files").query({ path: "/" });
    expect(before.body).toEqual([hit("kept.txt")]);

    // Served from cache — no second upstream call yet.
    await request(app).get("/api/files").query({ path: "/" });
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1);

    ncMock.ncRestoreTrashItem.mockResolvedValueOnce(undefined);
    const restored = await request(app)
      .post("/api/files/trash/restore")
      .send({ name: "restored.txt.d1700000000" });
    expect(restored.status).toBe(200);

    // The restored file has to be able to appear: the listing is re-fetched.
    ncMock.ncListFiles.mockResolvedValueOnce([hit("kept.txt"), hit("restored.txt")]);
    const after = await request(app).get("/api/files").query({ path: "/" });

    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2);
    expect(after.body).toEqual([hit("kept.txt"), hit("restored.txt")]);
  });

  it("sweeps only the caller's own listing namespace", async () => {
    // The sweep is coarse because `ncRestoreTrashItem` takes no destination
    // path — but coarse must still mean "this user", not "the whole cache".
    const app = buildApp();

    ncMock.ncListFiles.mockResolvedValueOnce([hit("kept.txt")]);
    await request(app).get("/api/files").query({ path: "/" });

    ncMock.ncRestoreTrashItem.mockResolvedValueOnce(undefined);
    await request(app).post("/api/files/trash/restore").send({ name: "x.d1700000000" });

    expect(invalidatePrefixSpy).toHaveBeenCalledWith("files:list:alice:");
  });

  it("does not invalidate when the restore itself failed", async () => {
    const app = buildApp();

    ncMock.ncListFiles.mockResolvedValueOnce([hit("kept.txt")]);
    await request(app).get("/api/files").query({ path: "/" });

    ncMock.ncRestoreTrashItem.mockRejectedValueOnce(new Error("nc: 500"));
    await request(app).post("/api/files/trash/restore").send({ name: "x.d1700000000" });

    // Nothing moved, so nothing to invalidate — the cached listing is still
    // correct and throwing it away would just cost a cold read.
    expect(invalidatePrefixSpy).not.toHaveBeenCalled();
  });
});
