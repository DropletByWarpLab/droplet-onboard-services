/**
 * WARP-2732 (ADR-048) — the extraction canary's trigger endpoint.
 *
 * Two properties, and the second is the one the ticket calls out by name.
 *
 * 🔴 IT MUST NOT BE PRODUCTION-GATED. `admin-retrieval-eval` 404s whenever
 * `NODE_ENV === "production"`, which is every real appliance — and this
 * canary's whole purpose is to run on a real appliance, against the model that
 * box actually serves. A gate you cannot reach where it matters is not a gate,
 * and the `auto` mode CHECK would then be unsatisfiable on any box that has
 * one. Copying the wrong sibling here is a one-line mistake with no symptom
 * until somebody tries to turn auto mode on.
 *
 * And it is owner/admin only: the rag-eval container has no auth of its own.
 *
 * MUTATIONS THESE CATCH:
 *   - add a `NODE_ENV === "production"` 404 to this router
 *   - drop the isAdmin guard
 *   - map an unreachable rag-eval to 500 instead of 503
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

const internalFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: internalFetchMock,
  internalBaseUrl: (u: string) => u,
}));

vi.mock("../middleware/auth.js", () => ({ recordAccessDenied: vi.fn() }));

import { createAdminRagEvalRouter } from "./admin-rag-eval.js";
import type { Role } from "../services/jwt.service.js";

type Principal = { id: string; username: string; displayName: string; role: Role } | null;

function appAs(user: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: unknown }).user = user;
    next();
  });
  app.use("/api", createAdminRagEvalRouter());
  return app;
}

const OWNER = { id: "u1", username: "owner", displayName: "Owner", role: "owner" as Role };
const FAMILY = { id: "u2", username: "fam", displayName: "Fam", role: "family" as Role };

const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_URL = process.env.RAG_EVAL_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAG_EVAL_URL = "http://rag-eval.test:8090";
  // `proxy()` reads `.text()` and parses it itself, so the upstream stub must
  // offer text — a `.json()`-only stub throws inside the try and every case
  // below reads as "rag-eval unreachable", which is a green-looking 503 that
  // proves nothing.
  internalFetchMock.mockResolvedValue({
    ok: true,
    status: 202,
    text: async () =>
      JSON.stringify({ runId: "20260905T101010Z", suite: "extraction" }),
  });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
  if (ORIGINAL_URL === undefined) delete process.env.RAG_EVAL_URL;
  else process.env.RAG_EVAL_URL = ORIGINAL_URL;
});

describe("🔴 the canary is reachable on a real appliance", () => {
  it("MUTATION: add a production 404 — auto mode becomes ungateable on every box", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(appAs(OWNER)).post("/api/admin/rag-eval/run-extraction");
    expect(res.status).toBe(202);
    expect(internalFetchMock).toHaveBeenCalledTimes(1);
  });

  it("relays the run id rather than a verdict", async () => {
    const res = await request(appAs(OWNER)).post("/api/admin/rag-eval/run-extraction");
    // 202 means the run STARTED. A trigger that returned pass/fail would make
    // a measured FAIL indistinguishable from a broken harness — which is the
    // reading that gets a gate switched off rather than investigated.
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ suite: "extraction" });
    expect(res.body).not.toHaveProperty("passed");
  });

  it("asks rag-eval for the extraction suite specifically", async () => {
    await request(appAs(OWNER)).post("/api/admin/rag-eval/run-extraction");
    const url = String(internalFetchMock.mock.calls[0][0]);
    expect(url).toContain("/run-extraction");
  });
});

describe("🔴 the proxy is the auth wall", () => {
  it("MUTATION: drop the isAdmin guard — family fires the canary", async () => {
    // rag-eval binds the internal Docker network and has no auth of its own,
    // so there is no second line of defence behind this one.
    const res = await request(appAs(FAMILY)).post("/api/admin/rag-eval/run-extraction");
    expect(res.status).toBe(403);
    expect(internalFetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await request(appAs(null)).post("/api/admin/rag-eval/run-extraction");
    expect(res.status).toBe(403);
    expect(internalFetchMock).not.toHaveBeenCalled();
  });
});

describe("an inactive eval profile is 503, not 500", () => {
  it("says the service is unavailable rather than that something broke", async () => {
    // rag-eval ships under the `eval` compose profile, off by default. When
    // it is inactive the name does not resolve — that is a configuration
    // state the dashboard can explain, not a fault.
    internalFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(appAs(OWNER)).post("/api/admin/rag-eval/run-extraction");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "rag_eval_unavailable" });
  });

  it("says the same when RAG_EVAL_URL is unset", async () => {
    delete process.env.RAG_EVAL_URL;
    const res = await request(appAs(OWNER)).post("/api/admin/rag-eval/run-extraction");
    expect(res.status).toBe(503);
  });
});
