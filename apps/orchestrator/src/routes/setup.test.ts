/**
 * Route tests for the PR #372 setup state machine endpoints.
 *
 *   GET   /api/setup/state   → { appliance, setup_step, user_tour_completed }
 *   PATCH /api/setup/state   → persist setup_step (resumability) and/or
 *                              flip appliance→ready / user_tour_completed
 *
 * Both are PUBLIC (mounted before the auth middleware): first-run happens
 * before any user exists, exactly like the existing POST /auth/setup. The
 * snake_case wire shape matches docs/ONBOARDING_STATE_MACHINE.md so the
 * dashboard's AuthGate can consume it directly.
 *
 * Strategy mirrors auth.invites.test.ts: a minimal Express app + supertest,
 * with an in-memory `applianceSetup` Prisma stand-in. The route (and the
 * service it calls) import `SetupStep` as a TYPE only, so they run fine
 * under the global `@prisma/client` mock; we unmock here just to keep this
 * file aligned with setup.service.test.ts and to leave the door open for a
 * real-enum assertion without re-mocking.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.unmock("@prisma/client");

// M1 — the route verifies a dashboard session cookie inline (mirroring
// routes/pm.ts) to authorize the `appliance:"ready"` claim. Stub the JWT
// verifier so a test can present an "authenticated" cookie deterministically
// without minting a real signed token.
// WARP-3193 SEC-AUTH-5 — plus signed tokens that must NOT write to a set-up
// box: a lower role, a revoked session record, a hard-revoked user.
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (token: string) => {
    const base = { username: "x", displayName: "X" };
    switch (token) {
      case "valid-session":
        return { sub: "u1", username: "owner", displayName: "Owner", role: "owner" };
      case "guest-session":
        return { ...base, sub: "u-guest", role: "guest", sid: "sid-live" };
      case "admin-session":
        return { ...base, sub: "u-admin", role: "admin", sid: "sid-live" };
      case "revoked-owner-session":
        return { ...base, sub: "u1", role: "owner", sid: "sid-dead" };
      case "denied-owner-session":
        return { ...base, sub: "u-denied", role: "owner", sid: "sid-live" };
      default:
        return null;
    }
  },
}));
vi.mock("../services/session.service.js", () => ({
  checkSession: vi.fn(async (sid: string) =>
    sid === "sid-dead"
      ? { kind: "missing" }
      : { kind: "ok", record: { userId: "u1", role: "owner", createdAt: 0, lastSeenAt: 0 } },
  ),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  isUserDenied: vi.fn(async (userId: string) => userId === "u-denied"),
}));

// WARP-3047 — the DEFAULT warm (no injected spy) is the active-model warm.
const warmActiveModel = vi.hoisted(() => vi.fn(async (_prisma: unknown) => undefined));
vi.mock("../services/active-model.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/active-model.service.js")>()),
  warmActiveModel: (prisma: unknown) => warmActiveModel(prisma),
}));

import { createSetupRouter } from "./setup.js";

// ── In-memory applianceSetup singleton store ──
//
// `userCount` models whether an admin account exists (the M2 precondition
// for the `ready` transition). Defaults to 1 (admin present) so the
// pre-existing happy-path cases keep exercising the claim; the M1/M2 cases
// seed 0 explicitly to drive the pre-claim rejection.
function createPrismaMock(opts: { userCount?: number; consumedClaims?: number } = {}) {
  let row: Record<string, unknown> | null = null;
  let userCount = opts.userCount ?? 1;
  // WARP-804 — how many `consumed` ClaimCode rows exist (whether the box is
  // claimed; `isClaimed` counts `state="consumed"`). Defaults to 0 so every
  // pre-existing case keeps its exact behaviour — the claim-satisfied
  // short-circuit only fires when a `claim` step meets a claimed box.
  let consumedClaims = opts.consumedClaims ?? 0;
  const db = {
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(db),
    _seed: (r: Record<string, unknown> | null) => {
      row = r;
    },
    _setUserCount: (n: number) => {
      userCount = n;
    },
    // WARP-804 — simulate a claimed box (a consumed ClaimCode exists).
    _setConsumedClaims: (n: number) => {
      consumedClaims = n;
    },
    user: {
      count: async () => userCount,
    },
    // WARP-804 — the `claimCode` slice `isClaimed` reads: count of `consumed`
    // rows. Mirrors `prisma.claimCode.count({ where: { state: "consumed" } })`.
    claimCode: {
      count: async ({ where }: { where?: { state?: string } } = {}) =>
        where?.state === "consumed" ? consumedClaims : 0,
    },
    applianceSetup: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        row && row.id === where.id ? { ...row } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (row && row.id === where.id) {
          row = { ...row, ...update, updatedAt: new Date() };
        } else {
          row = {
            state: "unclaimed",
            setupStep: "welcome",
            userTourCompleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
        }
        return { ...row };
      },
    },
  };
  return db;
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", createSetupRouter(prisma as never));
  return app;
}

describe("GET /api/setup/state", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("returns the unclaimed/welcome default on a fresh appliance", async () => {
    const res = await request(buildApp(prisma)).get("/api/setup/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      appliance: "unclaimed",
      setup_step: "welcome",
      user_tour_completed: false,
    });
  });

  it("reflects a persisted mid-wizard step (resumable)", async () => {
    prisma._seed({
      id: "singleton",
      state: "unclaimed",
      setupStep: "storage",
      userTourCompleted: false,
    });
    const res = await request(buildApp(prisma)).get("/api/setup/state");
    expect(res.status).toBe(200);
    expect(res.body.setup_step).toBe("storage");
    expect(res.body.appliance).toBe("unclaimed");
  });

  it("reports a ready appliance with the tour pending", async () => {
    prisma._seed({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: false,
    });
    const res = await request(buildApp(prisma)).get("/api/setup/state");
    expect(res.body).toEqual({
      appliance: "ready",
      setup_step: "done",
      user_tour_completed: false,
    });
  });
});

describe("PATCH /api/setup/state", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("persists the setup_step so a later GET resumes there", async () => {
    const app = buildApp(prisma);
    const patch = await request(app)
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ setup_step: "cameras" });
    expect(patch.status).toBe(200);
    expect(patch.body.setup_step).toBe("cameras");

    const get = await request(app).get("/api/setup/state");
    expect(get.body.setup_step).toBe("cameras");
  });

  it("persists accounts across refresh and ignores a delayed earlier wizard write", async () => {
    const app = buildApp(prisma);
    const accounts = await request(app).patch("/api/setup/state").set("Cookie", "droplet_session=valid-session").send({ setup_step: "accounts" });
    expect(accounts.status).toBe(200);
    expect(accounts.body.setup_step).toBe("accounts");
    expect((await request(app).get("/api/setup/state")).body.setup_step).toBe("accounts");
    await request(app).patch("/api/setup/state").set("Cookie", "droplet_session=valid-session").send({ setup_step: "team" });
    const stale = await request(app).patch("/api/setup/state").set("Cookie", "droplet_session=valid-session").send({ setup_step: "accounts" });
    expect(stale.status).toBe(200);
    expect(stale.body.setup_step).toBe("team");
    expect((await request(app).get("/api/setup/state")).body.setup_step).toBe("team");
  });

  it("an owner replay cannot move a completed appliance away from done", async () => {
    prisma._seed({ id: "singleton", state: "ready", setupStep: "done", userTourCompleted: false });
    const res = await request(buildApp(prisma)).patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session").send({ setup_step: "accounts" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ appliance: "ready", setup_step: "done" });
  });

  it("flips the appliance to ready via an explicit field", async () => {
    const app = buildApp(prisma);
    const res = await request(app)
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ appliance: "ready" });
    expect(res.status).toBe(200);
    expect(res.body.appliance).toBe("ready");
  });

  it("persists ready through the route → a later GET still reports ready (finish → persist → refresh)", async () => {
    // The wizard-finish seam the reviewer flagged: PATCH appliance:ready must
    // DURABLY flip the explicit state column, so a subsequent GET (hard
    // refresh) reads ready and the dashboard does not re-trap the owner in
    // the wizard. Drives the real markApplianceReady, not a seeded row.
    const app = buildApp(prisma);
    const patch = await request(app)
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ appliance: "ready" });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({
      appliance: "ready",
      setup_step: "done",
      user_tour_completed: false,
    });

    const get = await request(app).get("/api/setup/state");
    expect(get.body.appliance).toBe("ready");
    expect(get.body.setup_step).toBe("done");
  });

  it("is idempotent — finishing twice (re-PATCH on a ready appliance) is a 200 no-op, not an error", async () => {
    // Refreshing on /done, or DoneStep mounting again, re-fires the finish
    // PATCH. markApplianceReady on an already-ready appliance must be a
    // harmless no-op so the owner never sees an error on the last screen.
    const app = buildApp(prisma);
    const first = await request(app)
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ appliance: "ready" });
    expect(first.status).toBe(200);
    expect(first.body.appliance).toBe("ready");

    // The re-fire rides the owner's session cookie (the wizard signed them in
    // at the account step); on a set-up box an anonymous PATCH is refused
    // (WARP-3193 SEC-AUTH-5 — see the write-gate suite below).
    const second = await request(app)
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ appliance: "ready" });
    expect(second.status).toBe(200);
    expect(second.body.appliance).toBe("ready");
    expect(second.body.setup_step).toBe("done");
  });

  it("marks the tour completed", async () => {
    const app = buildApp(prisma);
    const res = await request(app)
      .patch("/api/setup/state")
      .send({ user_tour_completed: true });
    expect(res.status).toBe(200);
    expect(res.body.user_tour_completed).toBe(true);
  });

  it("rejects an unknown step with 400 (not a silent coerce)", async () => {
    const app = buildApp(prisma);
    // A value that is not a member of the SetupStep enum must 400, not be
    // silently coerced. (`team` is now a shipped step as of this PR, so use a
    // genuinely-unknown sentinel for the negative assertion.)
    const res = await request(app)
      .patch("/api/setup/state")
      .send({ setup_step: "nonsense" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SETUP_STEP");
  });

  it("rejects an unknown appliance state with 400", async () => {
    const app = buildApp(prisma);
    const res = await request(app)
      .patch("/api/setup/state")
      .send({ appliance: "claimed" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty patch with 400", async () => {
    const app = buildApp(prisma);
    const res = await request(app).patch("/api/setup/state").send({});
    expect(res.status).toBe(400);
  });
});

// ── M1 — the lifecycle-mutating `appliance:"ready"` claim is gated ──
describe("PATCH /api/setup/state — claim (appliance:ready) auth gate", () => {
  it("rejects an UNAUTHENTICATED ready transition on a pre-claim box (no admin) with 403", async () => {
    // The takeover vector: a LAN caller with no session, before any admin
    // account exists, must NOT be able to flip the box ready.
    const prisma = createPrismaMock({ userCount: 0 });
    const res = await request(buildApp(prisma))
      .patch("/api/setup/state")
      .send({ appliance: "ready" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_CLAIM_FORBIDDEN");
  });

  it("does NOT write the appliance when the claim is rejected", async () => {
    const prisma = createPrismaMock({ userCount: 0 });
    const app = buildApp(prisma);
    await request(app).patch("/api/setup/state").send({ appliance: "ready" });
    // The box stays unclaimed — the rejection happened before any write.
    const get = await request(app).get("/api/setup/state");
    expect(get.body.appliance).toBe("unclaimed");
  });

  it("ALLOWS the ready transition when a valid session cookie is presented (pre-admin)", async () => {
    // The wizard authenticates at the account step, so the finish PATCH
    // rides the dashboard session cookie even in the narrow window before
    // user.count() reflects the new admin.
    const prisma = createPrismaMock({ userCount: 0 });
    const res = await request(buildApp(prisma))
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ appliance: "ready" });
    expect(res.status).toBe(200);
    expect(res.body.appliance).toBe("ready");
  });

  it("rejects anonymous completion even after the owner account exists", async () => {
    const prisma = createPrismaMock({ userCount: 1 });
    const res = await request(buildApp(prisma))
      .patch("/api/setup/state")
      .send({ appliance: "ready" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_CLAIM_FORBIDDEN");
    expect((await request(buildApp(prisma)).get("/api/setup/state")).body.appliance).toBe("unclaimed");
  });

  it.each(["guest-session", "admin-session"])("refuses first-run completion by a non-owner %s", async (cookie) => {
    const prisma = createPrismaMock({ userCount: 1 });
    const app = buildApp(prisma);
    const res = await request(app).patch("/api/setup/state")
      .set("Cookie", `droplet_session=${cookie}`).send({ appliance: "ready", setup_step: "done" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_FORBIDDEN");
    expect((await request(app).get("/api/setup/state")).body).toMatchObject({ appliance: "unclaimed", setup_step: "welcome" });
  });

  it.each(["revoked-owner-session", "denied-owner-session"])("refuses first-run completion by %s", async (cookie) => {
    const prisma = createPrismaMock({ userCount: 1 });
    const app = buildApp(prisma);
    const res = await request(app).patch("/api/setup/state")
      .set("Cookie", `droplet_session=${cookie}`).send({ appliance: "ready" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_EXPIRED");
    expect((await request(app).get("/api/setup/state")).body.appliance).toBe("unclaimed");
  });

  it("rejects an invalid session cookie on a pre-claim box with 403", async () => {
    const prisma = createPrismaMock({ userCount: 0 });
    const res = await request(buildApp(prisma))
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=garbage")
      .send({ appliance: "ready" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_CLAIM_FORBIDDEN");
  });

  it("still allows PUBLIC account resumability with no auth", async () => {
    // Resumability must not regress: an unauthenticated pre-claim wizard
    // can still persist its step.
    const prisma = createPrismaMock({ userCount: 0 });
    const res = await request(buildApp(prisma))
      .patch("/api/setup/state")
      .send({ setup_step: "account" });
    expect(res.status).toBe(200);
    expect(res.body.setup_step).toBe("account");
  });

  it.each(["org", "internet", "accounts", "done"])("refuses anonymous pre-owner progress to %s before applying a mixed patch", async (setup_step) => {
    const prisma = createPrismaMock({ userCount: 0 });
    const app = buildApp(prisma);
    const res = await request(app).patch("/api/setup/state").send({ setup_step, user_tour_completed: true });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SETUP_AUTH_REQUIRED");
    expect((await request(app).get("/api/setup/state")).body).toEqual({ appliance: "unclaimed", setup_step: "welcome", user_tour_completed: false });
  });

  it.each(["guest-session", "admin-session", "revoked-owner-session", "denied-owner-session"])("refuses protected first-run progress by %s", async (cookie) => {
    const app = buildApp(createPrismaMock());
    const res = await request(app).patch("/api/setup/state").set("Cookie", `droplet_session=${cookie}`).send({ setup_step: "accounts" });
    expect(res.status).toBe(cookie.startsWith("revoked") || cookie.startsWith("denied") ? 401 : 403);
    expect((await request(app).get("/api/setup/state")).body.setup_step).toBe("welcome");
  });
});

// ── M5 — the public GET must be side-effect-free ──
// WARP-3193 SEC-AUTH-5 — once the box is set up, PATCH is no longer an
// anonymous resumability hint: every write needs a live, non-revoked session.
// `setup_step` / `appliance` are owner-only; `user_tour_completed` is open to
// any signed-in member, because AuthGate shows the tour to WHOEVER signs in
// first while it is pending — owner-only would re-trap everyone else in it.
describe("PATCH /api/setup/state — set-up (ready) box write gate (WARP-3193 SEC-AUTH-5)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
    prisma._seed({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  function patch(body: Record<string, unknown>, cookie?: string) {
    const r = request(buildApp(prisma)).patch("/api/setup/state");
    return (cookie ? r.set("Cookie", `droplet_session=${cookie}`) : r).send(body);
  }

  it.each([
    [{ setup_step: "cameras" }],
    [{ appliance: "ready" }],
    [{ user_tour_completed: true }],
  ])("refuses an anonymous %j with 401 SETUP_AUTH_REQUIRED", async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SETUP_AUTH_REQUIRED");
  });

  it("refuses a guest moving the wizard step (403 SETUP_FORBIDDEN, no write)", async () => {
    const res = await patch({ setup_step: "cameras" }, "guest-session");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_FORBIDDEN");
    const get = await request(buildApp(prisma)).get("/api/setup/state");
    expect(get.body.setup_step).toBe("done");
  });

  it.each([["revoked-owner-session"], ["denied-owner-session"]])(
    "refuses %s with 401 SESSION_EXPIRED",
    async (cookie) => {
      const res = await patch({ setup_step: "cameras" }, cookie);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("SESSION_EXPIRED");
    },
  );

  it("accepts the owner's stale step without regressing a ready appliance", async () => {
    const res = await patch({ setup_step: "cameras" }, "valid-session");
    expect(res.status).toBe(200);
    expect(res.body.setup_step).toBe("done");
  });

  it("lets ANY signed-in member complete the tour (a guest included)", async () => {
    const res = await patch({ user_tour_completed: true }, "guest-session");
    expect(res.status).toBe(200);
    expect(res.body.user_tour_completed).toBe(true);
  });

  it("a mixed body is gated by its most privileged field", async () => {
    const res = await patch({ user_tour_completed: true, setup_step: "cameras" }, "guest-session");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/setup/state — read is side-effect-free (M5)", () => {
  it("does not upsert/create a row on read (findUnique only)", async () => {
    const prisma = createPrismaMock({ userCount: 0 });
    // Tripwire: any write through the singleton is a test failure.
    const upsertSpy = vi.spyOn(prisma.applianceSetup, "upsert");
    const res = await request(buildApp(prisma)).get("/api/setup/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      appliance: "unclaimed",
      setup_step: "welcome",
      user_tour_completed: false,
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

// ── WARP-804 — a persisted `claim` step on an ALREADY-CLAIMED box is an
// unsatisfiable dead-end: the consumed code's plaintext is gone, so the
// re-presented claim step can never be satisfied (→ CLAIM_CODE_INVALID → 429
// lockout) and AuthGate keeps the dashboard gated. `GET /api/setup/state` must
// report the post-claim step (NOT `claim`) once the box is claimed, and a PATCH
// back to `claim` on a claimed box must not re-park it there. The post-claim
// step is `account` (STEP_AFTER_CLAIM). ──
describe("WARP-804 — claim step is satisfied once the box is claimed", () => {
  it("GET reports the post-claim step (account), not `claim`, when a consumed code exists", async () => {
    const prisma = createPrismaMock({ consumedClaims: 1 });
    // The dead-end the bug parks the box on: setupStep=claim while claimed.
    prisma._seed({
      id: "singleton",
      state: "unclaimed",
      setupStep: "claim",
      userTourCompleted: false,
    });
    const res = await request(buildApp(prisma)).get("/api/setup/state");
    expect(res.status).toBe(200);
    expect(res.body.setup_step).toBe("account");
    expect(res.body.setup_step).not.toBe("claim");
  });

  it("GET stays side-effect-free while healing the claimed claim step (M5)", async () => {
    const prisma = createPrismaMock({ consumedClaims: 1 });
    prisma._seed({
      id: "singleton",
      state: "unclaimed",
      setupStep: "claim",
      userTourCompleted: false,
    });
    const upsertSpy = vi.spyOn(prisma.applianceSetup, "upsert");
    const res = await request(buildApp(prisma)).get("/api/setup/state");
    expect(res.body.setup_step).toBe("account");
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("PATCH setup_step:claim on a claimed box does NOT persist `claim` — it advances to account", async () => {
    const prisma = createPrismaMock({ consumedClaims: 1 });
    const app = buildApp(prisma);
    const patch = await request(app)
      .patch("/api/setup/state")
      .send({ setup_step: "claim" });
    expect(patch.status).toBe(200);
    expect(patch.body.setup_step).toBe("account");

    // A subsequent GET (hard refresh) must NOT re-trap the owner on `claim`.
    const get = await request(app).get("/api/setup/state");
    expect(get.body.setup_step).toBe("account");
  });

  it("REGRESSION: on an UNCLAIMED box the claim step is preserved end-to-end", async () => {
    const prisma = createPrismaMock({ consumedClaims: 0 });
    const app = buildApp(prisma);
    const patch = await request(app)
      .patch("/api/setup/state")
      .send({ setup_step: "claim" });
    expect(patch.status).toBe(200);
    expect(patch.body.setup_step).toBe("claim");

    const get = await request(app).get("/api/setup/state");
    expect(get.body.setup_step).toBe("claim");
  });
});

// ──────────────────────────────────────────────────────────────────
// WARP-1041 — PATCH /setup/state as the wizard's model pre-warm
// trigger. Persisting a step in the back half of the wizard (storage
// onward) means the customer is minutes away from the AI step, which
// is exactly the lead time the 30-90 s GPU model load needs. The warm
// fn is injected (like persistBoxNameToHost) so these tests spy on it
// without touching Ollama; the real default is
// model-readiness.service.warmDefaultModel, which owns the debounce.
// ──────────────────────────────────────────────────────────────────
describe("PATCH /api/setup/state — model pre-warm trigger (WARP-1041)", () => {
  function buildAppWithWarm(
    prisma: ReturnType<typeof createPrismaMock>,
    warm: () => Promise<void>,
  ) {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(
      "/api",
      createSetupRouter(prisma as never, { warmDefaultModel: warm }),
    );
    return app;
  }

  /** The trigger fires on setImmediate AFTER the response — flush one tick. */
  const flushWarmTick = () => new Promise((r) => setImmediate(r));

  it.each(["storage", "discovery", "cameras", "vpn", "ai"])(
    "fires the warm exactly once when setup_step advances to %s",
    async (step) => {
      const warm = vi.fn(async () => undefined);
      const app = buildAppWithWarm(createPrismaMock(), warm);

      const res = await request(app)
        .patch("/api/setup/state")
        .set("Cookie", "droplet_session=valid-session")
        .send({ setup_step: step });
      await flushWarmTick();

      expect(res.status).toBe(200);
      expect(res.body.setup_step).toBe(step);
      expect(warm).toHaveBeenCalledTimes(1);
    },
  );

  it("defaults to warming the box's ACTIVE model, resolved against this box's settings (WARP-3047)", async () => {
    warmActiveModel.mockClear();
    const prisma = createPrismaMock();
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use("/api", createSetupRouter(prisma as never));

    const res = await request(app).patch("/api/setup/state").set("Cookie", "droplet_session=valid-session").send({ setup_step: "storage" });
    await flushWarmTick();

    expect(res.status).toBe(200);
    expect(warmActiveModel).toHaveBeenCalledTimes(1);
    expect(warmActiveModel).toHaveBeenCalledWith(prisma);
  });

  it.each(["welcome", "claim", "account", "org", "internet"])(
    "does NOT fire the warm on the early step %s",
    async (step) => {
      const warm = vi.fn(async () => undefined);
      const app = buildAppWithWarm(createPrismaMock(), warm);

      const res = await request(app)
        .patch("/api/setup/state")
        .set("Cookie", "droplet_session=valid-session")
        .send({ setup_step: step });
      await flushWarmTick();

      expect(res.status).toBe(200);
      expect(warm).not.toHaveBeenCalled();
    },
  );

  it("does not fire the warm on an invalid step (400 path)", async () => {
    const warm = vi.fn(async () => undefined);
    const app = buildAppWithWarm(createPrismaMock(), warm);

    const res = await request(app)
      .patch("/api/setup/state")
      .send({ setup_step: "nonsense" });
    await flushWarmTick();

    expect(res.status).toBe(400);
    expect(warm).not.toHaveBeenCalled();
  });

  it("does not fire the warm on a tour-only patch", async () => {
    const warm = vi.fn(async () => undefined);
    const app = buildAppWithWarm(createPrismaMock(), warm);

    const res = await request(app)
      .patch("/api/setup/state")
      .send({ user_tour_completed: true });
    await flushWarmTick();

    expect(res.status).toBe(200);
    expect(warm).not.toHaveBeenCalled();
  });

  it("responds without awaiting the warm (a hung Ollama can never stall the wizard)", async () => {
    // A warm that NEVER settles: if the handler awaited it, this request
    // would time out instead of returning 200.
    const warm = vi.fn(() => new Promise<void>(() => undefined));
    const app = buildAppWithWarm(createPrismaMock(), warm);

    const res = await request(app)
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ setup_step: "storage" });
    await flushWarmTick();

    expect(res.status).toBe(200);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejecting warm without failing the request", async () => {
    const warm = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const app = buildAppWithWarm(createPrismaMock(), warm);

    const res = await request(app)
      .patch("/api/setup/state")
      .set("Cookie", "droplet_session=valid-session")
      .send({ setup_step: "vpn" });
    await flushWarmTick();

    expect(res.status).toBe(200);
    expect(warm).toHaveBeenCalledTimes(1);
  });
});
