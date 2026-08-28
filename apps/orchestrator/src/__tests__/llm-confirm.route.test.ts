/**
 * WARP-2469 — `POST /api/llm/confirm/:challengeId`, the only route that
 * turns a human's thumbs-up into the WARP-2305 interceptor's bound
 * token.
 *
 * The REAL `requireRole` runs here (this file deliberately does NOT mock
 * `../middleware/auth.js`, unlike most llm route tests) because the
 * assertion is not just "a guest gets 403" — it is "a guest gets 403 AND
 * a `recordAccessDenied` policy-violation row is written". An inlined
 * role compare passes the first half and silently fails the second,
 * which is exactly the class WARP-1062 was filed for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const recordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => recordActivity(...args),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  chatStream: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

import { createLlmRouter } from "../routes/llm.js";
import { chatApprovalStore } from "../services/chat-approval.service.js";

/** `delete_file` is a WRITE tool, so only a privileged tier may approve. */
const WRITE_TOOL = "delete_file";

function appAs(role: string | undefined, username = "romain") {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as unknown as { user: unknown }).user = {
        id: "00000000-0000-4000-8000-000000000001",
        username,
        role,
      };
    }
    next();
  });
  app.use("/api", createLlmRouter({} as never));
  return app;
}

function seedChallenge(tool = WRITE_TOOL, userId = "romain") {
  return chatApprovalStore.register({
    tool,
    args: { path: "/Shared/payroll.xlsx" },
    token: "interceptor-secret-token",
    expiresAt: Date.now() + 60_000,
    userId,
  }).challengeId;
}

/** Denial rows written by `recordAccessDenied` (kind "auth"). */
function accessDeniedRows() {
  return recordActivity.mock.calls
    .map((c) => c[0] as { kind?: string; what?: string; refs?: { reason?: string } })
    .filter((p) => p.kind === "auth" && p.what === "Access denied");
}

beforeEach(() => {
  recordActivity.mockClear();
});

describe("POST /api/llm/confirm/:challengeId — RBAC at registration", () => {
  it("refuses a guest with 403 AND writes a recordAccessDenied row", async () => {
    const challengeId = seedChallenge();
    const res = await request(appAs("guest"))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });

    expect(res.status).toBe(403);
    // MUTATION (replace `requireRole(...)` with an inlined role compare):
    // the 403 above still passes, this assertion goes red.
    const rows = accessDeniedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refs!.reason).toBe("role-not-permitted");

    // …and the challenge is untouched, so a guest cannot burn one either.
    expect(chatApprovalStore.get(challengeId)!.status).toBe("pending");
  });

  it("refuses an unauthenticated caller with 403 and a `no-role` row", async () => {
    const challengeId = seedChallenge();
    const res = await request(appAs(undefined))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });

    expect(res.status).toBe(403);
    expect(accessDeniedRows()[0]!.refs!.reason).toBe("no-role");
  });

  it("refuses a `family` tier for a WRITE tool, with its own denial row", async () => {
    const challengeId = seedChallenge();
    const res = await request(appAs("family"))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });

    // `family` passes registration but fails the per-tool tier check —
    // the same `toolAllowedForTier` predicate the chat dispatch path uses,
    // so approval and execution cannot disagree about what a tier may do.
    expect(res.status).toBe(403);
    expect(accessDeniedRows()[0]!.refs!.reason).toBe("confirm-tool-tier");
    expect(chatApprovalStore.get(challengeId)!.status).toBe("pending");
  });
});

describe("POST /api/llm/confirm/:challengeId — approve", () => {
  it("returns the bound token to an owner and audits the approval", async () => {
    const challengeId = seedChallenge();
    const res = await request(appAs("owner"))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      challengeId,
      status: "approved",
      tool: WRITE_TOOL,
      confirmationToken: "interceptor-secret-token",
    });

    const approvals = recordActivity.mock.calls
      .map((c) => c[0] as { refs?: { confirmation?: string; name?: string } })
      .filter((p) => p.refs?.confirmation === "user_approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.refs!.name).toBe(WRITE_TOOL);
    // The audit row is PHI-free by shape — there is no field the tool's
    // arguments could have been placed in.
    expect(JSON.stringify(approvals[0])).not.toContain("payroll");
  });

  it("is single-use: a replayed approval is 409", async () => {
    const challengeId = seedChallenge();
    const app = appAs("owner");
    await request(app).post(`/api/llm/confirm/${challengeId}`).send({ decision: "approve" });
    const second = await request(app)
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });
    expect(second.status).toBe(409);
    expect(second.body.status).toBe("already_resolved");
  });

  it("refuses a challenge raised on another user's turn", async () => {
    const challengeId = seedChallenge(WRITE_TOOL, "stefan");
    const res = await request(appAs("owner", "romain"))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });
    expect(res.status).toBe(409);
    expect(res.body.status).toBe("not_owner");
  });

  it("404s an unknown challenge, without leaking whether one ever existed", async () => {
    const res = await request(appAs("owner"))
      .post("/api/llm/confirm/does-not-exist")
      .send({ decision: "approve" });
    expect(res.status).toBe(404);
  });

  it("410s an expired challenge so the client can render 'expired' rather than a generic failure", async () => {
    const challengeId = chatApprovalStore.register({
      tool: WRITE_TOOL,
      args: { path: "/x" },
      token: "t",
      expiresAt: Date.now() - 1,
      userId: "romain",
    }).challengeId;
    const res = await request(appAs("owner"))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });
    expect(res.status).toBe(410);
    expect(res.body.status).toBe("expired");
  });

  it("rejects a body that is neither approve nor deny", async () => {
    const challengeId = seedChallenge();
    const res = await request(appAs("owner"))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "maybe" });
    expect(res.status).toBe(400);
    expect(chatApprovalStore.get(challengeId)!.status).toBe("pending");
  });
});

describe("POST /api/llm/confirm/:challengeId — deny", () => {
  it("invalidates the challenge and audits the refusal", async () => {
    const challengeId = seedChallenge();
    const res = await request(appAs("owner"))
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "deny" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "denied", tool: WRITE_TOOL });
    expect(chatApprovalStore.get(challengeId)!.status).toBe("denied");

    const denials = recordActivity.mock.calls
      .map((c) => c[0] as { severity?: string; refs?: { confirmation?: string } })
      .filter((p) => p.refs?.confirmation === "user_denied");
    // MUTATION (drop the deny audit row): red here while the 200 above
    // still passes.
    expect(denials).toHaveLength(1);
    expect(denials[0]!.severity).toBe("warn");
  });

  it("cannot be approved afterwards", async () => {
    const challengeId = seedChallenge();
    const app = appAs("owner");
    await request(app).post(`/api/llm/confirm/${challengeId}`).send({ decision: "deny" });
    const res = await request(app)
      .post(`/api/llm/confirm/${challengeId}`)
      .send({ decision: "approve" });
    expect(res.status).toBe(409);
    expect(res.body.status).toBe("already_resolved");
  });
});
