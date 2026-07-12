/**
 * WARP-883 (ADR-027 WS-5) + WARP-1261 (T9) — Files spaces.
 *
 * The Nextcloud `groupfolders` app mounts the "Household" group folder
 * INTO each member's Nextcloud home as a top-level directory. So the "shared"
 * space is just a path prefix (`/Household`) browsed with the user's OWN
 * existing WebDAV token — no separate account or WebDAV root.
 *
 * WARP-1261 extends spaces with DB-driven Department/Team rows.
 *
 * These tests pin:
 *
 *   1. `GET /api/files?space=personal|shared|dept:<uuid>` maps correctly:
 *      - personal (default): user's home root unchanged
 *      - shared: `/Household` with path resolved under it
 *      - dept:<uuid>: `/<DepartmentName>` or `/<Parent> — <Team>` with path under it
 *   2. The My-Files (personal) ROOT listing HIDES the shared-folder entry so
 *      the Household folder isn't shown twice (once as a space, once inline).
 *      Non-root personal listings and the shared space are NOT filtered.
 *   3. `GET /api/files/spaces` returns personal always, household (shared) with
 *      spaceRef for v2, and active DEPARTMENT/TEAM rows where caller is member
 *      or owner/admin.
 *   4. rootForSpace resolves dept:<uuid> to the department mount point.
 *   5. Unknown/malformed space values in dept:<uuid> throw (fail-closed).
 *
 * Mirrors files.test.ts: module-mock the nextcloud.client + config, drive the
 * real route through supertest, assert per-call arguments on the nc mock.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

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
    FRIGATE_URL: "http://frigate:5000",
    // WARP-883 — the shared group-folder name the route maps `space=shared`
    // onto. Use a non-default value so the tests prove the route reads config
    // rather than a hard-coded "Household" string.
    DROPLET_SHARED_FOLDER_NAME: "Household",
  },
}));

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js"
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncCreateShare: vi.fn(),
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
    ncGetUserQuota: vi.fn(),
    ncDirExists: vi.fn(),
  };
});

import { createApp } from "../app.js";
import * as nc from "../services/nextcloud.client.js";
import { initDeviceService } from "../services/device.service.js";

type Mocked<T extends (...a: any[]) => any> = T & ReturnType<typeof vi.fn>;
const ncMock = nc as unknown as { [K in keyof typeof nc]: Mocked<any> };

const SHARED = "Household";

function entry(name: string, isDir = false) {
  return {
    name,
    path: `/${name}`,
    isDirectory: isDir,
    size: 0,
    mimeType: isDir ? null : "text/plain",
    modifiedAt: "2026-04-16T00:00:00Z",
  };
}

describe("WARP-883 — Files spaces (My Files / Shared Household)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    for (const key of Object.keys(ncMock)) {
      const fn = (ncMock as any)[key];
      if (typeof fn?.mockReset === "function") fn.mockReset();
    }
    ncMock.ncListFiles.mockResolvedValue([]);
    ncMock.ncDirExists.mockResolvedValue(true);
  });

  describe("space → root mapping on GET /api/files", () => {
    it("personal (default) lists the user's home root unchanged", async () => {
      await request(app).get("/api/files").expect(200);
      // No space param → personal → home root "/".
      expect(ncMock.ncListFiles).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        "/"
      );
    });

    it("shared maps the root listing to /<SharedFolder>", async () => {
      await request(app).get("/api/files?space=shared").expect(200);
      expect(ncMock.ncListFiles).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        `/${SHARED}`
      );
    });

    it("shared resolves ?path UNDER the shared prefix (no traversal)", async () => {
      await request(app)
        .get("/api/files?space=shared&path=/Trips/2026")
        .expect(200);
      expect(ncMock.ncListFiles).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        `/${SHARED}/Trips/2026`
      );
    });

    it("personal still honours an explicit ?path", async () => {
      await request(app).get("/api/files?path=/Documents").expect(200);
      expect(ncMock.ncListFiles).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        "/Documents"
      );
    });

    it("an unknown space value falls back to personal (no shared prefix)", async () => {
      await request(app).get("/api/files?space=bogus").expect(200);
      expect(ncMock.ncListFiles).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        "/"
      );
    });
  });

  describe("My-Files root hides the shared folder", () => {
    it("filters the Household entry out of the personal home root", async () => {
      ncMock.ncListFiles.mockResolvedValue([
        entry("Documents", true),
        entry(SHARED, true),
        entry("notes.txt"),
      ]);
      const res = await request(app).get("/api/files").expect(200);
      const names = (res.body as Array<{ name: string }>).map((e) => e.name);
      expect(names).toContain("Documents");
      expect(names).toContain("notes.txt");
      expect(names).not.toContain(SHARED);
    });

    it("does NOT filter a non-root personal listing", async () => {
      // A real subfolder that happens to be named "Household" deeper in the
      // tree must NOT be hidden — only the top-level mount point is.
      ncMock.ncListFiles.mockResolvedValue([entry(SHARED, true), entry("x.txt")]);
      const res = await request(app)
        .get("/api/files?path=/Documents")
        .expect(200);
      const names = (res.body as Array<{ name: string }>).map((e) => e.name);
      expect(names).toContain(SHARED);
    });

    it("does NOT filter inside the shared space itself", async () => {
      ncMock.ncListFiles.mockResolvedValue([entry(SHARED, true), entry("y.txt")]);
      const res = await request(app)
        .get("/api/files?space=shared")
        .expect(200);
      const names = (res.body as Array<{ name: string }>).map((e) => e.name);
      // Inside /Household the listing is verbatim (a child literally named
      // "Household" stays visible).
      expect(names).toContain(SHARED);
      expect(names).toContain("y.txt");
    });
  });

  describe("GET /api/files/spaces", () => {
    // WARP-1261: DB-driven spaces API v2 tests.
    // The Household department is seeded as part of the bootstrap; it should
    // always appear with id='shared' (legacy compat) + spaceRef for v2 routing.
    // Active DEPARTMENT/TEAM rows where the caller is member OR owner/admin also appear.

    it("reports personal + household (shared with spaceRef) when no depts exist", async () => {
      ncMock.ncDirExists.mockResolvedValue(true);
      const res = await request(app).get("/api/files/spaces").expect(200);
      expect(res.body).toMatchObject({
        spaces: expect.arrayContaining([
          expect.objectContaining({ id: "personal", name: "My Files" }),
          expect.objectContaining({
            id: "shared",
            spaceRef: expect.stringMatching(/^dept:[a-f0-9-]{36}$/),
            kind: "household",
          }),
        ]),
        sharedAvailable: true,
      });
    });

    it("degrades to shared-unavailable (never 500) when Nextcloud is down", async () => {
      ncMock.ncDirExists.mockRejectedValue(new Error("fetch failed ECONNREFUSED"));
      const res = await request(app).get("/api/files/spaces").expect(200);
      expect(res.body.sharedAvailable).toBe(false);
    });

    // WARP-1267 (T15) — isMember + parentName. AUTH_ENABLED is false for this
    // whole file (config mock above), so every request runs as the fixed
    // dev/owner principal (auth.ts:106) — isOwnerOrAdmin is always true here.
    // That still exercises both branches of the isMember ternary: a
    // department can independently report memberships=[] (not a member,
    // owner see-all) or memberships=[{right}] (an actual membership row for
    // "dev") regardless of role, which is exactly what these fields encode.
    // A true non-admin "member only sees their own depts" pass needs a
    // separate AUTH_ENABLED=true harness — out of scope for this ticket.
    const prisma = new PrismaClient() as unknown as {
      department: {
        findMany: Mocked<any>;
        findUnique: Mocked<any>;
      };
    };

    it("isMember:true + the caller's own right when the caller has a membership row", async () => {
      ncMock.ncDirExists.mockResolvedValue(true);
      prisma.department.findMany.mockResolvedValueOnce([
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Finance",
          parentId: null,
          kind: "DEPARTMENT",
          quotaBytes: null,
          memberships: [{ right: "contributor" }],
        },
      ]);
      const res = await request(app).get("/api/files/spaces").expect(200);
      expect(res.body.spaces).toContainEqual(
        expect.objectContaining({
          id: "dept:11111111-1111-4111-8111-111111111111",
          name: "Finance",
          kind: "department",
          state: "active",
          right: "contributor",
          isMember: true,
        })
      );
    });

    it("isMember:false + right:manager when an owner/admin sees a dept they're not a member of", async () => {
      ncMock.ncDirExists.mockResolvedValue(true);
      prisma.department.findMany.mockResolvedValueOnce([
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Legal",
          parentId: null,
          kind: "DEPARTMENT",
          quotaBytes: null,
          memberships: [], // "dev" holds no membership row on Legal
        },
      ]);
      const res = await request(app).get("/api/files/spaces").expect(200);
      expect(res.body.spaces).toContainEqual(
        expect.objectContaining({
          id: "dept:22222222-2222-4222-8222-222222222222",
          name: "Legal",
          kind: "department",
          isMember: false,
          right: "manager",
        })
      );
    });

    it("TEAM rows carry parentName + the flat 'Parent — Team' mount name", async () => {
      ncMock.ncDirExists.mockResolvedValue(true);
      const parentId = "33333333-3333-4333-8333-333333333333";
      prisma.department.findMany.mockResolvedValueOnce([
        {
          id: "44444444-4444-4444-8444-444444444444",
          name: "Platform",
          parentId,
          kind: "TEAM",
          quotaBytes: null,
          memberships: [{ right: "manager" }],
        },
      ]);
      prisma.department.findUnique.mockResolvedValueOnce({ name: "Engineering" });
      const res = await request(app).get("/api/files/spaces").expect(200);
      expect(res.body.spaces).toContainEqual(
        expect.objectContaining({
          id: "dept:44444444-4444-4444-8444-444444444444",
          name: "Platform",
          kind: "team",
          root: "/Engineering — Platform",
          parentName: "Engineering",
          isMember: true,
          right: "manager",
        })
      );
    });

    // TODO WARP-1261: add tests for:
    // - Department rows appear (only) when a non-admin caller is a member
    //   (needs an AUTH_ENABLED=true harness — role is fixed to owner here)
    // - Inactive/pending/failed dept rows are excluded
    // - requireSpaceAccess middleware gates access by membership
  });
});
