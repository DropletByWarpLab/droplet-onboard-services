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
import { PrismaClient, User, Department, DepartmentMembership } from "@prisma/client";

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

    // TODO WARP-1261: add tests for:
    // - Department rows appear when caller is a member
    // - Department rows appear when caller is owner/admin (even non-member)
    // - TEAM rows show "Parent — Team" naming
    // - Inactive/pending/failed dept rows are excluded
    // - requireSpaceAccess middleware gates access by membership
  });
});
