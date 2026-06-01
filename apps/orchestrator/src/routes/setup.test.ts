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
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (token: string) =>
    token === "valid-session"
      ? { sub: "u1", username: "owner", displayName: "Owner", role: "owner" }
      : null,
}));

import { createSetupRouter } from "./setup.js";

// ── In-memory applianceSetup singleton store ──
//
// `userCount` models whether an admin account exists (the M2 precondition
// for the `ready` transition). Defaults to 1 (admin present) so the
// pre-existing happy-path cases keep exercising the claim; the M1/M2 cases
// seed 0 explicitly to drive the pre-claim rejection.
function createPrismaMock(opts: { userCount?: number } = {}) {
  let row: Record<string, unknown> | null = null;
  let userCount = opts.userCount ?? 1;
  return {
    _seed: (r: Record<string, unknown> | null) => {
      row = r;
    },
    _setUserCount: (n: number) => {
      userCount = n;
    },
    user: {
      count: async () => userCount,
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
      .send({ setup_step: "cameras" });
    expect(patch.status).toBe(200);
    expect(patch.body.setup_step).toBe("cameras");

    const get = await request(app).get("/api/setup/state");
    expect(get.body.setup_step).toBe("cameras");
  });

  it("flips the appliance to ready via an explicit field", async () => {
    const app = buildApp(prisma);
    const res = await request(app)
      .patch("/api/setup/state")
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
      .send({ appliance: "ready" });
    expect(first.status).toBe(200);
    expect(first.body.appliance).toBe("ready");

    const second = await request(app)
      .patch("/api/setup/state")
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
    const res = await request(app)
      .patch("/api/setup/state")
      .send({ setup_step: "claim" });
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

  it("ALLOWS the ready transition (no cookie) once an admin account exists", async () => {
    // Backstop path (b): an admin row exists ⇒ the box is genuinely
    // claimable; the finish PATCH succeeds without re-presenting a cookie.
    const prisma = createPrismaMock({ userCount: 1 });
    const res = await request(buildApp(prisma))
      .patch("/api/setup/state")
      .send({ appliance: "ready" });
    expect(res.status).toBe(200);
    expect(res.body.appliance).toBe("ready");
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

  it("still allows PUBLIC resumability writes (setup_step) with no auth", async () => {
    // Resumability must not regress: an unauthenticated pre-claim wizard
    // can still persist its step.
    const prisma = createPrismaMock({ userCount: 0 });
    const res = await request(buildApp(prisma))
      .patch("/api/setup/state")
      .send({ setup_step: "storage" });
    expect(res.status).toBe(200);
    expect(res.body.setup_step).toBe("storage");
  });
});

// ── M5 — the public GET must be side-effect-free ──
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
