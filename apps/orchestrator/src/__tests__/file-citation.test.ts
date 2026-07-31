/**
 * WARP-473 — file-citation extraction + service enqueue + read route.
 *
 * Three concerns under one suite:
 *   1. `extractCitedFilePaths(parsed)` heuristic correctness.
 *   2. `createFileCitationService(prisma).enqueue` fire-and-forget semantics.
 *   3. `GET /api/files/:path/citations` shape + RBAC + de-dup-by-thread.
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
vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

import { extractCitedFilePaths } from "../services/llm-agent.service.js";
import { createFileCitationService } from "../services/file-citation.service.js";
import { createFilesRouter } from "../routes/files.js";
import type { AuthUser } from "../middleware/auth.js";
import type { FileEntryInfo } from "../types/index.js";

// ── 1. Extractor ──────────────────────────────────────────────────
describe("WARP-473 — extractCitedFilePaths", () => {
  it("pulls data.path from single-file tool results (read_file shape)", () => {
    const parsed = { ok: true, data: { path: "/Documents/foo.pdf", content: "…" } };
    expect(extractCitedFilePaths(parsed)).toEqual(["/Documents/foo.pdf"]);
  });

  it("pulls every data.results[].path from search hits", () => {
    const parsed = {
      ok: true,
      data: {
        query: "invoices",
        results: [
          { path: "/Documents/inv-1.pdf", text: "…" },
          { path: "/Documents/inv-2.pdf", text: "…" },
        ],
      },
    };
    expect(extractCitedFilePaths(parsed)).toEqual([
      "/Documents/inv-1.pdf",
      "/Documents/inv-2.pdf",
    ]);
  });

  it("handles data.files[].path (list_files shape)", () => {
    const parsed = {
      ok: true,
      data: { files: [{ path: "/a.txt" }, { path: "/b.txt" }] },
    };
    expect(extractCitedFilePaths(parsed)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("de-dupes identical paths within one tool result", () => {
    const parsed = {
      ok: true,
      data: {
        path: "/a.txt",
        results: [{ path: "/a.txt" }, { path: "/b.txt" }],
      },
    };
    expect(extractCitedFilePaths(parsed)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("caps at 20 paths per result", () => {
    const results = Array.from({ length: 50 }, (_, i) => ({ path: `/f${i}.txt` }));
    const parsed = { ok: true, data: { results } };
    expect(extractCitedFilePaths(parsed)).toHaveLength(20);
  });

  it("returns empty for non-file results", () => {
    expect(extractCitedFilePaths({ ok: true, data: { status: "ok" } })).toEqual([]);
    expect(extractCitedFilePaths(null)).toEqual([]);
    expect(extractCitedFilePaths({})).toEqual([]);
    expect(extractCitedFilePaths({ ok: false, error: { code: "X" } })).toEqual([]);
  });

  it("ignores non-string path values", () => {
    const parsed = { ok: true, data: { results: [{ path: 123 }, { path: "/real.txt" }] } };
    expect(extractCitedFilePaths(parsed)).toEqual(["/real.txt"]);
  });
});

// ── 1b. Directories are not file citations (WARP-1656) ────────────
//
// A listing entry is a `FileEntryInfo`, and directories are elements of that
// array exactly like files. The extractor is deliberately shape-driven — it
// harvests `path` without interpreting the payload — so folders became
// `FileCitation` rows, and worse, they consumed the 20-path budget that real
// files needed.
//
// The rule under test is still a SHAPE rule: an entry that explicitly carries
// a truthy `isDirectory` is skipped. Payloads that never carry the field
// (read_file, search_content hits, …) are untouched, which the last two cases
// in this block pin.
describe("WARP-1656 — directory entries are never cited", () => {
  /**
   * The real listing element type. Typing the fixture as `FileEntryInfo`
   * rather than an ad-hoc object is what stops a future edit from inventing a
   * shape the route never emits.
   */
  const listing: FileEntryInfo[] = [
    {
      name: "Q2.csv",
      path: "/Invoices/Q2.csv",
      isDirectory: false,
      size: 4096,
      mimeType: "text/csv",
      modifiedAt: "2026-06-01T09:00:00.000Z",
    },
    {
      name: "Archive",
      path: "/Invoices/Archive",
      isDirectory: true,
      size: 0,
      mimeType: null,
      modifiedAt: "2026-05-02T11:30:00.000Z",
    },
  ];

  it("drops a directory entry from a listing (search_files / list_recent_files `items` shape)", () => {
    const parsed = { ok: true, data: { items: listing } };
    expect(extractCitedFilePaths(parsed)).toEqual(["/Invoices/Q2.csv"]);
  });

  it("drops a directory entry under `files` and under `results` too", () => {
    expect(extractCitedFilePaths({ ok: true, data: { files: listing } })).toEqual([
      "/Invoices/Q2.csv",
    ]);
    expect(extractCitedFilePaths({ ok: true, data: { results: listing } })).toEqual([
      "/Invoices/Q2.csv",
    ]);
  });

  it("keeps entries that declare isDirectory: false", () => {
    const parsed = { ok: true, data: { items: [listing[0]] } };
    expect(extractCitedFilePaths(parsed)).toEqual(["/Invoices/Q2.csv"]);
  });

  // The harm with teeth. Filtering has to happen BEFORE the cap is charged,
  // otherwise five leading folders still evict five real files and the loss
  // is silent — it presents as "Related chats is missing entries" with
  // nothing in the logs.
  it("directories do not consume the 20-path cap", () => {
    const dirs: FileEntryInfo[] = Array.from({ length: 5 }, (_, i) => ({
      name: `Folder${i}`,
      path: `/Invoices/Folder${i}`,
      isDirectory: true,
      size: 0,
      mimeType: null,
      modifiedAt: "2026-05-02T11:30:00.000Z",
    }));
    const files: FileEntryInfo[] = Array.from({ length: 25 }, (_, i) => ({
      name: `f${i}.csv`,
      path: `/Invoices/f${i}.csv`,
      isDirectory: false,
      size: 10,
      mimeType: "text/csv",
      modifiedAt: "2026-06-01T09:00:00.000Z",
    }));
    const paths = extractCitedFilePaths({
      ok: true,
      data: { items: [...dirs, ...files] },
    });
    expect(paths).toHaveLength(20);
    // Twenty REAL files, starting at the first one — not 15 files behind 5
    // folders that ate the budget.
    expect(paths).toEqual(files.slice(0, 20).map((f) => f.path));
    expect(paths.some((p) => p.startsWith("/Invoices/Folder"))).toBe(false);
  });

  it("skips a root `path` that declares itself a directory", () => {
    const parsed = { ok: true, data: { path: "/Invoices/Archive", isDirectory: true } };
    expect(extractCitedFilePaths(parsed)).toEqual([]);
  });

  // The shape-driven premise survives: no `isDirectory` field, no change.
  it("leaves payloads that never carry isDirectory untouched", () => {
    const searchHits = {
      ok: true,
      data: { results: [{ path: "/a.txt", text: "…" }, { path: "/b.txt", text: "…" }] },
    };
    expect(extractCitedFilePaths(searchHits)).toEqual(["/a.txt", "/b.txt"]);
    expect(
      extractCitedFilePaths({ ok: true, data: { path: "/Documents/foo.pdf", content: "…" } }),
    ).toEqual(["/Documents/foo.pdf"]);
  });
});

// ── 2. Service enqueue ────────────────────────────────────────────
describe("WARP-473 — createFileCitationService.enqueue", () => {
  it("schedules a createMany insert on the next macrotask", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = { fileCitation: { createMany } };
    const svc = createFileCitationService(prisma as any);

    svc.enqueue(["/a.txt", "/b.txt"], { userId: "u-test", threadId: "t1", messageId: "m1" });
    // Synchronously: not yet called (setImmediate hasn't fired).
    expect(createMany).not.toHaveBeenCalled();

    // Drain microtasks + macrotasks.
    await new Promise<void>((r) => setImmediate(r));
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0]).toEqual({
      data: [
        { filePath: "/a.txt", userId: "u-test", threadId: "t1", messageId: "m1" },
        { filePath: "/b.txt", userId: "u-test", threadId: "t1", messageId: "m1" },
      ],
    });
  });

  it("no-ops on an empty path list (no scheduled write)", async () => {
    const createMany = vi.fn();
    const prisma = { fileCitation: { createMany } };
    const svc = createFileCitationService(prisma as any);
    svc.enqueue([], { userId: "u-test", threadId: "t1", messageId: "m1" });
    await new Promise<void>((r) => setImmediate(r));
    expect(createMany).not.toHaveBeenCalled();
  });

  it("swallows insert errors (chat turn must NOT be affected)", async () => {
    const createMany = vi.fn().mockRejectedValue(new Error("DB down"));
    const prisma = { fileCitation: { createMany } };
    const svc = createFileCitationService(prisma as any);
    // Should not throw — caller is sync; pino logs the warn internally.
    expect(() =>
      svc.enqueue(["/a.txt"], { userId: "u-test", threadId: "t1", messageId: "m1" }),
    ).not.toThrow();
    await new Promise<void>((r) => setImmediate(r));
    expect(createMany).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Read route ─────────────────────────────────────────────────
interface CitationRow {
  id: string;
  filePath: string;
  threadId: string;
  messageId: string;
  citedAt: Date;
}
interface SessionRow {
  id: string;
  title: string | null;
  updatedAt: Date;
  userId: string;
}

function createPrismaMock(args: {
  citations?: CitationRow[];
  sessions?: SessionRow[];
} = {}) {
  const citations = [...(args.citations ?? [])];
  const sessions = [...(args.sessions ?? [])];
  return {
    fileCitation: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where?: { filePath?: string };
          orderBy?: unknown;
          take?: number;
        }) => {
          void orderBy;
          const filtered = where?.filePath
            ? citations.filter((c) => c.filePath === where.filePath)
            : citations;
          const sorted = [...filtered].sort(
            (a, b) => b.citedAt.getTime() - a.citedAt.getTime(),
          );
          return take ? sorted.slice(0, take) : sorted;
        },
      ),
    },
    chatSession: {
      findMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] } } }) =>
          sessions.filter((s) => where.id.in.includes(s.id)),
      ),
    },
  };
}

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return { id: `user-${role}`, username, displayName: username, role };
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-473 — GET /api/files/:path/citations", () => {
  it("returns recent citations with title + updatedAt joined from ChatSession", async () => {
    const t1 = new Date("2026-05-27T10:00:00Z");
    const t2 = new Date("2026-05-27T11:00:00Z");
    const prisma = createPrismaMock({
      citations: [
        { id: "c1", filePath: "/Documents/foo.pdf", threadId: "thr-a", messageId: "msg-a", citedAt: t1 },
        { id: "c2", filePath: "/Documents/foo.pdf", threadId: "thr-b", messageId: "msg-b", citedAt: t2 },
      ],
      sessions: [
        { id: "thr-a", title: "Invoice review", updatedAt: t1, userId: "stefan" },
        { id: "thr-b", title: "Quarterly close", updatedAt: t2, userId: "stefan" },
      ],
    });
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/files/Documents/foo.pdf/citations");
    expect(res.status).toBe(200);
    expect(res.body.filePath).toBe("/Documents/foo.pdf");
    expect(res.body.citations).toHaveLength(2);
    // Latest first.
    expect(res.body.citations[0].threadId).toBe("thr-b");
    expect(res.body.citations[0].title).toBe("Quarterly close");
    expect(res.body.citations[1].threadId).toBe("thr-a");
  });

  it("de-dupes by threadId — one row per chat regardless of citation count", async () => {
    const t1 = new Date("2026-05-27T10:00:00Z");
    const t2 = new Date("2026-05-27T11:00:00Z");
    const prisma = createPrismaMock({
      citations: [
        { id: "c1", filePath: "/x.pdf", threadId: "thr-a", messageId: "msg-1", citedAt: t1 },
        { id: "c2", filePath: "/x.pdf", threadId: "thr-a", messageId: "msg-2", citedAt: t2 },
      ],
      sessions: [{ id: "thr-a", title: "Same chat", updatedAt: t2, userId: "stefan" }],
    });
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/files/x.pdf/citations");
    expect(res.status).toBe(200);
    expect(res.body.citations).toHaveLength(1);
    // Latest message wins.
    expect(res.body.citations[0].messageId).toBe("msg-2");
  });

  it("honors ?limit clamped to [1, 50]", async () => {
    const prisma = createPrismaMock({ citations: [] });
    const app = buildApp(prisma, mkUser("family"));
    await request(app).get("/api/files/x.pdf/citations?limit=200");
    expect((prisma.fileCitation.findMany as any).mock.calls[0][0].take).toBe(50);
    await request(app).get("/api/files/x.pdf/citations?limit=0");
    expect((prisma.fileCitation.findMany as any).mock.calls[1][0].take).toBe(1);
  });

  it("returns empty citations array when nothing has cited the file", async () => {
    const prisma = createPrismaMock({ citations: [] });
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/files/never-cited.pdf/citations");
    expect(res.status).toBe(200);
    expect(res.body.citations).toEqual([]);
  });

  it("rejects a guest with 403", async () => {
    const prisma = createPrismaMock({ citations: [] });
    const app = buildApp(prisma, mkUser("guest"));
    const res = await request(app).get("/api/files/foo.pdf/citations");
    expect(res.status).toBe(403);
  });
});
