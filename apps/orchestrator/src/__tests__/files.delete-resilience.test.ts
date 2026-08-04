/**
 * WARP-1682 — a DELETE that fails must never leave a stale directory listing
 * behind, and a DELETE against an already-absent path must not read as a
 * failure.
 *
 * The reported symptom was "I get an error and the file is either still there
 * or disappears after a page reload". The listing cache is what makes the
 * second half possible: the pre-delete entry survives its CACHE_TTL, so a
 * refresh inside that window is served the file the user just deleted, and the
 * reload a few seconds later finally shows it gone.
 *
 * Two invalidation gaps are pinned here:
 *
 *   1. The route used to run `invalidateListing` only AFTER a successful
 *      `ncDeleteFile`. But routes/files.ts:2404 documents that Nextcloud's
 *      trashbin race can 500 a request whose file "ends up half-moved (trash
 *      entry created but source not unlinked)" — the one case where the cached
 *      listing is most certainly wrong is exactly the case that skipped the
 *      del. `bulk-delete` already invalidates unconditionally; single delete
 *      now matches it.
 *
 *   2. `invalidateListing` used to SKIP the del entirely when the ACL cache
 *      tag could not be resolved, reasoning that "nothing readable either".
 *      That treats a per-REQUEST condition as durable state: the entry being
 *      invalidated was written by an EARLIER request whose ACL walk did
 *      resolve, so a live key exists and is served stale for the rest of the
 *      TTL.
 *
 * Harness mirrors files.list-cache-space-key.test.ts: the REAL
 * `createFilesRouter` over a small mutable prisma stub, only the Nextcloud
 * client mocked, and a REAL in-memory cache behind cache.service — the
 * property under test is "the stale ENTRY is not served", not "some spy was
 * called".
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

const { cacheStore, cacheDelSpy, invalidatePrefixSpy } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    cacheStore: store,
    cacheDelSpy: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    invalidatePrefixSpy: vi.fn(async (prefix: string) => {
      let n = 0;
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          n++;
        }
      }
      return n;
    }),
  };
});

vi.mock("../services/cache.service.js", () => ({
  cacheGet: async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null),
  cacheSet: async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  },
  cacheDel: (...a: [string]) => cacheDelSpy(...a),
  invalidatePrefix: (...a: [string]) => invalidatePrefixSpy(...a),
}));

const publishSpy = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({ publish: (...a: unknown[]) => publishSpy(...a) }));

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

/** Transient failure switch for the department walk that backs the ACL cache
 *  tag — `visibleDeptsForCaller` swallows the throw and reports "unresolved",
 *  which is what makes `listCacheKey` return null. */
const world = { failLookups: false };

const prismaStub = {
  department: {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => {
      if (world.failLookups) throw new Error("prisma: department lookup failed");
      return [];
    }),
  },
  departmentMembership: {
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => {
      if (world.failLookups) throw new Error("prisma: membership lookup failed");
      return [];
    }),
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

const DOOMED = {
  name: "doomed.txt",
  path: "/docs/doomed.txt",
  isDirectory: false,
  size: 4,
  mimeType: "text/plain",
  modifiedAt: "2026-07-01T00:00:00.000Z",
};

const listDocs = (app: express.Express) =>
  request(app).get("/api/files").query({ path: "/docs" });
const deleteDoomed = (app: express.Express) =>
  request(app).delete("/api/files").query({ path: "/docs/doomed.txt" });
const names = (body: unknown) => (body as Array<{ name: string }>).map((e) => e.name);

beforeEach(() => {
  for (const key of Object.keys(ncMock)) {
    const fn = (ncMock as any)[key];
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  mockResolveNcToken.mockReset().mockResolvedValue("session-token");
  cacheStore.clear();
  cacheDelSpy.mockClear();
  invalidatePrefixSpy.mockClear();
  publishSpy.mockClear();
  world.failLookups = false;
});

describe("WARP-1682 — DELETE /api/files never leaves a stale listing behind", () => {
  it("invalidates the parent listing even when the WebDAV DELETE throws", async () => {
    const app = buildApp();

    // 1. A listing read populates the cache entry for /docs.
    ncMock.ncListFiles.mockResolvedValueOnce([DOOMED]);
    expect(names((await listDocs(app)).body)).toEqual(["doomed.txt"]);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(1);

    // 2. The delete hits the documented trashbin race: 500 upstream, but the
    //    source may well have been unlinked anyway.
    ncMock.ncDeleteFile.mockRejectedValueOnce(new Error("WebDAV DELETE failed: 500"));
    const del = await deleteDoomed(app);
    expect(del.status).toBeGreaterThanOrEqual(500);

    // 3. The next listing must go back upstream rather than replay the entry
    //    written in step 1 — the pre-fix behaviour served "doomed.txt" for the
    //    rest of the 10s TTL.
    ncMock.ncListFiles.mockResolvedValueOnce([]);
    const after = await listDocs(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2);
    expect(names(after.body)).toEqual([]);
  });

  it("does not publish a 'deleted' event when the WebDAV DELETE throws", async () => {
    const app = buildApp();
    ncMock.ncDeleteFile.mockRejectedValueOnce(new Error("WebDAV DELETE failed: 423"));

    await deleteDoomed(app);

    const deletedEvents = publishSpy.mock.calls.filter((c) =>
      String(c[0]).endsWith("/deleted"),
    );
    expect(deletedEvents).toHaveLength(0);
  });

  it("publishes and invalidates on a successful delete (unchanged behaviour)", async () => {
    const app = buildApp();
    ncMock.ncListFiles.mockResolvedValueOnce([DOOMED]);
    await listDocs(app);

    ncMock.ncDeleteFile.mockResolvedValueOnce("deleted");
    const del = await deleteDoomed(app);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe("/docs/doomed.txt");

    const deletedEvents = publishSpy.mock.calls.filter((c) =>
      String(c[0]).endsWith("/deleted"),
    );
    expect(deletedEvents).toHaveLength(1);

    ncMock.ncListFiles.mockResolvedValueOnce([]);
    await listDocs(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2);
  });

  it("answers 200, not 404, when the path is already absent upstream", async () => {
    const app = buildApp();
    // The client reports the idempotent outcome rather than throwing; the
    // route must treat it as the success it is.
    ncMock.ncDeleteFile.mockResolvedValueOnce("already-absent");

    const del = await deleteDoomed(app);

    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe("/docs/doomed.txt");
  });

  it("drops the stale entry when the ACL walk fails transiently during the delete", async () => {
    const app = buildApp();

    // 1. A healthy read resolves the ACL tag and writes a real cache entry.
    ncMock.ncListFiles.mockResolvedValueOnce([DOOMED]);
    expect(names((await listDocs(app)).body)).toEqual(["doomed.txt"]);
    expect(cacheStore.size).toBe(1);

    // 2. The delete succeeds upstream, but its ACL walk hits a DB hiccup, so
    //    the cache key cannot be named. Skipping the del here (the pre-fix
    //    behaviour) pins the step-1 entry for the rest of its TTL.
    world.failLookups = true;
    ncMock.ncDeleteFile.mockResolvedValueOnce("deleted");
    expect((await deleteDoomed(app)).status).toBe(200);
    world.failLookups = false;

    // 3. With the ACL walk healthy again the key is nameable — and must miss.
    ncMock.ncListFiles.mockResolvedValueOnce([]);
    const after = await listDocs(app);
    expect(ncMock.ncListFiles).toHaveBeenCalledTimes(2);
    expect(names(after.body)).toEqual([]);
  });
});
