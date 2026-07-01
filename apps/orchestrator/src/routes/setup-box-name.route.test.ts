/**
 * WARP-979 — route tests for the onboarding "Secured / name your box" endpoints.
 *
 *   GET  /api/setup/box-name/check?name=<n>
 *     → 200 { available, slug, fqdn, authoritative, reason?, message? }
 *   POST /api/setup/box-name { name }
 *     → 200 { ok, slug, fqdn }                    — name validated + persisted.
 *     → 400 { code: "BOX_NAME_INVALID", reason }  — malformed / reserved name.
 *     → 400 { code: "BOX_NAME_REQUIRED" }         — missing name.
 *     → 401 { code: "BOX_NAME_AUTH_REQUIRED" }    — unauth POST on a claimed box.
 *
 * Strategy mirrors setup-org.route.test.ts: a minimal Express app + supertest
 * with an in-memory `applianceSetup` Prisma stand-in and a FAKE host persister
 * injected into createSetupRouter (so no device-bridge is touched).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.unmock("@prisma/client");

vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (token: string) =>
    token === "valid-session"
      ? { sub: "u1", username: "owner", displayName: "Owner", role: "owner" }
      : null,
}));

import { createSetupRouter } from "./setup.js";

// ── In-memory store: applianceSetup singleton (drives the auth gate) ──
function createPrismaMock() {
  let setup: Record<string, unknown> | null = null;
  return {
    _seedSetup: (s: Record<string, unknown> | null) => {
      setup = s;
    },
    applianceSetup: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        setup && setup.id === where.id ? { ...setup } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (setup && setup.id === where.id) {
          setup = { ...setup, ...update };
        } else {
          setup = {
            state: "unclaimed",
            setupStep: "welcome",
            userTourCompleted: false,
            ...create,
          };
        }
        return { ...setup };
      },
    },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const persisted: string[] = [];
  const persistBoxNameToHost = vi.fn(async (name: string) => {
    persisted.push(name);
  });
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", createSetupRouter(prisma as never, { persistBoxNameToHost }));
  return { app, persisted, persistBoxNameToHost };
}

describe("GET /api/setup/box-name/check (WARP-979)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("reports a well-formed name as available with the droplet-us.com fqdn", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=studio");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.slug).toBe("studio");
    expect(res.body.fqdn).toBe("studio.droplet-us.com");
    // MVP: format-valid availability is not authoritative (HQ registry check is
    // a coupled fleet-hq follow-up).
    expect(res.body.authoritative).toBe(false);
    expect(res.body.reason).toBeUndefined();
  });

  it("normalizes (trim + lowercase) before answering", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=%20%20MyBox%20%20");
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("mybox");
    expect(res.body.available).toBe(true);
  });

  it("rejects a too-short name with a reason", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=ab");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("too_short");
    expect(typeof res.body.message).toBe("string");
  });

  it("rejects a reserved name", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=admin");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("reserved");
  });

  it("rejects a d-<16hex> device lookalike", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get(
      "/api/setup/box-name/check?name=d-0123456789abcdef",
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("lookalike");
  });

  it("rejects bad characters (spaces / uppercase) as a charset failure", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=my%20box");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("charset");
  });

  it("rejects a leading/trailing hyphen", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=-studio");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("hyphen");
  });

  it("treats a missing name param as invalid (empty)", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("empty");
  });
});

describe("POST /api/setup/box-name (WARP-979)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("validates + persists a valid name (200) and writes DROPLET_BOX_NAME", async () => {
    const { app, persisted, persistBoxNameToHost } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "Studio" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.slug).toBe("studio");
    expect(res.body.fqdn).toBe("studio.droplet-us.com");
    // The chosen name was persisted (host .env write-back), normalized.
    expect(persistBoxNameToHost).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual(["studio"]);
  });

  it("400s a reserved name with BOX_NAME_INVALID (no persist)", async () => {
    const { app, persistBoxNameToHost } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "vpn" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_INVALID");
    expect(res.body.reason).toBe("reserved");
    expect(persistBoxNameToHost).not.toHaveBeenCalled();
  });

  it("400s a malformed name with BOX_NAME_INVALID (no persist)", async () => {
    const { app, persistBoxNameToHost } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "My Box!" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_INVALID");
    expect(persistBoxNameToHost).not.toHaveBeenCalled();
  });

  it("400s a missing name with BOX_NAME_REQUIRED", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).post("/api/setup/box-name").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_REQUIRED");
  });

  it("allows first-run (unclaimed) POST WITHOUT a session", async () => {
    // No setup row → appliance defaults to unclaimed (first run).
    const { app, persisted } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "studio" });
    expect(res.status).toBe(200);
    expect(persisted).toEqual(["studio"]);
  });

  it("rejects an unauthenticated POST once the appliance is `ready` (401, no persist)", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
    });
    const { app, persistBoxNameToHost } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "evil" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("BOX_NAME_AUTH_REQUIRED");
    expect(persistBoxNameToHost).not.toHaveBeenCalled();
  });

  it("allows an AUTHENTICATED owner to set the name on a claimed appliance", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
    });
    const { app, persisted } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .set("Cookie", "droplet_session=valid-session")
      .send({ name: "renamed" });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("renamed");
    expect(persisted).toEqual(["renamed"]);
  });
});
