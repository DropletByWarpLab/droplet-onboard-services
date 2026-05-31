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

vi.unmock("@prisma/client");

import { createSetupRouter } from "./setup.js";

// ── In-memory applianceSetup singleton store ──
function createPrismaMock() {
  let row: Record<string, unknown> | null = null;
  return {
    _seed: (r: Record<string, unknown> | null) => {
      row = r;
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
