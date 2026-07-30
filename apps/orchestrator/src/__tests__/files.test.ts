import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { MAX_FILES_PER_UPLOAD } from "@droplet/shared-types";

// Mock the ai-gateway client.
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    // departments.ts (registered by createApp) derefs this at module scope to
    // build RESERVED_NAMES; the real config zod-defaults it, so the mock must
    // carry it too or module load throws on undefined.toLowerCase(). (WARP-1292)
    DROPLET_SHARED_FOLDER_NAME: "Household",
    // camera-retention-purge.service.ts derefs this at module scope;
    // the real config defaults it, so the mock must carry it too.
    FRIGATE_URL: "http://frigate:5000",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Mock the Nextcloud client at the module level. Every route in files.ts
// now calls a function from this module, so stubbing it gives us full
// control over response shapes + lets us assert per-call arguments.
vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js"
  );
  return {
    // Re-export the real error class so handleFileError's instanceof check works
    NextcloudOcsError: actual.NextcloudOcsError,
    // File CRUD
    ncListFiles: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncCreateShare: vi.fn(),
    ncListShares: vi.fn(),
    // Phase 1
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncListTrash: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncListVersions: vi.fn(),
    ncRestoreVersion: vi.fn(),
    // Phase 2
    ncSetFavorite: vi.fn(),
    ncListFavorites: vi.fn(),
    ncSearchFiles: vi.fn(),
    ncListRecents: vi.fn(),
    ncFetchThumbnail: vi.fn(),
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncListSharedWithMe: vi.fn(),
    ncGetUserQuota: vi.fn(),
  };
});

import { createApp } from "../app.js";
import * as nc from "../services/nextcloud.client.js";
import { initDeviceService } from "../services/device.service.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

// WARP-237: capture emitted audit rows so the share-create / download
// emit points can be asserted (and the share password proven never to
// leak into refs). The singleton is a no-op unless a recorder is wired.
const recordedActivity: RecordParams[] = [];

type Mocked<T extends (...a: any[]) => any> = T & ReturnType<typeof vi.fn>;

// Cast so TypeScript lets us call .mockReturnValue etc. on each stub.
const ncMock = nc as unknown as {
  [K in keyof typeof nc]: Mocked<any>;
};

describe("File Operations (Nextcloud-backed routes)", () => {
  let app: ReturnType<typeof createApp>;
  // The mocked @prisma/client (setup.ts) returns the SAME singleton object
  // from every `new PrismaClient()` call — grabbing our own reference gives
  // per-test control over model mocks (e.g. userUsagePolicy.findUnique) that
  // the shared createApp() instance also reads from.
  let prismaMock: any;

  beforeAll(() => {
    const prisma = new PrismaClient();
    prismaMock = prisma;
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  afterAll(() => {
    _setActivityRecorderForTests(null, null);
  });

  beforeEach(() => {
    // WARP-237: fresh recorder capture per test.
    recordedActivity.length = 0;
    _setActivityRecorderForTests(
      {
        record: async (p) => {
          recordedActivity.push(p);
          return {} as never;
        },
      },
      null,
    );
    // Reset all nc mocks between tests.
    for (const key of Object.keys(ncMock)) {
      const fn = (ncMock as any)[key];
      if (typeof fn?.mockReset === "function") fn.mockReset();
    }
    // Default each mutation to succeed so tests only have to override failures.
    ncMock.ncCreateDirectory.mockResolvedValue(undefined);
    ncMock.ncUploadFile.mockResolvedValue(undefined);
    ncMock.ncDeleteFile.mockResolvedValue(undefined);
    ncMock.ncMoveFile.mockResolvedValue(undefined);
    ncMock.ncCopyFile.mockResolvedValue(undefined);
    ncMock.ncSetFavorite.mockResolvedValue(undefined);
    ncMock.ncEmptyTrash.mockResolvedValue(undefined);
    ncMock.ncRestoreTrashItem.mockResolvedValue(undefined);
    ncMock.ncDeleteTrashItem.mockResolvedValue(undefined);
    ncMock.ncRestoreVersion.mockResolvedValue(undefined);
    ncMock.ncUpdateShare.mockResolvedValue(undefined);
    ncMock.ncDeleteShare.mockResolvedValue(undefined);

    ncMock.ncListFiles.mockResolvedValue([]);
    ncMock.ncListTrash.mockResolvedValue([]);
    ncMock.ncListVersions.mockResolvedValue([]);
    ncMock.ncListFavorites.mockResolvedValue([]);
    ncMock.ncListRecents.mockResolvedValue([]);
    ncMock.ncSearchFiles.mockResolvedValue([]);
    ncMock.ncListSharedWithMe.mockResolvedValue([]);
    ncMock.ncListShares.mockResolvedValue([]);

    ncMock.ncGetFileId.mockResolvedValue(42);
  });

  // ── GET /api/files ──

  describe("GET /api/files", () => {
    it("returns the Nextcloud listing for a directory", async () => {
      ncMock.ncListFiles.mockResolvedValue([
        { name: "a.txt", path: "/a.txt", isDirectory: false, size: 5, mimeType: "text/plain", modifiedAt: "2026-04-01T00:00:00.000Z" },
      ]);

      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("a.txt");
      expect(ncMock.ncListFiles).toHaveBeenCalledWith(expect.any(String), "dev", "/");
    });

    it("defaults to root when path is omitted", async () => {
      const res = await request(app).get("/api/files");
      expect(res.status).toBe(200);
      expect(ncMock.ncListFiles).toHaveBeenCalledWith(expect.any(String), "dev", "/");
    });

    // WARP-938/WARP-1262 (security): the listing route resolves `path` through
    // rootForSpace(), which rejects `..` traversal before it ever reaches
    // ncListFiles/WebDAV. Lock that in for this route explicitly — the other
    // GET /api/files/* routes each have their own coverage, but this one
    // previously had none.
    it.each([
      "/Documents/../secret",
      "/../escape",
      "/a/b/../../c",
      "../relative",
      "/foo/..",
    ])("rejects a traversal path (%s) with 400 instead of forwarding to WebDAV", async (badPath) => {
      const res = await request(app)
        .get("/api/files")
        .query({ path: badPath });
      expect(res.status).toBe(400);
      expect(ncMock.ncListFiles).not.toHaveBeenCalled();
    });

    // Pre-encoded and raw (not via `.query({...})`, which would re-encode the
    // literal `%` and defeat the point) so it decodes to a `..` segment
    // exactly once, same as Express's query parser on a real request.
    it.each([
      "/api/files?path=%2e%2e%2Fescape",
      "/api/files?path=..%2fescape",
    ])("rejects an encoded traversal path (%s) with 400", async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(400);
      expect(ncMock.ncListFiles).not.toHaveBeenCalled();
    });
  });

  // ── Degrade-on-outage (Nextcloud down → 200 empty, not 500) ──
  //
  // When Nextcloud is unreachable a dashboard-polled GET must serve the
  // endpoint's empty shape so the file surfaces don't dead-end on a 500
  // during a backing-service outage (mirrors models-summary.service.ts).
  // Connectivity is simulated two ways: an undici "fetch failed" + a
  // cause.code, and a reachable-but-5xx WebDAV response.
  describe("Nextcloud-down degrade (read endpoints)", () => {
    const fetchFailed = () => {
      const e = new Error("fetch failed");
      (e as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      return e;
    };

    it("GET /api/files → 200 [] when Nextcloud is unreachable", async () => {
      ncMock.ncListFiles.mockRejectedValue(fetchFailed());
      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("GET /api/files/trash → 200 { items: [] } on a 5xx upstream", async () => {
      ncMock.ncListTrash.mockRejectedValue(
        new Error("WebDAV PROPFIND trashbin failed: 503"),
      );
      const res = await request(app).get("/api/files/trash");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it("GET /api/files/favorites → 200 { items: [] } when Nextcloud is unreachable", async () => {
      ncMock.ncListFavorites.mockRejectedValue(fetchFailed());
      const res = await request(app).get("/api/files/favorites");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it("GET /api/files/recents → 200 { items: [] } when Nextcloud is unreachable", async () => {
      ncMock.ncListRecents.mockRejectedValue(fetchFailed());
      const res = await request(app).get("/api/files/recents");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it("GET /api/files/shared-with-me → 200 { shares: [] } when Nextcloud is unreachable", async () => {
      ncMock.ncListSharedWithMe.mockRejectedValue(fetchFailed());
      const res = await request(app).get("/api/files/shared-with-me");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ shares: [] });
    });

    it("does NOT degrade a real (non-connectivity) error — a 403 still surfaces, not a 200 empty list", async () => {
      // A WebDAV 403 is a genuine authorization failure, not "Nextcloud is
      // down" — it must keep its non-degraded behavior (untyped → 500),
      // never be masked as an empty 200 list.
      ncMock.ncListFiles.mockRejectedValue(
        new Error("WebDAV PROPFIND failed: 403"),
      );
      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(500);
      expect(res.body).not.toEqual([]);
    });

    it("GET /api/files → 200 [] when a list fn throws NextcloudOcsError(503) (degrade ordering contract)", async () => {
      // Locks handleFileError's ORDERING CONTRACT: the NextcloudOcsError
      // instanceof check runs before the degrade branch, but a 5xx OCS status
      // is an outage — so a read endpoint must still fall through to the empty
      // fallback rather than 503. Today list fns throw plain Error; this guards
      // against a future refactor that throws NextcloudOcsError on 5xx silently
      // making the degrade path unreachable.
      const { NextcloudOcsError } = nc as typeof import("../services/nextcloud.client.js");
      ncMock.ncListFiles.mockRejectedValue(
        new NextcloudOcsError("OCS PROPFIND failed (503)", 503),
      );
      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("still surfaces a NextcloudOcsError(403) verbatim — a 4xx OCS status is NOT an outage", async () => {
      // The 5xx carve-out must not bleed into 4xx: a real OCS authorization
      // error keeps its upstream status even on a read endpoint.
      const { NextcloudOcsError } = nc as typeof import("../services/nextcloud.client.js");
      ncMock.ncListFiles.mockRejectedValue(
        new NextcloudOcsError("OCS forbidden", 403),
      );
      const res = await request(app).get("/api/files?path=/");
      expect(res.status).toBe(403);
      expect(res.body).not.toEqual([]);
    });
  });

  // ── POST /api/files/mkdir ──

  describe("POST /api/files/mkdir", () => {
    it("creates a directory via Nextcloud", async () => {
      const res = await request(app).post("/api/files/mkdir").send({ path: "/new-dir" });
      expect(res.status).toBe(200);
      expect(res.body.created).toBe("/new-dir");
      expect(ncMock.ncCreateDirectory).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/new-dir"
      );
    });

    it("returns 400 when path is missing", async () => {
      const res = await request(app).post("/api/files/mkdir").send({});
      expect(res.status).toBe(400);
      expect(ncMock.ncCreateDirectory).not.toHaveBeenCalled();
    });

    it("returns 400 when path is empty", async () => {
      const res = await request(app).post("/api/files/mkdir").send({ path: "" });
      expect(res.status).toBe(400);
    });

    // WARP-938 (security): a path containing `..` segments resolves to a
    // sibling of the intended target via WebDAV, letting an authenticated user
    // create directories anywhere in their storage. Reject it server-side.
    it.each([
      "/Documents/../secret",
      "/../escape",
      "/a/b/../../c",
      "../relative",
      "/foo/..",
    ])("rejects a traversal path (%s) with 400", async (badPath) => {
      const res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: badPath });
      expect(res.status).toBe(400);
      expect(ncMock.ncCreateDirectory).not.toHaveBeenCalled();
    });

    it("still accepts a normal nested path", async () => {
      const res = await request(app)
        .post("/api/files/mkdir")
        .send({ path: "/Documents/Invoices" });
      expect(res.status).toBe(200);
      expect(ncMock.ncCreateDirectory).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/Documents/Invoices",
      );
    });
  });

  // ── POST /api/files/upload ──

  describe("POST /api/files/upload", () => {
    it("uploads a file and publishes MQTT event", async () => {
      const res = await request(app)
        .post("/api/files/upload?path=/")
        .attach("files", Buffer.from("hello"), "hello.txt");

      expect(res.status).toBe(200);
      expect(res.body.uploaded).toHaveLength(1);
      expect(res.body.uploaded[0].name).toBe("hello.txt");
      expect(res.body.uploaded[0].path).toBe("/hello.txt");
      expect(ncMock.ncUploadFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/",
        "hello.txt",
        expect.any(Buffer)
      );
    });

    it("uploads multiple files", async () => {
      const res = await request(app)
        .post("/api/files/upload?path=/docs")
        .attach("files", Buffer.from("a"), "a.txt")
        .attach("files", Buffer.from("b"), "b.txt");

      expect(res.status).toBe(200);
      expect(res.body.uploaded).toHaveLength(2);
      expect(res.body.uploaded[0].path).toBe("/docs/a.txt");
      expect(res.body.uploaded[1].path).toBe("/docs/b.txt");
      expect(ncMock.ncUploadFile).toHaveBeenCalledTimes(2);
    });

    it("returns 400 when no files are attached", async () => {
      const res = await request(app).post("/api/files/upload?path=/");
      expect(res.status).toBe(400);
    });

    // WARP-1666 — multer raises LIMIT_UNEXPECTED_FILE for BOTH a misnamed field
    // and an over-cap file count (index.js: `filesLeft` hits 0 → same code), so
    // a 36-file upload used to be reported as a field-name error. Setting
    // `limits.files` makes busboy raise the honest LIMIT_FILE_COUNT first; these
    // two tests pin the pair apart so they can never collapse again.
    it("rejects more than MAX_FILES_PER_UPLOAD files with an honest count message", async () => {
      let req = request(app).post("/api/files/upload?path=/");
      for (let i = 0; i <= MAX_FILES_PER_UPLOAD; i++) {
        req = req.attach("files", Buffer.from(`f${i}`), `f${i}.txt`);
      }
      const res = await req;

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        `Too many files (max ${MAX_FILES_PER_UPLOAD} per upload)`,
      );
      expect(res.body.error).not.toMatch(/field name/i);
      expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
    });

    it("still reports a genuinely misnamed field as a field-name error", async () => {
      const res = await request(app)
        .post("/api/files/upload?path=/")
        // singular "file" — not the field the route accepts
        .attach("file", Buffer.from("hello"), "hello.txt");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Unexpected field name (use "files")');
      expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
    });

    it("accepts a full batch of exactly MAX_FILES_PER_UPLOAD files", async () => {
      let req = request(app).post("/api/files/upload?path=/");
      for (let i = 0; i < MAX_FILES_PER_UPLOAD; i++) {
        req = req.attach("files", Buffer.from(`f${i}`), `f${i}.txt`);
      }
      const res = await req;

      expect(res.status).toBe(200);
      expect(res.body.uploaded).toHaveLength(MAX_FILES_PER_UPLOAD);
      expect(ncMock.ncUploadFile).toHaveBeenCalledTimes(MAX_FILES_PER_UPLOAD);
    });

    // WARP-1271 (T19a) — per-user upload cap (UserUsagePolicy.maxUploadSizeMb).
    describe("per-user upload cap", () => {
      afterAll(() => {
        // Restore the setup.ts default (no policy) for every other suite.
        (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValue(null);
      });

      it("no policy row → falls back to config.MAX_UPLOAD_SIZE_MB (under-cap passes)", async () => {
        (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValueOnce(null);
        const res = await request(app)
          .post("/api/files/upload?path=/")
          .attach("files", Buffer.alloc(1024, 1), "small.bin");
        expect(res.status).toBe(200);
      });

      it("under the policy cap passes", async () => {
        (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValueOnce({
          maxUploadSizeMb: 1, // 1 MB cap, tighter than the 10 MB config default
        });
        const res = await request(app)
          .post("/api/files/upload?path=/")
          .attach("files", Buffer.alloc(1024, 1), "small.bin");
        expect(res.status).toBe(200);
      });

      it("over the policy cap → 413 with an honest message naming the actual limit", async () => {
        (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValueOnce({
          maxUploadSizeMb: 1, // 1 MB cap
        });
        const res = await request(app)
          .post("/api/files/upload?path=/")
          .attach("files", Buffer.alloc(2 * 1024 * 1024, 1), "big.bin");
        expect(res.status).toBe(413);
        expect(res.body.error).toMatch(/1MB/);
        expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
      });

      it("a policy cap LOOSER than config never widens the ceiling (min() wins)", async () => {
        (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValueOnce({
          maxUploadSizeMb: 500, // looser than the 10 MB config default
        });
        // 11 MB — over config's 10 MB default, even though the policy allows 500.
        const res = await request(app)
          .post("/api/files/upload?path=/")
          .attach("files", Buffer.alloc(11 * 1024 * 1024, 1), "over-config.bin");
        expect(res.status).toBe(413);
        expect(res.body.error).toMatch(/10MB/);
      });

      it("a usage-policy lookup failure degrades to the config default (never blocks the upload)", async () => {
        (prismaMock.userUsagePolicy.findUnique as any).mockRejectedValueOnce(
          new Error("db unreachable"),
        );
        const res = await request(app)
          .post("/api/files/upload?path=/")
          .attach("files", Buffer.alloc(1024, 1), "small.bin");
        expect(res.status).toBe(200);
      });

      // WARP-1531 (RBAC v2 T7) — AccessRole usage defaults feed the cap:
      // person field → role default → config, field-by-field. The role read
      // rides prisma.user.findUnique (nested accessRole select); the stub is
      // keyed on that select shape so the BUG-11 password-change gate (which
      // also calls user.findUnique each request) keeps seeing its null.
      describe("role-level defaults (WARP-1531)", () => {
        // WARP-1528 (T4): the SAME `user.findUnique({select:{accessRole}})`
        // read now serves two consumers — the T7 usage resolver here and the
        // T4 feature gate mounted on /api/files. So the stub has to be a
        // faithful role row, not just its usage columns: a real AccessRole
        // always carries its grant set, and a role with zero feature grants
        // genuinely means "this person has no features" (the gate would 404
        // the upload before the cap could be asserted, which is correct
        // behavior, just not what these cases are about). Files is granted at
        // `manage` so the cap — not the gate — is what these tests measure.
        const stubRole = (
          role: {
            storageQuotaBytes?: bigint | null;
            maxUploadSizeMb?: number | null;
            llmDailyMessageCap?: number | null;
          } | null,
        ) => {
          (prismaMock.user.findUnique as any).mockImplementation(
            async (args: any) =>
              args?.select?.accessRole
                ? {
                    id: "u-test",
                    role: "family",
                    accessRole: role && {
                      mayOperateLocks: false,
                      cloudModelsAllowed: false,
                      featureGrants: [{ moduleId: "files", level: "manage" }],
                      toolGrants: [],
                      connectorGrants: [],
                      ...role,
                    },
                  }
                : null,
          );
        };

        afterEach(() => {
          // Restore the setup.ts default (no directory row → gate fails open).
          (prismaMock.user.findUnique as any).mockReset();
          (prismaMock.user.findUnique as any).mockResolvedValue(null);
          // WARP-1528: these cases stub the policy row PERSISTENTLY rather
          // than with `…Once`. The T4 feature gate resolves effective access
          // ahead of the handler and legitimately reads the same model, so a
          // one-shot queue would be drained by the gate and the handler would
          // silently see the default — pinning behavior to call ORDER across
          // two independent consumers. Reset it here instead.
          (prismaMock.userUsagePolicy.findUnique as any).mockReset();
          (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValue(null);
        });

        it("a role default caps the upload when the person has no policy row", async () => {
          stubRole({ storageQuotaBytes: null, maxUploadSizeMb: 1, llmDailyMessageCap: null });
          const res = await request(app)
            .post("/api/files/upload?path=/")
            .attach("files", Buffer.alloc(2 * 1024 * 1024, 1), "big.bin");
          expect(res.status).toBe(413);
          expect(res.body.error).toMatch(/1MB/);
          expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
        });

        it("a person row whose upload field is UNSET still inherits the role cap (field-by-field)", async () => {
          (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValue({
            storageQuotaBytes: 5_000_000n, // storage set…
            maxUploadSizeMb: null, // …upload cap unset → role's 1 MB applies
          });
          stubRole({ storageQuotaBytes: null, maxUploadSizeMb: 1, llmDailyMessageCap: null });
          const res = await request(app)
            .post("/api/files/upload?path=/")
            .attach("files", Buffer.alloc(2 * 1024 * 1024, 1), "big.bin");
          expect(res.status).toBe(413);
          expect(res.body.error).toMatch(/1MB/);
        });

        it("the person override beats a looser role default", async () => {
          (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValue({
            maxUploadSizeMb: 1,
          });
          stubRole({ storageQuotaBytes: null, maxUploadSizeMb: 500, llmDailyMessageCap: null });
          const res = await request(app)
            .post("/api/files/upload?path=/")
            .attach("files", Buffer.alloc(2 * 1024 * 1024, 1), "big.bin");
          expect(res.status).toBe(413);
          expect(res.body.error).toMatch(/1MB/);
        });

        it("the person override beats a TIGHTER role default (override semantics, not min())", async () => {
          (prismaMock.userUsagePolicy.findUnique as any).mockResolvedValue({
            maxUploadSizeMb: 5,
          });
          stubRole({ storageQuotaBytes: null, maxUploadSizeMb: 1, llmDailyMessageCap: null });
          const res = await request(app)
            .post("/api/files/upload?path=/")
            .attach("files", Buffer.alloc(2 * 1024 * 1024, 1), "under-person-cap.bin");
          expect(res.status).toBe(200);
        });

        it("a role default looser than config never widens the ceiling (min() wins)", async () => {
          stubRole({ storageQuotaBytes: null, maxUploadSizeMb: 500, llmDailyMessageCap: null });
          const res = await request(app)
            .post("/api/files/upload?path=/")
            .attach("files", Buffer.alloc(11 * 1024 * 1024, 1), "over-config.bin");
          expect(res.status).toBe(413);
          expect(res.body.error).toMatch(/10MB/);
        });

        it("zero AccessRole rows (accessRoleId null) behaves exactly like today: config default", async () => {
          stubRole(null); // user row exists, accessRole relation null — production today
          const res = await request(app)
            .post("/api/files/upload?path=/")
            .attach("files", Buffer.alloc(1024, 1), "small.bin");
          expect(res.status).toBe(200);
        });
      });
    });
  });

  // ── GET /api/files/download ──

  describe("GET /api/files/download", () => {
    it("streams the file when Nextcloud returns a body", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
      ncMock.ncDownloadFile.mockResolvedValue(stream);

      const res = await request(app).get("/api/files/download?path=/hello.txt");
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("hello.txt");
      // WARP-237: file download emits a data-access audit row.
      expect(recordedActivity).toContainEqual(
        expect.objectContaining({
          kind: "file",
          what: "File downloaded",
          refs: expect.objectContaining({ path: "/hello.txt" }),
        }),
      );
    });

    it("returns 400 when path is missing", async () => {
      const res = await request(app).get("/api/files/download");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the file doesn't exist", async () => {
      ncMock.ncDownloadFile.mockResolvedValue(null);
      const res = await request(app).get("/api/files/download?path=/ghost.txt");
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/files ──

  describe("DELETE /api/files", () => {
    it("deletes via Nextcloud", async () => {
      const res = await request(app).delete("/api/files?path=/old.txt");
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe("/old.txt");
      expect(ncMock.ncDeleteFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/old.txt"
      );
    });

    it("returns 400 when path is missing", async () => {
      const res = await request(app).delete("/api/files");
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/files/rename ──

  describe("POST /api/files/rename", () => {
    it("calls ncMoveFile with the computed new path", async () => {
      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/docs/old.txt", newName: "new.txt" });

      expect(res.status).toBe(200);
      expect(res.body.renamed).toEqual({ from: "/docs/old.txt", to: "/docs/new.txt" });
      expect(ncMock.ncMoveFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/docs/old.txt",
        "/docs/new.txt",
        false
      );
    });

    it("preserves root-level files", async () => {
      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/a.txt", newName: "b.txt" });
      expect(res.status).toBe(200);
      expect(res.body.renamed.to).toBe("/b.txt");
    });

    it("rejects path separators in newName", async () => {
      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/a.txt", newName: "b/c.txt" });
      expect(res.status).toBe(400);
      expect(ncMock.ncMoveFile).not.toHaveBeenCalled();
    });

    it("rejects empty newName", async () => {
      const res = await request(app)
        .post("/api/files/rename")
        .send({ path: "/a.txt", newName: "" });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/files/move ──

  describe("POST /api/files/move", () => {
    it("moves a file to a new directory", async () => {
      const res = await request(app)
        .post("/api/files/move")
        .send({ from: "/a.txt", to: "/archive/a.txt" });
      expect(res.status).toBe(200);
      expect(ncMock.ncMoveFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/a.txt",
        "/archive/a.txt",
        false
      );
    });

    it("passes overwrite=true when requested", async () => {
      const res = await request(app)
        .post("/api/files/move")
        .send({ from: "/a.txt", to: "/b.txt", overwrite: true });
      expect(res.status).toBe(200);
      expect(ncMock.ncMoveFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/a.txt",
        "/b.txt",
        true
      );
    });

    it("bubbles up NextcloudOcsError as the OCS status", async () => {
      const { NextcloudOcsError } = nc as typeof import("../services/nextcloud.client.js");
      ncMock.ncMoveFile.mockRejectedValue(
        new NextcloudOcsError("OCS move: Destination exists (412)", 412)
      );
      const res = await request(app)
        .post("/api/files/move")
        .send({ from: "/a.txt", to: "/b.txt" });
      expect(res.status).toBe(412);
      expect(res.body.error).toContain("Destination exists");
    });
  });

  // ── POST /api/files/copy ──

  describe("POST /api/files/copy", () => {
    it("copies via Nextcloud", async () => {
      const res = await request(app)
        .post("/api/files/copy")
        .send({ from: "/a.txt", to: "/b.txt" });
      expect(res.status).toBe(200);
      expect(ncMock.ncCopyFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/a.txt",
        "/b.txt",
        false
      );
    });
  });

  // ── POST /api/files/bulk-delete ──

  describe("POST /api/files/bulk-delete", () => {
    it("returns per-item success for all-ok bulk", async () => {
      const res = await request(app)
        .post("/api/files/bulk-delete")
        .send({ paths: ["/a.txt", "/b.txt", "/c.txt"] });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(3);
      expect(res.body.results.every((r: any) => r.ok)).toBe(true);
      expect(ncMock.ncDeleteFile).toHaveBeenCalledTimes(3);
    });

    it("returns 207 on partial failure and per-item errors", async () => {
      ncMock.ncDeleteFile.mockImplementation(
        async (_t: string, _u: string, p: string) => {
          if (p === "/bad.txt") throw new Error("WebDAV DELETE failed: 403");
        }
      );

      const res = await request(app)
        .post("/api/files/bulk-delete")
        .send({ paths: ["/good.txt", "/bad.txt"] });

      expect(res.status).toBe(207);
      const good = res.body.results.find((r: any) => r.path === "/good.txt");
      const bad = res.body.results.find((r: any) => r.path === "/bad.txt");
      expect(good.ok).toBe(true);
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain("403");
    });

    it("rejects empty paths array", async () => {
      const res = await request(app).post("/api/files/bulk-delete").send({ paths: [] });
      expect(res.status).toBe(400);
      expect(ncMock.ncDeleteFile).not.toHaveBeenCalled();
    });

    it("serializes delete calls (no concurrent Promise.all fan-out)", async () => {
      // Track concurrency — nc.ncDeleteFile should never be in-flight twice.
      let inflight = 0;
      let maxInflight = 0;
      ncMock.ncDeleteFile.mockImplementation(async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
      });

      await request(app)
        .post("/api/files/bulk-delete")
        .send({ paths: ["/a.txt", "/b.txt", "/c.txt", "/d.txt"] });

      expect(maxInflight).toBe(1);
    });
  });

  // ── POST /api/files/bulk-move ──

  describe("POST /api/files/bulk-move", () => {
    it("moves multiple files to a target directory", async () => {
      const res = await request(app)
        .post("/api/files/bulk-move")
        .send({ paths: ["/a.txt", "/b.txt"], toDir: "/archive" });
      expect(res.status).toBe(200);
      expect(ncMock.ncMoveFile).toHaveBeenCalledTimes(2);
      expect(ncMock.ncMoveFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/a.txt",
        "/archive/a.txt",
        false
      );
    });
  });

  // ── POST /api/files/bulk-copy ──

  describe("POST /api/files/bulk-copy", () => {
    it("copies multiple files to a target directory", async () => {
      const res = await request(app)
        .post("/api/files/bulk-copy")
        .send({ paths: ["/a.txt", "/b.txt"], toDir: "/backup" });
      expect(res.status).toBe(200);
      expect(ncMock.ncCopyFile).toHaveBeenCalledTimes(2);
    });
  });

  // ── Trash ──

  describe("Trash endpoints", () => {
    it("GET /api/files/trash returns the parsed trash list", async () => {
      ncMock.ncListTrash.mockResolvedValue([
        {
          name: "a.txt.d123",
          originalName: "a.txt",
          originalLocation: "/",
          size: 8,
          deletedAt: "2026-04-01T00:00:00.000Z",
          isDirectory: false,
        },
      ]);
      const res = await request(app).get("/api/files/trash");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].originalName).toBe("a.txt");
    });

    it("POST /api/files/trash/restore calls ncRestoreTrashItem", async () => {
      const res = await request(app)
        .post("/api/files/trash/restore")
        .send({ name: "a.txt.d123" });
      expect(res.status).toBe(200);
      expect(res.body.restored).toBe("a.txt.d123");
      expect(ncMock.ncRestoreTrashItem).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "a.txt.d123"
      );
    });

    it("DELETE /api/files/trash empties trash", async () => {
      const res = await request(app).delete("/api/files/trash");
      expect(res.status).toBe(200);
      expect(res.body.emptied).toBe(true);
      expect(ncMock.ncEmptyTrash).toHaveBeenCalled();
    });

    it("DELETE /api/files/trash/item permanently removes one item", async () => {
      const res = await request(app).delete("/api/files/trash/item?name=a.txt.d123");
      expect(res.status).toBe(200);
      expect(ncMock.ncDeleteTrashItem).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "a.txt.d123"
      );
    });
  });

  // ── Versions ──

  describe("Versions endpoints", () => {
    it("GET /api/files/versions resolves fileId then lists versions", async () => {
      ncMock.ncListVersions.mockResolvedValue([
        { versionId: "v1", size: 10, modifiedAt: "2026-04-01T00:00:00.000Z" },
      ]);
      const res = await request(app).get("/api/files/versions?path=/a.txt");
      expect(res.status).toBe(200);
      expect(res.body.fileId).toBe(42);
      expect(res.body.versions).toHaveLength(1);
      expect(ncMock.ncGetFileId).toHaveBeenCalled();
      expect(ncMock.ncListVersions).toHaveBeenCalledWith(expect.any(String), "dev", 42);
    });

    it("GET /api/files/versions returns 404 when fileId is null", async () => {
      ncMock.ncGetFileId.mockResolvedValue(null);
      const res = await request(app).get("/api/files/versions?path=/missing.txt");
      expect(res.status).toBe(404);
    });

    it("POST /api/files/versions/restore restores a version by id", async () => {
      const res = await request(app)
        .post("/api/files/versions/restore")
        .send({ path: "/a.txt", versionId: "v1" });
      expect(res.status).toBe(200);
      expect(ncMock.ncRestoreVersion).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        42,
        "v1"
      );
    });
  });

  // ── Phase 2: favorites / recents / search / thumbnail / shares ──

  describe("Favorites", () => {
    it("POST /api/files/favorite toggles the flag via ncSetFavorite", async () => {
      const res = await request(app)
        .post("/api/files/favorite")
        .send({ path: "/a.txt", favorite: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ path: "/a.txt", favorite: true });
      expect(ncMock.ncSetFavorite).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/a.txt",
        true
      );
    });

    it("GET /api/files/favorites returns the list", async () => {
      ncMock.ncListFavorites.mockResolvedValue([
        { name: "a.txt", path: "/a.txt", isDirectory: false, size: 5, mimeType: "text/plain", modifiedAt: "2026-04-01T00:00:00.000Z" },
      ]);
      const res = await request(app).get("/api/files/favorites");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });
  });

  describe("Search & recents", () => {
    it("GET /api/files/search passes the query through", async () => {
      ncMock.ncSearchFiles.mockResolvedValue([
        { name: "budget-2024.xlsx", path: "/budget-2024.xlsx", isDirectory: false, size: 100, mimeType: "application/vnd.ms-excel", modifiedAt: "2026-04-01T00:00:00.000Z" },
      ]);
      const res = await request(app).get("/api/files/search?q=budget");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(ncMock.ncSearchFiles).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        { query: "budget", mime: undefined, limit: 50 }
      );
    });

    it("GET /api/files/search returns 400 when q is missing", async () => {
      const res = await request(app).get("/api/files/search");
      expect(res.status).toBe(400);
    });

    it("GET /api/files/search returns [] for q<2 chars (no backend call)", async () => {
      const res = await request(app).get("/api/files/search?q=a");
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(ncMock.ncSearchFiles).not.toHaveBeenCalled();
    });

    it("GET /api/files/recents calls ncListRecents with the limit", async () => {
      const res = await request(app).get("/api/files/recents?limit=20");
      expect(res.status).toBe(200);
      expect(ncMock.ncListRecents).toHaveBeenCalledWith(expect.any(String), "dev", 20);
    });
  });

  describe("Thumbnail", () => {
    it("GET /api/files/thumbnail streams bytes with Cache-Control", async () => {
      const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      ncMock.ncFetchThumbnail.mockResolvedValue({
        body: body.buffer,
        contentType: "image/png",
      });

      const res = await request(app).get("/api/files/thumbnail?path=/pixel.png");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.headers["cache-control"]).toContain("max-age=3600");
    });

    it("GET /api/files/thumbnail returns 404 when preview is unavailable", async () => {
      ncMock.ncFetchThumbnail.mockResolvedValue(null);
      const res = await request(app).get("/api/files/thumbnail?path=/big.xlsx");
      expect(res.status).toBe(404);
    });

    it("GET /api/files/thumbnail returns 404 when fileId can't be resolved", async () => {
      ncMock.ncGetFileId.mockResolvedValue(null);
      const res = await request(app).get("/api/files/thumbnail?path=/missing.png");
      expect(res.status).toBe(404);
    });
  });

  describe("Shares v2", () => {
    it("POST /api/files/share creates with full options", async () => {
      ncMock.ncCreateShareV2.mockResolvedValue({
        id: 7,
        url: "https://nextcloud/s/abc",
        token: "abc",
        shareType: 3,
        permissions: 1,
        path: "/a.txt",
        expireDate: "2027-12-31",
        hasPassword: true,
        note: "please review",
        shareWith: null,
        shareWithDisplayName: null,
        uidOwner: "dev",
        ownerDisplayName: "Admin",
        stime: 1712860391,
      });

      const res = await request(app)
        .post("/api/files/share")
        .send({
          path: "/a.txt",
          shareType: 3,
          permissions: 1,
          expireDate: "2027-12-31",
          password: "s3cret",
          note: "please review",
        });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(7);
      expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
        expect.any(String),
        "/a.txt",
        expect.objectContaining({
          shareType: 3,
          permissions: 1,
          expireDate: "2027-12-31",
          password: "s3cret",
          note: "please review",
        })
      );
      // WARP-237: share creation emits a mandatory audit row that flags
      // password protection WITHOUT ever carrying the password itself.
      expect(recordedActivity).toContainEqual(
        expect.objectContaining({
          kind: "file",
          what: "Share created",
          refs: expect.objectContaining({
            path: "/a.txt",
            passwordProtected: true,
          }),
        })
      );
      expect(JSON.stringify(recordedActivity)).not.toContain("s3cret");
    });

    it("POST /api/files/share forwards shareWith for a named-member share (shareType:0)", async () => {
      // WARP-879 / WS-1 — the internal-sharing path: shareType 0 (user) with
      // a `shareWith` (the recipient's nextcloudUsername). The route must
      // thread shareWith through to ncCreateShareV2 unchanged.
      ncMock.ncCreateShareV2.mockResolvedValue({
        id: 11,
        url: null,
        token: null,
        shareType: 0,
        permissions: 17,
        path: "/report.pdf",
        expireDate: null,
        hasPassword: false,
        note: null,
        shareWith: "romain",
        shareWithDisplayName: "Romain",
        uidOwner: "dev",
        ownerDisplayName: "Admin",
        stime: 1712860391,
      });

      const res = await request(app)
        .post("/api/files/share")
        .send({
          path: "/report.pdf",
          shareType: 0,
          shareWith: "romain",
          permissions: 17,
        });
      expect(res.status).toBe(200);
      expect(res.body.shareType).toBe(0);
      expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
        expect.any(String),
        "/report.pdf",
        expect.objectContaining({
          shareType: 0,
          shareWith: "romain",
          permissions: 17,
        })
      );
    });

    it("POST /api/files/share forwards the WARP-1148 repro options (Can edit link + expiry + password + note) verbatim", async () => {
      // The exact 2026-07-08 field repro: public link on a file with
      // "Can edit" (READ|UPDATE = 3), an expiration date, a password, and a
      // note. The route must pass every option through to Nextcloud unchanged
      // — any main-side serialization drop here would make the dialog's
      // options silently vanish.
      ncMock.ncCreateShareV2.mockResolvedValue({
        id: 12,
        url: "https://nextcloud/s/xyz",
        token: "xyz",
        shareType: 3,
        permissions: 3,
        path: "/welcome-to-droplet.md",
        expireDate: "2026-07-09",
        hasPassword: true,
        note: "for the launch review",
        shareWith: null,
        shareWithDisplayName: null,
        uidOwner: "dev",
        ownerDisplayName: "Admin",
        stime: 1783000000,
      });

      const res = await request(app)
        .post("/api/files/share")
        .send({
          path: "/welcome-to-droplet.md",
          shareType: 3,
          permissions: 3,
          expireDate: "2026-07-09",
          password: "correct horse battery staple",
          note: "for the launch review",
        });
      expect(res.status).toBe(200);
      expect(res.body.permissions).toBe(3);
      expect(res.body.expireDate).toBe("2026-07-09");
      expect(ncMock.ncCreateShareV2).toHaveBeenCalledWith(
        expect.any(String),
        "/welcome-to-droplet.md",
        expect.objectContaining({
          shareType: 3,
          permissions: 3,
          expireDate: "2026-07-09",
          password: "correct horse battery staple",
          note: "for the launch review",
        })
      );
    });

    it("POST /api/files/share surfaces NextcloudOcsError as the upstream status", async () => {
      const { NextcloudOcsError } = nc as typeof import("../services/nextcloud.client.js");
      ncMock.ncCreateShareV2.mockRejectedValue(
        new NextcloudOcsError(
          "OCS share create: Password is present in compromised password list. (400)",
          400
        )
      );

      const res = await request(app)
        .post("/api/files/share")
        .send({ path: "/a.txt", shareType: 3, password: "OpenSesame123!" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("compromised password list");
    });

    it("POST /api/files/share rejects an invalid expireDate format", async () => {
      const res = await request(app)
        .post("/api/files/share")
        .send({ path: "/a.txt", expireDate: "tomorrow" });
      expect(res.status).toBe(400);
      expect(ncMock.ncCreateShareV2).not.toHaveBeenCalled();
    });

    it("PUT /api/files/share/:id applies each provided field sequentially", async () => {
      const res = await request(app)
        .put("/api/files/share/7")
        .send({ permissions: 3, password: "new-pwd" });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(7);
      expect(ncMock.ncUpdateShare).toHaveBeenCalledTimes(2);
      expect(ncMock.ncUpdateShare).toHaveBeenCalledWith(expect.any(String), 7, "permissions", "3");
      expect(ncMock.ncUpdateShare).toHaveBeenCalledWith(expect.any(String), 7, "password", "new-pwd");
    });

    it("PUT /api/files/share/:id rejects an empty body", async () => {
      const res = await request(app).put("/api/files/share/7").send({});
      expect(res.status).toBe(400);
      expect(ncMock.ncUpdateShare).not.toHaveBeenCalled();
    });

    it("DELETE /api/files/share/:id revokes the share", async () => {
      const res = await request(app).delete("/api/files/share/7");
      expect(res.status).toBe(200);
      expect(ncMock.ncDeleteShare).toHaveBeenCalledWith(expect.any(String), 7);
    });

    it("GET /api/files/shared-with-me returns the shares array", async () => {
      ncMock.ncListSharedWithMe.mockResolvedValue([
        {
          id: 10,
          url: null,
          token: null,
          shareType: 0,
          permissions: 17,
          path: "/shared/hello.txt",
          expireDate: null,
          hasPassword: false,
          note: null,
          shareWith: "me",
          shareWithDisplayName: null,
          uidOwner: "bob",
          ownerDisplayName: "Bob",
          stime: 1712860391,
        },
      ]);
      const res = await request(app).get("/api/files/shared-with-me");
      expect(res.status).toBe(200);
      expect(res.body.shares).toHaveLength(1);
      expect(res.body.shares[0].uidOwner).toBe("bob");
    });
  });

  // ── Full lifecycle ──

  describe("Full lifecycle", () => {
    it("mkdir → upload → list → download → delete → list", async () => {
      // mkdir
      let res = await request(app).post("/api/files/mkdir").send({ path: "/docs" });
      expect(res.status).toBe(200);

      // upload
      res = await request(app)
        .post("/api/files/upload?path=/docs")
        .attach("files", Buffer.from("# Hello"), "readme.md");
      expect(res.status).toBe(200);

      // list — now populated
      ncMock.ncListFiles.mockResolvedValueOnce([
        { name: "readme.md", path: "/docs/readme.md", isDirectory: false, size: 7, mimeType: "text/markdown", modifiedAt: "2026-04-01T00:00:00.000Z" },
      ]);
      res = await request(app).get("/api/files?path=/docs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("readme.md");

      // download
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("# Hello"));
          c.close();
        },
      });
      ncMock.ncDownloadFile.mockResolvedValueOnce(stream);
      res = await request(app).get("/api/files/download?path=/docs/readme.md");
      expect(res.status).toBe(200);

      // delete
      res = await request(app).delete("/api/files?path=/docs/readme.md");
      expect(res.status).toBe(200);
      expect(ncMock.ncDeleteFile).toHaveBeenCalledWith(
        expect.any(String),
        "dev",
        "/docs/readme.md"
      );
    });
  });
});
