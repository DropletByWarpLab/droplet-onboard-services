/**
 * WARP-881 / WS-3 (ADR-027) — native file comments + tags/metadata.
 *
 * Covers the orchestrator routes added to `createFilesRouter`:
 *   - GET/POST  /files/:filePath(*)/comments   (user-scoped reads)
 *   - DELETE    /files/comments/:id            (author-or-privileged)
 *   - GET/POST  /files/:filePath(*)/tags       (file-scoped reads)
 *   - DELETE    /files/:filePath(*)/tags/:label
 *
 * The prisma mock here ACTUALLY honors `ncFileId` + `authorUserId`
 * filtering — unlike file-citation.test.ts's mock, which ignores
 * `userId`. That is load-bearing: the IDOR case (#4) is the whole point
 * of WS-3's owner column, so the mock must distinguish "my rows" from
 * "everyone's rows" the way Postgres would.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, MAX_UPLOAD_SIZE_MB: 100, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("ncTokenStub"),
}));
const publishMock = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...args: unknown[]) => publishMock(...args),
}));

// Resolve known paths → a deterministic ncFileId; unknown paths → null
// (drives the 404 case). The map is the single source of truth for which
// paths "exist" in these tests.
const PATH_TO_FILEID: Record<string, number> = {
  "/Documents/report.pdf": 4242,
  "/Documents/other.pdf": 7777,
};
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetFileId: vi.fn(
    async (_token: string, _user: string, p: string): Promise<number | null> =>
      PATH_TO_FILEID[p] ?? null,
  ),
  // The router imports many NC fns at module load; stub the rest as no-ops
  // so the import doesn't blow up. Only ncGetFileId is exercised here.
  ncListFiles: vi.fn(),
  ncUploadFile: vi.fn(),
  ncDownloadFile: vi.fn(),
  ncDeleteFile: vi.fn(),
  ncCreateDirectory: vi.fn(),
  ncListShares: vi.fn(),
  ncMoveFile: vi.fn(),
  ncCopyFile: vi.fn(),
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
  NextcloudOcsError: class NextcloudOcsError extends Error {
    ocsStatus: number;
    constructor(message: string, ocsStatus = 400) {
      super(message);
      this.ocsStatus = ocsStatus;
    }
  },
}));

import { createFilesRouter } from "../routes/files.js";
import type { AuthUser } from "../middleware/auth.js";

// ── Stateful prisma mock that honors ncFileId + authorUserId ──────────
interface CommentRow {
  id: string;
  ncFileId: number;
  authorUserId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}
interface TagRow {
  id: string;
  ncFileId: number;
  label: string;
  addedByUserId: string;
  createdAt: Date;
}

let commentSeq = 0;
let tagSeq = 0;

function createPrismaMock(seed: { comments?: CommentRow[]; tags?: TagRow[] } = {}) {
  const comments: CommentRow[] = [...(seed.comments ?? [])];
  const tags: TagRow[] = [...(seed.tags ?? [])];

  const matchWhere = (row: CommentRow, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([k, v]) => (row as unknown as Record<string, unknown>)[k] === v,
    );

  return {
    _comments: comments,
    _tags: tags,
    fileComment: {
      findMany: vi.fn(
        async ({
          where = {},
          orderBy,
        }: {
          where?: Record<string, unknown>;
          orderBy?: unknown;
        }) => {
          void orderBy;
          const filtered = comments.filter((c) => matchWhere(c, where));
          return [...filtered].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        comments.find((c) => c.id === where.id) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: Omit<CommentRow, "id" | "createdAt" | "updatedAt"> }) => {
          const now = new Date(Date.now() + commentSeq);
          const row: CommentRow = {
            id: `cmt-${++commentSeq}`,
            createdAt: now,
            updatedAt: now,
            ...data,
          } as CommentRow;
          comments.push(row);
          return row;
        },
      ),
      // delete is scoped by the route's where {id, [authorUserId]} via
      // deleteMany so the IDOR/author guard is enforced in SQL, not in JS.
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (let i = comments.length - 1; i >= 0; i--) {
          if (matchWhere(comments[i], where)) {
            comments.splice(i, 1);
            count++;
          }
        }
        return { count };
      }),
    },
    fileTag: {
      findMany: vi.fn(
        async ({ where = {}, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) => {
          void orderBy;
          return tags.filter((t) =>
            Object.entries(where).every(
              ([k, v]) => (t as unknown as Record<string, unknown>)[k] === v,
            ),
          );
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { ncFileId_label: { ncFileId: number; label: string } };
          create: Omit<TagRow, "id" | "createdAt">;
          update: Record<string, unknown>;
        }) => {
          const { ncFileId, label } = where.ncFileId_label;
          const existing = tags.find((t) => t.ncFileId === ncFileId && t.label === label);
          if (existing) {
            // @@unique upsert no-op: original addedByUserId/createdAt preserved.
            return existing;
          }
          const row: TagRow = {
            id: `tag-${++tagSeq}`,
            createdAt: new Date(Date.now() + tagSeq),
            ...create,
          } as TagRow;
          tags.push(row);
          return row;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (let i = tags.length - 1; i >= 0; i--) {
          if (
            Object.entries(where).every(
              ([k, v]) => (tags[i] as unknown as Record<string, unknown>)[k] === v,
            )
          ) {
            tags.splice(i, 1);
            count++;
          }
        }
        return { count };
      }),
    },
    // WARP-1260 (T8): the metadata-route department gate resolves
    // `ncFileId -> File.departmentId` on every call. No file in this
    // suite is registered to a department, so `findUnique` always
    // resolves null — the gate is a no-op and existing personal-space
    // behavior (asserted throughout this file) is unaffected.
    file: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

function mkUser(role: AuthUser["role"], id: string, username = id): AuthUser {
  return { id, username, displayName: username, role };
}

/** Read the `where` clause of a findMany mock's most-recent call. */
function lastFindManyWhere(fn: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  const calls = fn.mock.calls;
  const arg = calls[calls.length - 1]?.[0] as { where?: Record<string, unknown> };
  return arg?.where ?? {};
}

function buildApp(prismaMock: ReturnType<typeof createPrismaMock>, user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createFilesRouter(prismaMock as any));
  return app;
}

const OWNER = () => mkUser("owner", "user-owner");
const FAMILY_A = () => mkUser("family", "user-fam-a");
const FAMILY_B = () => mkUser("family", "user-fam-b");
const GUEST = () => mkUser("guest", "user-guest");

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Comments ──────────────────────────────────────────────────────────
describe("WARP-881 — file comments", () => {
  it("(1) POST then GET round-trips a comment", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, FAMILY_A());
    const post = await request(app)
      .post("/api/files/Documents/report.pdf/comments")
      .send({ body: "Looks good to me" });
    expect(post.status).toBe(201);
    expect(post.body.comment.body).toBe("Looks good to me");

    const get = await request(app).get("/api/files/Documents/report.pdf/comments");
    expect(get.status).toBe(200);
    expect(get.body.comments).toHaveLength(1);
    expect(get.body.comments[0].body).toBe("Looks good to me");
  });

  it("(1b) POST publishes an MQTT comment-added event", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, FAMILY_A());
    await request(app)
      .post("/api/files/Documents/report.pdf/comments")
      .send({ body: "ping" });
    expect(publishMock).toHaveBeenCalled();
    const topics = publishMock.mock.calls.map((c) => String(c[0]));
    expect(topics.some((t) => t.includes("comment-added"))).toBe(true);
  });

  it("(2) rejects an empty body with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, FAMILY_A());
    const res = await request(app)
      .post("/api/files/Documents/report.pdf/comments")
      .send({ body: "" });
    expect(res.status).toBe(400);
    expect(prisma.fileComment.create).not.toHaveBeenCalled();
  });

  it("(3) returns 404 for an unknown path", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, FAMILY_A());
    const res = await request(app)
      .post("/api/files/Documents/missing.pdf/comments")
      .send({ body: "hi" });
    expect(res.status).toBe(404);
  });

  it("(4) IDOR: stores authorUserId = req.user.id and filters reads by it", async () => {
    const prisma = createPrismaMock();
    // Family A writes a comment.
    const appA = buildApp(prisma, FAMILY_A());
    const post = await request(appA)
      .post("/api/files/Documents/report.pdf/comments")
      .send({ body: "private to A" });
    expect(post.status).toBe(201);
    // The stored owner column is the UUID, NOT the username.
    expect(prisma.fileComment.create.mock.calls[0][0].data.authorUserId).toBe(
      "user-fam-a",
    );

    // Family B sees ZERO of A's comments (scoped to its own id).
    const appB = buildApp(prisma, FAMILY_B());
    const getB = await request(appB).get("/api/files/Documents/report.pdf/comments");
    expect(getB.status).toBe(200);
    expect(getB.body.comments).toHaveLength(0);
    // The read filter carried the requester's UUID.
    const lastFindWhere = lastFindManyWhere(prisma.fileComment.findMany);
    expect(lastFindWhere.authorUserId).toBe("user-fam-b");
    expect(lastFindWhere.ncFileId).toBe(4242);

    // Owner sees A's comment (privileged → no authorUserId filter).
    const appOwner = buildApp(prisma, OWNER());
    const getOwner = await request(appOwner).get(
      "/api/files/Documents/report.pdf/comments",
    );
    expect(getOwner.body.comments).toHaveLength(1);
    const ownerFindWhere = lastFindManyWhere(prisma.fileComment.findMany);
    expect(ownerFindWhere.authorUserId).toBeUndefined();
  });

  it("(5) delete own→204, other's as family→403, as owner→204", async () => {
    const now = new Date();
    const seed: CommentRow[] = [
      {
        id: "cmt-A",
        ncFileId: 4242,
        authorUserId: "user-fam-a",
        body: "A's",
        createdAt: now,
        updatedAt: now,
      },
    ];

    // Author deletes own → 204.
    const prisma1 = createPrismaMock({ comments: [...seed] });
    const appA = buildApp(prisma1, FAMILY_A());
    const delOwn = await request(appA).delete("/api/files/comments/cmt-A");
    expect(delOwn.status).toBe(204);
    expect(prisma1._comments).toHaveLength(0);

    // Other family member → 403, row untouched.
    const prisma2 = createPrismaMock({ comments: [...seed] });
    const appB = buildApp(prisma2, FAMILY_B());
    const delOther = await request(appB).delete("/api/files/comments/cmt-A");
    expect(delOther.status).toBe(403);
    expect(prisma2._comments).toHaveLength(1);

    // Owner can delete anyone's → 204.
    const prisma3 = createPrismaMock({ comments: [...seed] });
    const appOwner = buildApp(prisma3, OWNER());
    const delOwner = await request(appOwner).delete("/api/files/comments/cmt-A");
    expect(delOwner.status).toBe(204);
    expect(prisma3._comments).toHaveLength(0);
  });

  it("(6) rejects a guest with 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, GUEST());
    const getRes = await request(app).get("/api/files/Documents/report.pdf/comments");
    expect(getRes.status).toBe(403);
    const postRes = await request(app)
      .post("/api/files/Documents/report.pdf/comments")
      .send({ body: "nope" });
    expect(postRes.status).toBe(403);
  });

  it("(12) /files/comments/:id routes to comment-delete (not shadowed by the wildcard)", async () => {
    const now = new Date();
    const prisma = createPrismaMock({
      comments: [
        {
          id: "cmt-Z",
          ncFileId: 4242,
          authorUserId: "user-fam-a",
          body: "z",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const app = buildApp(prisma, FAMILY_A());
    const res = await request(app).delete("/api/files/comments/cmt-Z");
    // 204 (deleted) proves it hit the literal comment-delete handler, not the
    // `:filePath(*)/tags/:label` wildcard (which would 404 / 400).
    expect(res.status).toBe(204);
    expect(prisma.fileComment.deleteMany).toHaveBeenCalled();
    // ncGetFileId must NOT be invoked — the literal route does no path resolution.
    const nc = await import("../services/nextcloud.client.js");
    expect((nc.ncGetFileId as any).mock.calls.length).toBe(0);
  });
});

// ── Tags ────────────────────────────────────────────────────────────────
describe("WARP-881 — file tags", () => {
  it("(7) tag POST then GET returns the label", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, FAMILY_A());
    const post = await request(app)
      .post("/api/files/Documents/report.pdf/tags")
      .send({ label: "invoice" });
    expect(post.status).toBe(201);

    const get = await request(app).get("/api/files/Documents/report.pdf/tags");
    expect(get.status).toBe(200);
    expect(get.body.tags.map((t: { label: string }) => t.label)).toContain("invoice");
  });

  it("(8) duplicate label is an idempotent upsert — one row, addedBy/createdAt unchanged", async () => {
    const prisma = createPrismaMock();
    const appA = buildApp(prisma, FAMILY_A());
    await request(appA).post("/api/files/Documents/report.pdf/tags").send({ label: "tax" });
    const firstRow = prisma._tags.find((t) => t.label === "tax");
    expect(firstRow?.addedByUserId).toBe("user-fam-a");
    const firstCreatedAt = firstRow?.createdAt;

    // A different user re-adds the same label.
    const appB = buildApp(prisma, FAMILY_B());
    const dup = await request(appB)
      .post("/api/files/Documents/report.pdf/tags")
      .send({ label: "tax" });
    expect(dup.status).toBe(201);

    const taxRows = prisma._tags.filter((t) => t.label === "tax" && t.ncFileId === 4242);
    expect(taxRows).toHaveLength(1);
    expect(taxRows[0].addedByUserId).toBe("user-fam-a"); // original provenance kept
    expect(taxRows[0].createdAt).toEqual(firstCreatedAt);
  });

  it("(9) tag DELETE returns 204 and removes the row", async () => {
    const prisma = createPrismaMock({
      tags: [
        {
          id: "tag-1",
          ncFileId: 4242,
          label: "draft",
          addedByUserId: "user-fam-a",
          createdAt: new Date(),
        },
      ],
    });
    const app = buildApp(prisma, FAMILY_A());
    const res = await request(app).delete("/api/files/Documents/report.pdf/tags/draft");
    expect(res.status).toBe(204);
    expect(prisma._tags).toHaveLength(0);
  });

  it("(10) rejects an empty or >64-char label with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, FAMILY_A());
    const empty = await request(app)
      .post("/api/files/Documents/report.pdf/tags")
      .send({ label: "" });
    expect(empty.status).toBe(400);
    const tooLong = await request(app)
      .post("/api/files/Documents/report.pdf/tags")
      .send({ label: "x".repeat(65) });
    expect(tooLong.status).toBe(400);
    expect(prisma.fileTag.upsert).not.toHaveBeenCalled();
  });

  it("(11) tags are file-scoped — family B sees a tag added by family A", async () => {
    const prisma = createPrismaMock();
    const appA = buildApp(prisma, FAMILY_A());
    await request(appA).post("/api/files/Documents/report.pdf/tags").send({ label: "shared" });

    const appB = buildApp(prisma, FAMILY_B());
    const get = await request(appB).get("/api/files/Documents/report.pdf/tags");
    expect(get.status).toBe(200);
    expect(get.body.tags.map((t: { label: string }) => t.label)).toContain("shared");
    // The read filter is ncFileId-only — NO addedByUserId scoping.
    const lastFindWhere = lastFindManyWhere(prisma.fileTag.findMany);
    expect(lastFindWhere.addedByUserId).toBeUndefined();
    expect(lastFindWhere.ncFileId).toBe(4242);
  });

  it("returns 404 for tags on an unknown path", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, FAMILY_A());
    const res = await request(app).get("/api/files/Documents/missing.pdf/tags");
    expect(res.status).toBe(404);
  });

  it("rejects a guest with 403 on tags", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, GUEST());
    const res = await request(app).get("/api/files/Documents/report.pdf/tags");
    expect(res.status).toBe(403);
  });
});
