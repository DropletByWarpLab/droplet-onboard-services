/**
 * Route tests for the PR #380 onboarding ORG endpoint.
 *
 *   POST /api/setup/org { name, slug, tz, industry?, size?, logo? }
 *     → 200 { ok, slug, reserved_host, next_step }  — workspace persisted,
 *       droplet.local/<slug> reserved, wizard advanced to `internet`.
 *     → 400 { code: "ORG_SLUG_INVALID" }            — malformed slug.
 *     → 409 { code: "ORG_SLUG_TAKEN" }              — slug already reserved.
 *     → 400 { code: "ORG_FIELDS_REQUIRED" }         — missing name/slug/tz.
 *
 * Org slots AFTER account in the resumable wizard, so a successful persist
 * advances `setupStep` to `internet`. Strategy mirrors setup.test.ts: a minimal
 * Express app + supertest, with in-memory `workspace` + `applianceSetup`
 * Prisma stand-ins.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.unmock("@prisma/client");

// WARP-3193 SEC-AUTH-5 — besides the owner cookie, tokens that are validly
// SIGNED but must not edit a set-up workspace: a lower role, a session whose
// server-side record is gone (revoked), and a hard-revoked (denylisted) user.
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (token: string) => {
    const base = { username: "x", displayName: "X" };
    switch (token) {
      case "valid-session":
        return { sub: "u1", username: "owner", displayName: "Owner", role: "owner" };
      case "admin-session":
        return { ...base, sub: "u-admin", role: "admin", sid: "sid-live" };
      case "guest-session":
        return { ...base, sub: "u-guest", role: "guest", sid: "sid-live" };
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

import { createSetupRouter } from "./setup.js";

// ── In-memory store: workspace singleton (id = 1) + applianceSetup singleton ──
function createPrismaMock() {
  let workspace: Record<string, unknown> | null = null;
  let setup: Record<string, unknown> | null = null;
  const db = {
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(db),
    user: { count: async () => 1 },
    _seedWorkspace: (w: Record<string, unknown> | null) => {
      workspace = w;
    },
    _seedSetup: (s: Record<string, unknown> | null) => {
      setup = s;
    },
    _workspace: () => workspace,
    _setupStep: () => setup?.setupStep ?? null,
    workspace: {
      findUnique: async ({ where }: { where: { id: number } }) =>
        workspace && workspace.id === where.id ? { ...workspace } : null,
      findFirst: async ({ where }: { where: { slug?: string } }) =>
        workspace && where.slug !== undefined && workspace.slug === where.slug
          ? { ...workspace }
          : null,
      upsert: async ({
        create,
        update,
      }: {
        where: { id: number };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        workspace = workspace
          ? { ...workspace, ...update }
          : { id: 1, ...create };
        return { ...workspace };
      },
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
  return db;
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", createSetupRouter(prisma as never));
  return app;
}

const VALID_BODY = {
  name: "Acme HQ",
  slug: "acme",
  tz: "America/New_York",
  industry: "logistics",
  size: "11-50",
};

describe("POST /api/setup/org (PR #380)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("persists the workspace, reserves the host, and advances to `internet`", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .set("Cookie", "droplet_session=valid-session")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.slug).toBe("acme");
    expect(res.body.reserved_host).toBe("droplet.local/acme");
    // Org slots after account → next step is internet.
    expect(res.body.next_step).toBe("internet");

    // The workspace row carries the org fields + the explicit completion flag.
    const ws = prisma._workspace()!;
    expect(ws.displayName).toBe("Acme HQ");
    expect(ws.slug).toBe("acme");
    expect(ws.orgConfigured).toBe(true);
    // The resumable wizard advanced.
    expect(prisma._setupStep()).toBe("internet");
  });

  it("replaying the organization save does not move accounts back to internet", async () => {
    prisma._seedSetup({ id: "singleton", state: "unclaimed", setupStep: "accounts", userTourCompleted: false });
    const res = await request(buildApp(prisma)).post("/api/setup/org")
      .set("Cookie", "droplet_session=valid-session").send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(prisma._setupStep()).toBe("accounts");
  });

  it("normalizes the slug (trim + lowercase) before reserving", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .set("Cookie", "droplet_session=valid-session")
      .send({ ...VALID_BODY, slug: "  ACME-HQ  " });
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("acme-hq");
    expect(res.body.reserved_host).toBe("droplet.local/acme-hq");
  });

  it("400s a malformed slug with the inline ORG_SLUG_INVALID code (no write)", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .set("Cookie", "droplet_session=valid-session")
      .send({ ...VALID_BODY, slug: "Acme HQ!" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ORG_SLUG_INVALID");
    // No partial write.
    expect(prisma._workspace()).toBeNull();
    // The wizard step did NOT advance.
    expect(prisma._setupStep()).toBeNull();
  });

  it("409s when the slug is already reserved by another workspace", async () => {
    prisma._seedWorkspace({
      id: 2,
      slug: "acme",
      displayName: "Other",
      orgConfigured: true,
    });
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .set("Cookie", "droplet_session=valid-session")
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ORG_SLUG_TAKEN");
  });

  it("400s when required fields are missing", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .set("Cookie", "droplet_session=valid-session")
      .send({ slug: "acme" }); // no name, no tz
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ORG_FIELDS_REQUIRED");
    expect(prisma._workspace()).toBeNull();
  });

  it("accepts a body without industry/size (LOCAL hints are optional)", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .set("Cookie", "droplet_session=valid-session")
      .send({ name: "Solo", slug: "solo", tz: "Europe/Berlin" });
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("solo");
    const ws = prisma._workspace()!;
    expect(ws.industry ?? null).toBeNull();
    expect(ws.size ?? null).toBeNull();
  });

  // ── ORCH-04: auth gate on a claimed appliance ──────────────────────────
  describe("ORCH-04 — auth gate once the appliance is claimed", () => {
    it("rejects an unauthenticated POST once the appliance is `ready` (401, no write)", async () => {
      // Appliance already claimed/set up + a workspace already persisted.
      prisma._seedSetup({
        id: "singleton",
        state: "ready",
        setupStep: "done",
        userTourCompleted: true,
      });
      prisma._seedWorkspace({
        id: 1,
        slug: "acme",
        displayName: "Acme HQ",
        orgConfigured: true,
      });

      const res = await request(buildApp(prisma))
        .post("/api/setup/org")
        .send({ ...VALID_BODY, name: "Evil Rename", slug: "evil" });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("ORG_AUTH_REQUIRED");
      // The live workspace singleton was NOT overwritten.
      const ws = prisma._workspace()!;
      expect(ws.displayName).toBe("Acme HQ");
      expect(ws.slug).toBe("acme");
    });

    it("allows an AUTHENTICATED owner to edit the workspace on a claimed appliance", async () => {
      prisma._seedSetup({
        id: "singleton",
        state: "ready",
        setupStep: "done",
        userTourCompleted: true,
      });
      prisma._seedWorkspace({
        id: 1,
        slug: "acme",
        displayName: "Acme HQ",
        orgConfigured: true,
      });

      const res = await request(buildApp(prisma))
        .post("/api/setup/org")
        .set("Cookie", "droplet_session=valid-session")
        .send({ ...VALID_BODY, name: "Acme Renamed", slug: "acme-2" });

      expect(prisma._setupStep()).toBe("done");

      expect(res.status).toBe(200);
      expect(res.body.slug).toBe("acme-2");
      expect(prisma._workspace()!.displayName).toBe("Acme Renamed");
    });

    // WARP-3193 SEC-AUTH-5 — a signature alone is not enough once the box is
    // set up: owner only, live session record, not hard-revoked (the same
    // bar authMiddleware + settings/workspace apply).
    it.each([
      ["an admin", "admin-session", 403, "ORG_FORBIDDEN"],
      ["a guest", "guest-session", 403, "ORG_FORBIDDEN"],
      ["a revoked owner session", "revoked-owner-session", 401, "SESSION_EXPIRED"],
      ["a denylisted (deleted) owner", "denied-owner-session", 401, "SESSION_EXPIRED"],
    ])("refuses %s on a claimed appliance (no write)", async (_label, cookie, status, code) => {
      prisma._seedSetup({
        id: "singleton",
        state: "ready",
        setupStep: "done",
        userTourCompleted: true,
      });
      prisma._seedWorkspace({ id: 1, slug: "acme", displayName: "Acme HQ", orgConfigured: true });

      const res = await request(buildApp(prisma))
        .post("/api/setup/org")
        .set("Cookie", `droplet_session=${cookie}`)
        .send({ ...VALID_BODY, name: "Evil Rename", slug: "evil" });

      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(prisma._workspace()!.displayName).toBe("Acme HQ");
      expect(prisma._workspace()!.slug).toBe("acme");
    });

    it("refuses anonymous organization setup before the appliance is ready", async () => {
      // No setup row seeded → appliance defaults to "unclaimed" (first run).
      const res = await request(buildApp(prisma))
        .post("/api/setup/org")
        .send(VALID_BODY);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("ORG_AUTH_REQUIRED");
      expect(prisma._workspace()).toBeNull();
      expect(prisma._setupStep()).toBeNull();
    });
  });
});
