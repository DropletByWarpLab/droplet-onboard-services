/**
 * WARP-879 / WS-1 — GET /api/files/share-recipients
 *
 * The internal-sharing UI needs a household roster to pick a share
 * recipient from. The pre-existing `GET /auth/users` route goes through
 * OCS `/cloud/users`, which 403s for the `family` role — so the share
 * picker would be empty for exactly the household members who share most.
 *
 * This route instead reads the LOCAL Prisma `User` table (ADR-013: the
 * built-in directory is the identity source of truth) and is guarded
 * `requireRole("owner","admin","family")`.
 *
 * Covered:
 *   1. `family` gets 200 + roster (NOT 403 — the core fix)
 *   2. self excluded by nextcloudUsername, case-insensitively
 *   3. the Nextcloud system admin (NEXTCLOUD_ADMIN_USER || "admin") excluded
 *   4. rows with a null nextcloudUsername excluded
 *   5. `shareWith` is the recipient's nextcloudUsername (the OCS user id),
 *      not the local id/username
 *   6. an unauthenticated / no-role caller → 403
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// Guard with realistic semantics — the real implementation has its own
// coverage (rbac.test.ts); here we only verify WHICH guard the route uses.
vi.mock("../middleware/auth.js", () => ({
  requireRole:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
  requireRoleOrMcpService:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
}));

// Files routes touch these — pass-throughs so nothing else interferes.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../config.js", () => ({
  config: { MAX_UPLOAD_SIZE_MB: 10, NODE_ENV: "test" },
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("session-token"),
}));
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

import { createFilesRouter } from "../routes/files.js";

type Role = "owner" | "admin" | "family" | "guest" | "service";
interface FakeUser {
  id: string;
  username: string;
  role: Role;
}
interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
}

/**
 * Build a tiny app mounting only the files router, with `req.user` stuffed
 * by a synthetic auth middleware and a hand-built prisma whose `user` table
 * returns the supplied rows.
 *
 * `findUnique({ where: { id } })` resolves the caller's own row (so the
 * route can read its `nextcloudUsername`); `findMany` returns the roster.
 */
function buildApp(opts: {
  asUser: FakeUser | null;
  rows?: UserRow[];
}) {
  const { asUser, rows = [] } = opts;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (asUser) (req as unknown as { user?: FakeUser }).user = asUser;
    next();
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const prismaStub = {
    fileCitation: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null,
      ),
      findMany: vi.fn(async () => rows),
    },
  };
  app.use("/api", createFilesRouter(prismaStub as never));
  return app;
}

const CALLER: FakeUser = { id: "uuid-caller", username: "stef-local", role: "family" };

function roster(): UserRow[] {
  return [
    // the caller's own row — nextcloudUsername differs in case to prove
    // the self-exclusion compares case-insensitively
    {
      id: "uuid-caller",
      username: "stef-local",
      displayName: "Stefan",
      email: "stef@example.com",
      nextcloudUsername: "Stefan-Cruceru",
    },
    // a normal recipient
    {
      id: "uuid-romain",
      username: "romain-local",
      displayName: "Romain",
      email: "romain@example.com",
      nextcloudUsername: "romain",
    },
    // recipient with no email — email must come back null, not undefined
    {
      id: "uuid-sam",
      username: "sam-local",
      displayName: "Samantha",
      email: null,
      nextcloudUsername: "samantha",
    },
    // the Nextcloud system/database admin — must be hidden
    {
      id: "uuid-admin",
      username: "admin-local",
      displayName: "System Admin",
      email: null,
      nextcloudUsername: "admin",
    },
    // a fresh invitee that never authenticated against Nextcloud — excluded
    {
      id: "uuid-pending",
      username: "pending-local",
      displayName: "Pending Person",
      email: "pending@example.com",
      nextcloudUsername: null,
    },
  ];
}

describe("WARP-879 — GET /api/files/share-recipients", () => {
  beforeEach(() => {
    delete process.env.NEXTCLOUD_ADMIN_USER;
  });

  it("returns 200 + the household roster for a family member (the core fix)", async () => {
    const res = await request(buildApp({ asUser: CALLER, rows: roster() })).get(
      "/api/files/share-recipients",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recipients)).toBe(true);
    // romain + samantha survive; caller, admin, null-nc are all filtered out
    const ids = res.body.recipients.map((r: { shareWith: string }) => r.shareWith);
    expect(ids).toEqual(expect.arrayContaining(["romain", "samantha"]));
    expect(res.body.recipients).toHaveLength(2);
  });

  it("excludes the caller themselves, comparing nextcloudUsername case-insensitively", async () => {
    const res = await request(buildApp({ asUser: CALLER, rows: roster() })).get(
      "/api/files/share-recipients",
    );
    expect(res.status).toBe(200);
    const ids = res.body.recipients.map((r: { shareWith: string }) =>
      r.shareWith.toLowerCase(),
    );
    expect(ids).not.toContain("stefan-cruceru");
  });

  it("excludes the Nextcloud system admin account", async () => {
    const res = await request(buildApp({ asUser: CALLER, rows: roster() })).get(
      "/api/files/share-recipients",
    );
    const ids = res.body.recipients.map((r: { shareWith: string }) =>
      r.shareWith.toLowerCase(),
    );
    expect(ids).not.toContain("admin");
  });

  it("honors a custom NEXTCLOUD_ADMIN_USER (case-insensitive)", async () => {
    process.env.NEXTCLOUD_ADMIN_USER = "ROMAIN";
    const res = await request(buildApp({ asUser: CALLER, rows: roster() })).get(
      "/api/files/share-recipients",
    );
    const ids = res.body.recipients.map((r: { shareWith: string }) =>
      r.shareWith.toLowerCase(),
    );
    expect(ids).not.toContain("romain");
    // samantha still present (admin override only hides the named system user)
    expect(ids).toContain("samantha");
  });

  it("excludes rows with a null nextcloudUsername", async () => {
    const res = await request(buildApp({ asUser: CALLER, rows: roster() })).get(
      "/api/files/share-recipients",
    );
    const display = res.body.recipients.map(
      (r: { displayName: string }) => r.displayName,
    );
    expect(display).not.toContain("Pending Person");
  });

  it("returns shareWith = the recipient's nextcloudUsername (not local id/username), email|null", async () => {
    const res = await request(buildApp({ asUser: CALLER, rows: roster() })).get(
      "/api/files/share-recipients",
    );
    const romain = res.body.recipients.find(
      (r: { displayName: string }) => r.displayName === "Romain",
    );
    expect(romain).toMatchObject({
      shareWith: "romain", // the OCS user id, NOT "uuid-romain"/"romain-local"
      displayName: "Romain",
      email: "romain@example.com",
    });
    const sam = res.body.recipients.find(
      (r: { displayName: string }) => r.displayName === "Samantha",
    );
    expect(sam.email).toBeNull();
  });

  it("403s a caller with no role", async () => {
    const res = await request(buildApp({ asUser: null, rows: roster() })).get(
      "/api/files/share-recipients",
    );
    expect(res.status).toBe(403);
  });
});
