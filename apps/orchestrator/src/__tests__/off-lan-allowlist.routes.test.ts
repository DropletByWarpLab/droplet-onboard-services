/**
 * WARP-467 — /api/settings/off-lan + /api/settings/off-lan/:key.
 *
 * Pattern mirrors settings.routes.test.ts (WARP-457) — same supertest
 * harness, same recordActivity hoisted mock, same synthetic auth
 * middleware. Drives the actual `createSettingsRouter` so the off-LAN
 * sub-routes share their RBAC + JSON parser with the broader settings
 * surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createSettingsRouter } from "../routes/settings.js";
import type { AuthUser } from "../middleware/auth.js";

interface MockChannelRow {
  key: string;
  enabled: boolean;
  requiresAdmin: boolean;
  lastChangedBy: string | null;
  lastChangedAt: Date;
  reason: string | null;
}

function seedChannels(): MockChannelRow[] {
  const ts = new Date("2026-05-27T00:00:00Z");
  return [
    { key: "software_updates", enabled: true, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
    { key: "cloud_model_escape", enabled: false, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
    { key: "outbound_email", enabled: true, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
    { key: "telemetry", enabled: true, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
    { key: "web_fetch", enabled: false, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
  ];
}

function createPrismaMock(initial: MockChannelRow[] = seedChannels()) {
  const rows = new Map<string, MockChannelRow>(initial.map((r) => [r.key, r]));
  return {
    rows,
    offLanAllowlistChannel: {
      findMany: vi.fn(
        async ({ orderBy }: { orderBy?: unknown } = {}) => {
          void orderBy;
          return [...rows.values()];
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) =>
          rows.get(where.key) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string };
          data: Partial<MockChannelRow>;
        }) => {
          const existing = rows.get(where.key);
          if (!existing) {
            const err: { code: string; message: string } = {
              code: "P2025",
              message: "not found",
            };
            throw err;
          }
          const merged = { ...existing, ...data };
          rows.set(where.key, merged);
          return merged;
        },
      ),
    },
    // The settings router also touches workspaceSetting at startup-
    // independent codepaths, but no off-LAN test exercises those — the
    // workspaceSetting stubs are intentionally absent so the call
    // fails loudly if the off-LAN handler accidentally hits them.
    workspaceSetting: {},
  };
}

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return {
    id: `user-${role}`,
    username,
    displayName: username,
    role,
  };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  user: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createSettingsRouter(prismaMock as unknown as import("@prisma/client").PrismaClient));
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("WARP-467 — GET /api/settings/off-lan", () => {
  it("returns all five channels with default posture", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/settings/off-lan");
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(5);
    const byKey = Object.fromEntries(
      res.body.channels.map((c: { key: string; enabled: boolean }) => [c.key, c.enabled]),
    );
    expect(byKey.software_updates).toBe(true);
    expect(byKey.cloud_model_escape).toBe(false);
    expect(byKey.outbound_email).toBe(true);
    expect(byKey.telemetry).toBe(true);
    expect(byKey.web_fetch).toBe(false);
  });

  it("rejects a guest with 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("guest"));
    const res = await request(app).get("/api/settings/off-lan");
    expect(res.status).toBe(403);
  });
});

describe("WARP-467 — PATCH /api/settings/off-lan/:key", () => {
  it("admin can flip cloud_model_escape on with a reason; activity emitted", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("admin", "romain"));
    const res = await request(app)
      .patch("/api/settings/off-lan/cloud_model_escape")
      .send({ enabled: true, reason: "Pilot needs GPT-4 for transcript summarization." });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.changed).toBe(true);
    expect(res.body.lastChangedBy).toBe("romain");
    expect(res.body.reason).toContain("Pilot");
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const call = recordActivityMock.mock.calls[0][0];
    expect(call.kind).toBe("system");
    expect(call.severity).toBe("info");
    expect(call.what).toBe("Off-LAN channel enabled");
    expect(call.refs.channel).toBe("cloud_model_escape");
    expect(call.refs.previousEnabled).toBe(false);
    expect(call.refs.nextEnabled).toBe(true);
  });

  it("rejects family role (non-admin write) with 403", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app)
      .patch("/api/settings/off-lan/telemetry")
      .send({ enabled: false, reason: "Privacy review pending." });
    expect(res.status).toBe(403);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a PATCH with missing reason with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/settings/off-lan/telemetry")
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a PATCH with empty-string reason with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/settings/off-lan/telemetry")
      .send({ enabled: false, reason: "   " });
    expect(res.status).toBe(400);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a PATCH with non-boolean enabled with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/settings/off-lan/telemetry")
      .send({ enabled: "off", reason: "explanation" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown channel key with 404", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/settings/off-lan/quantum_teleport")
      .send({ enabled: true, reason: "future-proofing" });
    expect(res.status).toBe(404);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("idempotent no-op: same enabled + same reason returns changed=false and skips activity", async () => {
    // Pre-seed a row with the same reason text we'll PATCH with.
    const ts = new Date("2026-05-27T00:00:00Z");
    const prisma = createPrismaMock([
      {
        key: "software_updates",
        enabled: true,
        requiresAdmin: true,
        lastChangedBy: "stefan",
        lastChangedAt: ts,
        reason: "Default policy.",
      },
      { key: "cloud_model_escape", enabled: false, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
      { key: "outbound_email", enabled: true, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
      { key: "telemetry", enabled: true, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
      { key: "web_fetch", enabled: false, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
    ]);
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/settings/off-lan/software_updates")
      .send({ enabled: true, reason: "Default policy." });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("clarifying the reason is a real change (logged) even when enabled stays the same", async () => {
    const ts = new Date("2026-05-27T00:00:00Z");
    const prisma = createPrismaMock([
      {
        key: "telemetry",
        enabled: true,
        requiresAdmin: true,
        lastChangedBy: null,
        lastChangedAt: ts,
        reason: "Default.",
      },
      { key: "software_updates", enabled: true, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
      { key: "cloud_model_escape", enabled: false, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
      { key: "outbound_email", enabled: true, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
      { key: "web_fetch", enabled: false, requiresAdmin: true, lastChangedBy: null, lastChangedAt: ts, reason: null },
    ]);
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/settings/off-lan/telemetry")
      .send({ enabled: true, reason: "Audited 2026-05-27; renewed consent." });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("owner role can write (not just admin)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("owner", "stefan"));
    const res = await request(app)
      .patch("/api/settings/off-lan/web_fetch")
      .send({ enabled: true, reason: "Enabling for research session." });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it("rejects reason longer than 1024 chars with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/settings/off-lan/telemetry")
      .send({ enabled: false, reason: "x".repeat(1025) });
    expect(res.status).toBe(400);
  });
});
