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

vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (token: string) =>
    token === "valid-session"
      ? { sub: "u1", username: "owner", displayName: "Owner", role: "owner" }
      : null,
}));

import { createSetupRouter } from "./setup.js";

// ── In-memory store: workspace singleton (id = 1) + applianceSetup singleton ──
function createPrismaMock() {
  let workspace: Record<string, unknown> | null = null;
  let setup: Record<string, unknown> | null = null;
  return {
    _seedWorkspace: (w: Record<string, unknown> | null) => {
      workspace = w;
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

  it("normalizes the slug (trim + lowercase) before reserving", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .send({ ...VALID_BODY, slug: "  ACME-HQ  " });
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("acme-hq");
    expect(res.body.reserved_host).toBe("droplet.local/acme-hq");
  });

  it("400s a malformed slug with the inline ORG_SLUG_INVALID code (no write)", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
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
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ORG_SLUG_TAKEN");
  });

  it("400s when required fields are missing", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .send({ slug: "acme" }); // no name, no tz
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ORG_FIELDS_REQUIRED");
    expect(prisma._workspace()).toBeNull();
  });

  it("accepts a body without industry/size (LOCAL hints are optional)", async () => {
    const res = await request(buildApp(prisma))
      .post("/api/setup/org")
      .send({ name: "Solo", slug: "solo", tz: "Europe/Berlin" });
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("solo");
    const ws = prisma._workspace()!;
    expect(ws.industry ?? null).toBeNull();
    expect(ws.size ?? null).toBeNull();
  });
});
