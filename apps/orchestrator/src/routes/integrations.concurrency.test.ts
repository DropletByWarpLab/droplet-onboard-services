/**
 * A concurrent change to an integration is a 409, not a 500.
 *
 * `connect()`'s reconnect branch and `disconnect()` both run SERIALIZABLE
 * transactions in `integrations.service.ts`, and neither retries. Postgres
 * answers a genuine write-write race with P2034; an optimistic-write miss
 * arrives as P2025. Both mean "nothing was applied, retry".
 *
 * Every other SERIALIZABLE call site in this codebase already maps that to a
 * 409 CONCURRENT_MUTATION (`routes/people.ts`, `routes/auth.ts` — both via the
 * shared `isConcurrencyConflict`). This router did not, so the ordinary way to
 * reach it — double-clicking Disconnect — produced a redacted 500 with no
 * indication that retrying is the right move.
 *
 * The mapping lives in `handleErpError`, the funnel every lifecycle route
 * already runs its errors through, so one branch covers all of them. These
 * tests drive the real router and assert the wire response rather than the
 * helper, because the helper is module-private and the thing that matters is
 * what the dashboard receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const disconnect = vi.fn();
const list = vi.fn();

vi.mock("../services/integrations.service.js", () => ({
  createIntegrationsService: () => ({ disconnect, list }),
}));

import { createIntegrationsRouter } from "./integrations.js";

/** Prisma's shape for both codes: a plain object carrying `code`. */
function prismaError(code: string): Error & { code: string } {
  const err = new Error(`prisma error ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

function app() {
  const a = express();
  a.use(express.json());
  // The lifecycle routes are role-gated; this is the same owner-stamping
  // shim saas-credentials.route.test.ts uses. RBAC is not what these tests
  // are about — the error mapping is.
  a.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u-owner", role: "owner" };
    next();
  });
  a.use("/api", createIntegrationsRouter({} as never));
  // Terminal handler, so an unmapped error surfaces as a 500 here exactly as
  // it would in app.ts — that is the behaviour these tests exist to replace.
  a.use(
    (
      _err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "Internal Server Error" });
    },
  );
  return a;
}

describe("a concurrent integration change answers 409, not 500", () => {
  beforeEach(() => {
    disconnect.mockReset();
    list.mockReset();
  });

  it("maps P2034 (serialization failure) to 409 CONCURRENT_MUTATION", async () => {
    // MUTATION: drop the `isConcurrencyConflict` branch from handleErpError
    // and this returns the 500 the terminal handler renders.
    disconnect.mockRejectedValue(prismaError("P2034"));

    const res = await request(app()).post("/api/integrations/eaglesoft/disconnect");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
    // The body must say retrying is the move; a bare code is what made the
    // 500 useless to the person clicking the button.
    expect(res.body.error).toMatch(/try again/i);
  });

  it("maps P2025 (optimistic-write miss) the same way", async () => {
    // `isConcurrencyConflict` matches both on purpose: the row vanishing
    // between the in-transaction findFirst and the update is the same story
    // from the caller's side — nothing was applied.
    disconnect.mockRejectedValue(prismaError("P2025"));

    const res = await request(app()).post("/api/integrations/eaglesoft/disconnect");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
  });

  it("leaves every other failure alone — an unrelated error is still a 500", async () => {
    // NON-VACUITY. Without this, a handler that answered 409 to everything
    // would pass the two tests above and hide real faults behind a status
    // that tells the dashboard to retry forever.
    disconnect.mockRejectedValue(new Error("connector exploded"));

    const res = await request(app()).post("/api/integrations/eaglesoft/disconnect");

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
  });

  it("does not swallow a successful disconnect", async () => {
    disconnect.mockResolvedValue({ provider: "eaglesoft", status: "DISCONNECTED" });

    const res = await request(app()).post("/api/integrations/eaglesoft/disconnect");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("DISCONNECTED");
  });
});
