/**
 * WARP-2850 (ADR-051) — POST /api/brain/passes/:passKey/run.
 *
 * 🔴 THE CASE THAT MATTERS MOST is "a chat user cannot start a pass", and it is
 * the one an adversarial review caught before this route was written.
 *
 * Every READ on this router uses `requireRoleOrMcpService`, which calls
 * `next()` for `_service:mcp` BEFORE evaluating any role. The reads survive
 * that because `visibleScopeFilter` re-checks the resolved human inside the
 * query — a ROW protection. An ACTION route has no rows, therefore no filter,
 * therefore nothing: a `family` or `guest` chat user whose `X-Nextcloud-User`
 * resolves would have passed the gate, and `if (!caller)` is not a role check.
 *
 * So this route uses `requireRole`, and these cases are what stop somebody
 * "tidying" it to match its neighbours.
 *
 * The rest pins the contract a UI depends on: 202 without waiting, and four
 * refusals that must read differently — busy, disabled, too soon, and the
 * brain being off entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

import { createBrainRouter } from "../routes/brain.js";
import type { AuthUser } from "../middleware/auth.js";
import type { BrainPassTrigger, TriggerOutcome } from "../services/brain/brain-pass-runner.js";

const owner: AuthUser = { id: "u-owner", username: "stefan", displayName: "S", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "romain", displayName: "R", role: "admin" };
const family: AuthUser = { id: "u-kid", username: "kid", displayName: "K", role: "family" };
const guest: AuthUser = { id: "u-g", username: "g", displayName: "G", role: "guest" };
/** The mcp-server's principal, as the middleware sees it on a tool call. */
const mcp: AuthUser = {
  id: "_service:mcp",
  username: "_service:mcp",
  displayName: "mcp",
  role: "service" as AuthUser["role"],
};

const trigger = vi.fn<(passKey: string, opts?: { manual?: boolean }) => Promise<TriggerOutcome>>();

function passTrigger(): BrainPassTrigger {
  return {
    trigger,
    knownPasses: () => ["detectors", "corpus.documents"],
  };
}

function db() {
  return {
    brainFinding: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    brainDigest: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    brainPass: { findMany: vi.fn(async () => []) },
    fileIndexStatus: { count: vi.fn(async () => 0) },
    user: { findUnique: vi.fn(async () => ({ id: "u-owner", role: "owner" })) },
  } as never;
}

function buildApp(user: AuthUser, withTrigger = true) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createBrainRouter(db(), withTrigger ? passTrigger() : undefined));
  return app;
}

const post = (user: AuthUser, key = "detectors", withTrigger = true) =>
  request(buildApp(user, withTrigger)).post(`/api/brain/passes/${key}/run`);

beforeEach(() => {
  trigger.mockReset();
  trigger.mockResolvedValue({ ok: true });
});

describe("who may start a pass (WARP-2850)", () => {
  it("lets an owner and an admin start one", async () => {
    expect((await post(owner)).status).toBe(202);
    expect((await post(admin)).status).toBe(202);
  });

  it("🔴 REFUSES the mcp service principal — the tool path must not reach this", async () => {
    // The whole reason this route uses `requireRole` rather than the `gate`
    // const its neighbours share. `requireRoleOrMcpService` would `next()`
    // here before ever looking at a role, and there are no rows for a filter
    // to protect. A chat turn must not be able to queue ten inferences ahead
    // of the user's own next question.
    const res = await post(mcp);
    expect(res.status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("refuses family and guest", async () => {
    expect((await post(family)).status).toBe(403);
    expect((await post(guest)).status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("the contract a UI depends on (WARP-2850)", () => {
  it("answers 202 and does NOT wait for the pass", async () => {
    // The corpus pass takes minutes. An HTTP handler must not block for them;
    // the outcome has a home in GET /api/brain/coverage.
    const res = await post(owner, "corpus.documents");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ passKey: "corpus.documents", status: "started" });
    expect(trigger).toHaveBeenCalledWith("corpus.documents", { manual: true });
  });

  it("says BUSY and DISABLED differently — they are different answers", async () => {
    // One is "hold on", the other is "somebody switched this off on purpose".
    // A UI that conflates them tells an operator to wait for something that is
    // never going to happen.
    trigger.mockResolvedValueOnce({ ok: false, reason: "busy" });
    const busy = await post(owner);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe("busy");

    trigger.mockResolvedValueOnce({ ok: false, reason: "disabled" });
    const off = await post(owner);
    expect(off.status).toBe(409);
    expect(off.body.error).toBe("disabled");
  });

  it("reports NO MODEL as its own answer, never as 202 started", async () => {
    // 🔴 The regression this case exists for: the "no model configured" check
    // had drifted INSIDE the runner, which runs only after the claim already
    // stamped the row. The route saw `started: true` and told the operator
    // "Started. This page will show what it finds." while nothing ran.
    // `no_model` is a configuration answer, and the box must say so.
    trigger.mockResolvedValueOnce({ ok: false, reason: "no_model" });
    const res = await post(owner, "corpus.documents");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_model");
  });

  it("reports a MISSING pass row as itself, not as busy", async () => {
    // `claimPass` answers `missing` when the row is not there at all — a
    // different problem from contention, and one waiting will never fix.
    trigger.mockResolvedValueOnce({ ok: false, reason: "missing" });
    const res = await post(owner);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("missing");
  });

  it("reports a shutting-down box as itself (WARP-2837's latch)", async () => {
    trigger.mockResolvedValueOnce({ ok: false, reason: "shutting_down" });
    const res = await post(owner);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shutting_down");
  });

  it("answers 429 with Retry-After when a manual run is too soon", async () => {
    trigger.mockResolvedValueOnce({ ok: false, reason: "too_soon", retryAfterMs: 90_000 });
    const res = await post(owner, "corpus.documents");
    expect(res.status).toBe(429);
    // SECONDS on the header, and the same number in the body so a client does
    // not have to guess which unit it got.
    expect(res.headers["retry-after"]).toBe("90");
    expect(res.body).toEqual({ error: "too_soon", retryAfterSeconds: 90 });
  });

  it("rounds a sub-second remainder UP, never to zero", async () => {
    // "Retry after 0 seconds" invites an immediate retry that will also fail.
    trigger.mockResolvedValueOnce({ ok: false, reason: "too_soon", retryAfterMs: 200 });
    const res = await post(owner, "corpus.documents");
    expect(res.headers["retry-after"]).toBe("1");
  });

  it("rejects a pass key that is not in the runner registry", async () => {
    const res = await post(owner, "detectors/../../etc");
    expect([400, 404]).toContain(res.status);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("rejects a known-looking but unregistered key with 400", async () => {
    const res = await post(owner, "corpus.emails");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_pass");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("answers 503 when the brain is off, not 404", async () => {
    // The READ surface is mounted unconditionally, so the route exists on a
    // box where no pass was ever registered. 404 would read as a wrong URL.
    const res = await post(owner, "detectors", false);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("brain_disabled");
  });

  it("never marks a pass running when the brain is off", async () => {
    await post(owner, "detectors", false);
    expect(trigger).not.toHaveBeenCalled();
  });
});
