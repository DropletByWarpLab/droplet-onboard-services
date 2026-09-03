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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractCitedFilePaths } from "../services/llm-agent.service.js";
import { parseToolResultPayload } from "../services/tool-result-payload.js";
import { mcpWirePayload, mcpWireText } from "./fixtures/mcp-wire.js";
import { createFileCitationService } from "../services/file-citation.service.js";
import { createFilesRouter } from "../routes/files.js";
import type { AuthUser } from "../middleware/auth.js";
import type { FileEntryInfo } from "../types/index.js";
import { repoPath, packagePath } from "./helpers/test-paths.js";

/**
 * A real directory listing, typed as the orchestrator's own `FileEntryInfo` —
 * the exact element type `GET /api/files` builds and `res.json`s, and
 * therefore exactly what `list_files` returns as its `data`. Typing it this
 * way is what stops a future fixture from inventing a shape again: an
 * invented one no longer compiles.
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

// ── 1. Extractor ──────────────────────────────────────────────────
//
// WARP-1604 — every case below feeds the PRODUCTION payload: a real
// `ToolResult` run through mcp-server's serializer (`mcpWirePayload`), which
// drops the `{ ok, data }` envelope and puts the handler's own object on the
// wire. The previous version of this suite hand-built the envelope, so it
// passed against an extractor that could only ever return `[]` in
// production — the FileCitation table went unwritten for an entire release.
describe("WARP-473 — extractCitedFilePaths", () => {
  it("pulls the root `path` from single-file tool results (read_file shape)", () => {
    const payload = mcpWirePayload({
      ok: true,
      data: { path: "/Documents/foo.pdf", content: "…" },
    });
    expect(extractCitedFilePaths(payload)).toEqual(["/Documents/foo.pdf"]);
  });

  it("pulls every root `results[].path` from search hits (search_content shape)", () => {
    const payload = mcpWirePayload({
      ok: true,
      data: {
        query: "invoices",
        results: [
          { path: "/Documents/inv-1.pdf", text: "…" },
          { path: "/Documents/inv-2.pdf", text: "…" },
        ],
      },
    });
    expect(extractCitedFilePaths(payload)).toEqual([
      "/Documents/inv-1.pdf",
      "/Documents/inv-2.pdf",
    ]);
  });

  // The list_files shape, built from the REAL response type rather than an
  // invented one. `list_files` returns the orchestrator directory route's
  // body verbatim, and that route `res.json(entries)` with a bare
  // `FileEntryInfo[]` — no `files`, no `items`, no object at all. Typing the
  // fixture as `FileEntryInfo[]` is what keeps it honest: an invented shape
  // stops compiling.
  //
  // The first version of this suite asserted `{ files: [{ path }] }` here,
  // which no handler emits, so it certified a path that returned `[]` in
  // production for the single highest-frequency file tool in the agent loop.
  it("pulls paths from a BARE ARRAY root (the real list_files shape)", () => {
    const payload = mcpWirePayload({ ok: true, data: listing });
    // Pin the wire text too: this is what mcp-server actually sends, and the
    // whole bug was that it starts with `[`, not `{`.
    expect(mcpWireText({ ok: true, data: listing }).startsWith("[")).toBe(true);
    // Only the FILE. `listing`'s second entry is a directory, and WARP-1656
    // skips those — see the dedicated block below. What this case pins is that
    // a bare array is descended into at all.
    expect(extractCitedFilePaths(payload)).toEqual(["/Invoices/Q2.csv"]);
  });

  it("an empty listing yields no citations (the legitimate zero case)", () => {
    const empty: FileEntryInfo[] = [];
    expect(extractCitedFilePaths(mcpWirePayload({ ok: true, data: empty }))).toEqual(
      [],
    );
  });

  it("caps a bare-array listing at 20 paths too", () => {
    const many: FileEntryInfo[] = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}.txt`,
      path: `/Invoices/f${i}.txt`,
      isDirectory: false,
      size: 1,
      mimeType: "text/plain",
      modifiedAt: "2026-06-01T09:00:00.000Z",
    }));
    expect(extractCitedFilePaths(mcpWirePayload({ ok: true, data: many }))).toHaveLength(
      20,
    );
  });

  it("handles root `items[].path` (search_files / list_recent_files shape)", () => {
    const payload = mcpWirePayload({
      ok: true,
      data: { items: [{ path: "/a.txt" }, { path: "/b.txt" }] },
    });
    expect(extractCitedFilePaths(payload)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("handles root `files[].path` (a listing wrapped under `files`)", () => {
    const payload = mcpWirePayload({
      ok: true,
      data: { files: [{ path: "/a.txt" }, { path: "/b.txt" }] },
    });
    expect(extractCitedFilePaths(payload)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("de-dupes identical paths within one tool result", () => {
    const payload = mcpWirePayload({
      ok: true,
      data: { path: "/a.txt", results: [{ path: "/a.txt" }, { path: "/b.txt" }] },
    });
    expect(extractCitedFilePaths(payload)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("caps at 20 paths per result", () => {
    const results = Array.from({ length: 50 }, (_, i) => ({ path: `/f${i}.txt` }));
    expect(extractCitedFilePaths(mcpWirePayload({ ok: true, data: { results } }))).toHaveLength(
      20,
    );
  });

  it("returns empty for non-file results", () => {
    expect(extractCitedFilePaths(mcpWirePayload({ ok: true, data: { status: "ok" } }))).toEqual(
      [],
    );
    expect(extractCitedFilePaths(mcpWirePayload({ ok: true, data: {} }))).toEqual([]);
    expect(extractCitedFilePaths(mcpWirePayload({ ok: true, data: null }))).toEqual([]);
  });

  it("returns empty for the failure + confirmation branches of the wire contract", () => {
    expect(
      extractCitedFilePaths(
        mcpWirePayload({
          ok: false,
          status: "error",
          error: { code: "LIST_FAILED", message: "nextcloud returned 500" },
        }),
      ),
    ).toEqual([]);
    // confirmation_required is NOT an error to the agent loop, so it does
    // reach the extractor — it must still yield nothing (nothing was read).
    expect(
      extractCitedFilePaths(
        mcpWirePayload({
          ok: false,
          status: "confirmation_required",
          error: { code: "CONFIRM", message: "approve first", details: { type: "delete_file" } },
        }),
      ),
    ).toEqual([]);
  });

  it("ignores non-string path values", () => {
    const payload = mcpWirePayload({
      ok: true,
      data: { results: [{ path: 123 }, { path: "/real.txt" }] },
    });
    expect(extractCitedFilePaths(payload)).toEqual(["/real.txt"]);
  });

  it("survives non-JSON wire text (the `{ raw }` degrade path)", () => {
    expect(extractCitedFilePaths(parseToolResultPayload("not json at all"))).toEqual([]);
  });

  // THE regression. Before WARP-1604 the extractor walked `data.*`, which is
  // only ever populated if someone puts the envelope itself on the wire —
  // something mcp-server does not do. Assert the dead shape stays dead so a
  // future "let me also support the envelope" patch has to argue with a test
  // instead of silently reviving two competing contracts.
  it("does NOT read the legacy `{ ok, data }` envelope (WARP-1604 regression)", () => {
    const legacyEnvelopeOnTheWire = parseToolResultPayload(
      JSON.stringify({ ok: true, data: { path: "/Documents/foo.pdf" } }),
    );
    expect(extractCitedFilePaths(legacyEnvelopeOnTheWire)).toEqual([]);
  });
});

// ── 1b. Shape-drift guard ─────────────────────────────────────────
//
// `fixtures/mcp-wire.ts` models mcp-server's serializer. mcp-server lives in
// another workspace and the orchestrator does not import it at runtime, so
// nothing but this canary stops the two from drifting. If it reds, read
// `toolResultToContent` and update BOTH the fixture and
// `services/tool-result-payload.ts` — do not just relax the assertion.
// Anchored to this test file, not to the runner's cwd (WARP-2654): the old
// candidate list took the first entry that existed, so a cwd inside a second
// checkout of this repo made it read that tree's mcp-server instead.
const MCP_SERVER_SOURCE = repoPath("services/mcp-server/src/server.ts");

describe("WARP-1604 — mcp-server ↔ extractor payload contract", () => {
  const source = readFileSync(MCP_SERVER_SOURCE, "utf8").replace(/\s+/g, "");

  it("still UNWRAPS the envelope on success (JSON.stringify(result.data))", () => {
    expect(source).toContain("JSON.stringify(result.data)");
    // The envelope itself must not be what goes on the wire.
    expect(source).not.toContain("JSON.stringify(result)");
  });

  it("still emits { status, error } — no ok, no data — on failure", () => {
    expect(source).toContain("status:result.status");
    expect(source).toContain("error:result.error");
  });

  it("fixture text matches the contract the extractor is written against", () => {
    // Success: the handler payload, at the root. No `ok`, no `data`.
    expect(mcpWireText({ ok: true, data: { path: "/x.txt" } })).toBe('{"path":"/x.txt"}');
    // Failure: status + error, at the root.
    expect(
      mcpWireText({ ok: false, status: "error", error: { code: "E", message: "m" } }),
    ).toBe('{"status":"error","error":{"code":"E","message":"m"}}');
  });
});

// The SECOND drift seam, and the one that made the first fix incomplete.
//
// `list_files` (tools-core) does `const data = await res.json(); return { ok:
// true, data }` — `data` is typed `unknown`, so nothing on the tools-core side
// records what shape it is. The real answer lives in the orchestrator's own
// directory route, which responds with a bare `FileEntryInfo[]`. That is why
// the extractor needs an array branch at all, and a test cannot learn it from
// any type: it has to be pinned against the route.
//
// If this reds, the listing route's response shape changed. Update
// `extractCitedFilePaths` to match BEFORE relaxing the assertion — a wrapped
// shape that the extractor does not read means zero FileCitation rows for the
// highest-frequency file tool in the agent loop, silently, which is exactly
// the failure this PR exists to fix.
// Anchored to this test file, the same way MCP_SERVER_SOURCE above is
// (WARP-2654).
const FILES_ROUTE_SOURCE = packagePath("src/routes/files.ts");

describe("WARP-1604 — the listing route still answers with a BARE array", () => {
  const routeSource = readFileSync(FILES_ROUTE_SOURCE, "utf8").replace(
    /\s+/g,
    "",
  );

  it("responds with the entries array itself, not an object wrapper", () => {
    // All three branches that can answer this route, each pinned by a probe
    // that occurs exactly once in the stripped source — so wrapping any one of
    // them reds this test.
    //
    // The cache-hit branch needs the whole `cacheGet → res.json(cached)` block,
    // not just the generic: `cacheGet<FileEntryInfo[]>(cacheKey)` appears 4x in
    // this file (:1633, :2825, :2854, :2895) and `res.json(cached);` 2x (:966,
    // :1635), so neither pins this branch alone. Typing the cache to an object
    // wrapper while the cold path still sent a bare array left the suite green
    // — and that shape kills citations ONLY on cache hits: intermittent,
    // TTL-windowed, no error, and the extractor's backstop is debug-level only.
    expect(routeSource).toContain("res.json(entries);"); // normal branch
    expect(routeSource).toContain("handleFileError(err,res,next,[]);"); // degrade branch
    expect(routeSource).toContain(
      "constcached=awaitcacheGet<FileEntryInfo[]>(cacheKey);if(cached){res.json(cached);return;}",
    ); // cache-hit branch
  });

  it("the extractor reads that shape", () => {
    // The end of the chain: route body → list_files `data` → wire → extractor.
    const routeBody: FileEntryInfo[] = listing;
    // The directory entry is dropped by WARP-1656; the file survives, which is
    // what proves the chain is connected end to end.
    expect(
      extractCitedFilePaths(mcpWirePayload({ ok: true, data: routeBody })),
    ).toEqual(["/Invoices/Q2.csv"]);
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
// WARP-1604 merge note: these cases now feed the PRODUCTION payload via
// `mcpWirePayload`, like every other extractor case above. They were written
// against the hand-built `{ ok, data }` envelope, which the wire has never
// carried — the exact shape WARP-1604 removed. The assertions are unchanged;
// only the way the payload is obtained is. The module-scope `listing` fixture
// is the same `FileEntryInfo[]` this block defined for itself.
describe("WARP-1656 — directory entries are never cited", () => {
  it("drops a directory entry from a listing (search_files / list_recent_files `items` shape)", () => {
    const payload = mcpWirePayload({ ok: true, data: { items: listing } });
    expect(extractCitedFilePaths(payload)).toEqual(["/Invoices/Q2.csv"]);
  });

  it("drops a directory entry under `files` and under `results` too", () => {
    expect(
      extractCitedFilePaths(mcpWirePayload({ ok: true, data: { files: listing } })),
    ).toEqual(["/Invoices/Q2.csv"]);
    expect(
      extractCitedFilePaths(mcpWirePayload({ ok: true, data: { results: listing } })),
    ).toEqual(["/Invoices/Q2.csv"]);
  });

  // WARP-1604: a bare `FileEntryInfo[]` IS the list_files payload, so the
  // directory skip has to hold on the root-array path too — the shape that
  // actually reaches the extractor in production.
  it("drops a directory entry from a BARE-ARRAY listing (list_files shape)", () => {
    const payload = mcpWirePayload({ ok: true, data: listing });
    expect(extractCitedFilePaths(payload)).toEqual(["/Invoices/Q2.csv"]);
  });

  it("keeps entries that declare isDirectory: false", () => {
    const payload = mcpWirePayload({ ok: true, data: { items: [listing[0]] } });
    expect(extractCitedFilePaths(payload)).toEqual(["/Invoices/Q2.csv"]);
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
    const paths = extractCitedFilePaths(
      mcpWirePayload({ ok: true, data: { items: [...dirs, ...files] } }),
    );
    expect(paths).toHaveLength(20);
    // Twenty REAL files, starting at the first one — not 15 files behind 5
    // folders that ate the budget.
    expect(paths).toEqual(files.slice(0, 20).map((f) => f.path));
    expect(paths.some((p) => p.startsWith("/Invoices/Folder"))).toBe(false);
  });

  it("skips a root `path` that declares itself a directory", () => {
    const payload = mcpWirePayload({
      ok: true,
      data: { path: "/Invoices/Archive", isDirectory: true },
    });
    expect(extractCitedFilePaths(payload)).toEqual([]);
  });

  // The shape-driven premise survives: no `isDirectory` field, no change.
  it("leaves payloads that never carry isDirectory untouched", () => {
    const searchHits = mcpWirePayload({
      ok: true,
      data: { results: [{ path: "/a.txt", text: "…" }, { path: "/b.txt", text: "…" }] },
    });
    expect(extractCitedFilePaths(searchHits)).toEqual(["/a.txt", "/b.txt"]);
    expect(
      extractCitedFilePaths(
        mcpWirePayload({ ok: true, data: { path: "/Documents/foo.pdf", content: "…" } }),
      ),
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
