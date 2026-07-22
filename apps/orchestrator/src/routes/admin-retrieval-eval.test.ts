/**
 * GET /api/admin/retrieval-eval/search — auth posture + eval-user scoping
 * (RAGAS eval-runner auth).
 *
 * The rag-eval container's ragas_runner.py calls this endpoint for every
 * eval question. On a deployed appliance AUTH_ENABLED=true, so the runner
 * now presents the `_service:rag-eval` service-principal bearer — but a
 * service principal owns no corpus of its own (the search arms scope every
 * query to a username), so it must name the eval target user explicitly via
 * `?user=` (wired from RAGAS_EVAL_USER on the rag-eval container).
 *
 * Covers:
 *   - guard: human owner/admin pass, other roles and OTHER service
 *     principals 403, only `_service:rag-eval` is admitted;
 *   - rag-eval principal without ?user= → 400 eval_user_required, decided
 *     BEFORE the heavy lazy retrieval imports;
 *   - human callers keep today's behavior: their own username scopes the
 *     search and ?user= is ignored entirely;
 *   - the production 404 gate is unchanged and still runs first.
 *
 * Harness: req.user injected upstream of the router (same pattern as
 * egress-audit.routes.test.ts); the lazily-imported retrieval modules are
 * mocked so the success path runs without Postgres/gRPC.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// The route guard comes from middleware/auth.ts, whose module load eagerly
// reads config — mock it so no env setup is needed (require-role idiom).
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_RAG_EVAL: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Track whether the handler's lazy retrieval imports ever ran: each factory
// flips a flag when vitest first evaluates the mocked module (i.e. when the
// handler's dynamic import() actually executes). The 400-path tests run
// FIRST in this file and assert the flags are still false — module
// evaluation is cached afterwards, so keep them ahead of the success-path
// tests.
const { lazyImportRan, mockEmbed, mockSearchByVector, mockSearchHybrid } =
  vi.hoisted(() => ({
    lazyImportRan: { fileSearch: false, embedding: false },
    mockEmbed: vi.fn(),
    mockSearchByVector: vi.fn(),
    mockSearchHybrid: vi.fn(),
  }));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  getRedis: vi.fn().mockReturnValue(null),
}));
vi.mock("../services/file-search.service.js", () => {
  lazyImportRan.fileSearch = true;
  return {
    searchByVector: mockSearchByVector,
    searchHybrid: mockSearchHybrid,
  };
});
vi.mock("../services/embedding.client.js", () => {
  lazyImportRan.embedding = true;
  return {
    EmbeddingClient: class {
      embed = mockEmbed;
    },
  };
});
vi.mock("../services/reranker.client.js", () => ({
  RerankerClient: class {},
}));

import { createAdminRetrievalEvalRouter } from "./admin-retrieval-eval.js";
import type { AuthUser } from "../middleware/auth.js";

function mkUser(role: AuthUser["role"], id = `user-${role}`, username = id): AuthUser {
  return { id, username, displayName: username, role };
}

const RAG_EVAL = mkUser("service", "_service:rag-eval", "_service:rag-eval");

function buildApp(user: AuthUser) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createAdminRetrievalEvalRouter({} as PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbed.mockResolvedValue([[0.1, 0.2, 0.3]]);
  mockSearchByVector.mockResolvedValue([]);
  mockSearchHybrid.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Ordered FIRST: must run before any test that legitimately triggers the
// lazy retrieval imports (see lazyImportRan note above). ──
describe("rag-eval principal without ?user= → 400 before heavy imports", () => {
  it("400s eval_user_required and never touches the retrieval modules", async () => {
    const res = await request(buildApp(RAG_EVAL)).get(
      "/api/admin/retrieval-eval/search?q=what%20is%20the%20wifi%20password&variant=vector",
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "eval_user_required" });
    // The 400 is decided before the try-block's dynamic imports — a unit
    // test env (no gRPC, no Postgres) must be able to reach it.
    expect(lazyImportRan.fileSearch).toBe(false);
    expect(lazyImportRan.embedding).toBe(false);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("400s a whitespace-only ?user= the same way", async () => {
    const res = await request(buildApp(RAG_EVAL)).get(
      "/api/admin/retrieval-eval/search?q=test&variant=vector&user=%20%20",
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "eval_user_required" });
    expect(lazyImportRan.fileSearch).toBe(false);
  });
});

describe("guard — requireRoleOrService('_service:rag-eval', 'owner', 'admin')", () => {
  it.each(["family", "guest"] as const)("403s the %s role", async (role) => {
    const res = await request(buildApp(mkUser(role))).get(
      "/api/admin/retrieval-eval/search?q=test",
    );
    expect(res.status).toBe(403);
  });

  it.each([
    "_service:voice",
    "_service:mcp",
    "_service:email",
  ])("403s the generic %s service principal", async (principalId) => {
    const res = await request(buildApp(mkUser("service", principalId, principalId))).get(
      "/api/admin/retrieval-eval/search?q=test&user=alice",
    );
    expect(res.status).toBe(403);
  });

  it("does not admit the rag-eval id without the service role", async () => {
    const res = await request(
      buildApp(mkUser("family", "_service:rag-eval", "_service:rag-eval")),
    ).get("/api/admin/retrieval-eval/search?q=test&user=alice");
    expect(res.status).toBe(403);
  });

  it("admits the _service:rag-eval principal (reaches the handler)", async () => {
    const res = await request(buildApp(RAG_EVAL)).get(
      "/api/admin/retrieval-eval/search?q=test&variant=vector&user=alice",
    );
    expect(res.status).toBe(200);
  });
});

describe("eval-user scoping", () => {
  it("scopes the rag-eval principal's search to the explicit ?user=", async () => {
    const res = await request(buildApp(RAG_EVAL)).get(
      "/api/admin/retrieval-eval/search?q=test&variant=vector&user=alice",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    expect(mockSearchByVector).toHaveBeenCalledTimes(1);
    expect(mockSearchByVector.mock.calls[0][1]).toMatchObject({ userId: "alice" });
  });

  it("scopes the rrf arm to the explicit ?user= too", async () => {
    const res = await request(buildApp(RAG_EVAL)).get(
      "/api/admin/retrieval-eval/search?q=test&variant=rrf&user=alice",
    );
    expect(res.status).toBe(200);
    expect(mockSearchHybrid).toHaveBeenCalledTimes(1);
    expect(mockSearchHybrid.mock.calls[0][1]).toMatchObject({ userId: "alice" });
  });

  it("human admin keeps their OWN corpus — ?user= is ignored entirely", async () => {
    const admin = mkUser("admin", "u-admin", "romain");
    const res = await request(buildApp(admin)).get(
      "/api/admin/retrieval-eval/search?q=test&variant=vector&user=mallory",
    );
    expect(res.status).toBe(200);
    expect(mockSearchByVector).toHaveBeenCalledTimes(1);
    expect(mockSearchByVector.mock.calls[0][1]).toMatchObject({ userId: "romain" });
  });

  it("human owner without ?user= works exactly as before", async () => {
    const owner = mkUser("owner", "u-owner", "stefan");
    const res = await request(buildApp(owner)).get(
      "/api/admin/retrieval-eval/search?q=test&variant=hybrid",
    );
    expect(res.status).toBe(200);
    expect(mockSearchHybrid).toHaveBeenCalledTimes(1);
    expect(mockSearchHybrid.mock.calls[0][1]).toMatchObject({ userId: "stefan" });
  });
});

describe("production 404 gate is unchanged", () => {
  it("404s the rag-eval principal in production before any user resolution", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await request(buildApp(RAG_EVAL)).get(
      "/api/admin/retrieval-eval/search?q=test&user=alice",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});
