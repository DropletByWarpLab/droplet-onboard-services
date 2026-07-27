/**
 * WARP-1528 / ADR-032 §5 (RBAC v2 T4) — `GET /api/modules` grows the per-user
 * effective view.
 *
 * `effectiveForUser` = workspace-effective modules ∩ the caller's resolved
 * feature grants, straight out of T3's `effective-access.service` (consumed,
 * never re-derived). The workspace-level `modules` payload is untouched — the
 * Settings → Features card is workspace-wide by design ("Applies to everyone
 * on this Droplet") and must keep reading box truth.
 *
 * Harness mirrors access.routes.test.ts: the real router behind a synthetic
 * req.user, with the T3 resolver bound to an in-memory Prisma stub through its
 * own `_setEffectiveAccessForTests` seam — so the intersection is proven
 * end-to-end, not stubbed at the boundary it is meant to exercise.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { createModulesRouter } from "./modules.routes.js";
import { _setEffectiveAccessForTests } from "../services/effective-access.service.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
  type TransactionMock,
  type TransactionSeam,
} from "../__tests__/helpers/prisma-tx-harness.js";
import { REPEATABLE_READ_TX } from "../lib/prisma-tx.js";
import type { AuthUser } from "../middleware/auth.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";

/** Every module available (deploy-time axis on); enablement is the axis the
 *  tests drive. */
const CFG: AvailabilityConfig = {
  AI_GATEWAY_URL: "http://ai-gateway:8000",
  FILE_INDEXER_URL: "http://file-indexer:8001",
  NEXTCLOUD_URL: "http://nextcloud",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://onlyoffice",
  SERVICE_TOKEN_EMAIL: "tok-email",
  SERVICE_TOKEN_VOICE: "tok-voice",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter:8003",
  ROUTING_SERVICE_URL: "http://routing:8004",
  SWITCH_SERVICE_URL: "http://switch:8005",
};

interface Seed {
  /** moduleId → enabled override rows (absent = registry defaultEnabled). */
  moduleSettings?: Array<{ moduleId: string; enabled: boolean }>;
  user?: {
    id: string;
    role: string;
    accessRole: null | {
      featureGrants: Array<{ moduleId: string; level: "view" | "act" | "manage" }>;
    };
  } | null;
  throwOnUserRead?: boolean;
}

function createPrismaStub(seed: Seed) {
  const self: Record<string, unknown> = {
    moduleSetting: {
      findMany: vi.fn().mockResolvedValue(seed.moduleSettings ?? []),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ id: 1, businessType: "clinic" }),
    },
    user: {
      findUnique: vi.fn(async () => {
        if (seed.throwOnUserRead) throw new Error("db down");
        if (!seed.user) return null;
        return {
          id: seed.user.id,
          role: seed.user.role,
          accessRole: seed.user.accessRole
            ? {
                mayOperateLocks: false,
                cloudModelsAllowed: false,
                storageQuotaBytes: null,
                maxUploadSizeMb: null,
                llmDailyMessageCap: null,
                featureGrants: seed.user.accessRole.featureGrants,
                toolGrants: [],
                connectorGrants: [],
              }
            : null,
        };
      }),
    },
    userAccessException: { findMany: vi.fn().mockResolvedValue([]) },
    offLanAllowlistChannel: { findUnique: vi.fn().mockResolvedValue(null) },
    integrationConnection: { findMany: vi.fn().mockResolvedValue([]) },
    userUsagePolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    departmentMembership: { findMany: vi.fn().mockResolvedValue([]) },
  };
  // WARP-1583: the §3 resolver now composes its whole read set inside one
  // RepeatableRead transaction, so this stub needs a real `$transaction`.
  // The shared seam (WARP-1570) rather than `(fn) => fn(self)`, because the
  // options argument is exactly what must not be silently dropped here — the
  // assertion below is `expectAllTransactionsAt`.
  const seam = createTransactionSeam({ client: () => self });
  self.$transaction = seam.$transaction;
  return Object.assign(self, { _seam: () => seam }) as unknown as PrismaStub;
}

interface PrismaStub {
  user: { findUnique: Mock };
  moduleSetting: { findMany: Mock };
  $transaction: TransactionMock;
  _seam: () => TransactionSeam;
}

const GATE = { requireModuleEnabled: () => (_r: Request, _s: Response, n: NextFunction) => n(), invalidate: vi.fn() };

function makeApp(seed: Seed, user: AuthUser | null, cfg: AvailabilityConfig = CFG) {
  const prisma = createPrismaStub(seed);
  _setEffectiveAccessForTests(prisma as never, cfg);
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });
  app.use("/api", createModulesRouter(prisma as never, cfg, GATE as never));
  return { app, prisma };
}

const STAFF: AuthUser = {
  id: "u-staff",
  username: "bo",
  displayName: "Bo",
  role: "family",
};

function ids(body: { effectiveForUser?: Array<{ moduleId: string }> }): string[] {
  return (body.effectiveForUser ?? []).map((f) => f.moduleId).sort();
}

beforeEach(() => {
  _setEffectiveAccessForTests(null, null);
});

describe("GET /api/modules — effectiveForUser (workspace ∩ role)", () => {
  it("workspace-OFF ∩ role-granted = OFF", async () => {
    const { app } = makeApp(
      {
        moduleSettings: [{ moduleId: "cameras", enabled: false }],
        user: {
          id: "u-staff",
          role: "family",
          accessRole: { featureGrants: [{ moduleId: "cameras", level: "manage" }] },
        },
      },
      STAFF,
    );
    const res = await request(app).get("/api/modules");
    expect(res.status).toBe(200);
    expect(ids(res.body)).not.toContain("cameras");
  });

  it("role-OFF ∩ workspace-on = OFF", async () => {
    const { app } = makeApp(
      {
        // files defaults enabled in the registry; the role grants only cameras.
        moduleSettings: [{ moduleId: "cameras", enabled: true }],
        user: {
          id: "u-staff",
          role: "family",
          accessRole: { featureGrants: [{ moduleId: "cameras", level: "view" }] },
        },
      },
      STAFF,
    );
    const res = await request(app).get("/api/modules");
    // The workspace view still says files is effective…
    expect(
      res.body.modules.find((m: { id: string }) => m.id === "files").effective,
    ).toBe(true);
    // …but this person's role never granted it.
    expect(ids(res.body)).not.toContain("files");
    expect(ids(res.body)).toContain("cameras");
  });

  it("the always-on trio's module (chat) is present even with zero grants", async () => {
    const { app } = makeApp(
      {
        user: { id: "u-staff", role: "family", accessRole: { featureGrants: [] } },
      },
      STAFF,
    );
    const res = await request(app).get("/api/modules");
    expect(ids(res.body)).toEqual(["chat"]);
  });

  it("carries the §9 action level alongside each module id", async () => {
    const { app } = makeApp(
      {
        // cameras is defaultEnabled:false in the registry — the workspace has
        // to be ON for the role grant to survive the intersection at all.
        moduleSettings: [{ moduleId: "cameras", enabled: true }],
        user: {
          id: "u-staff",
          role: "family",
          accessRole: { featureGrants: [{ moduleId: "cameras", level: "act" }] },
        },
      },
      STAFF,
    );
    const res = await request(app).get("/api/modules");
    expect(res.body.effectiveForUser).toContainEqual({ moduleId: "cameras", level: "act" });
  });

  it("a role-less person (today's world) mirrors the workspace-effective set", async () => {
    const { app } = makeApp(
      {
        moduleSettings: [{ moduleId: "cameras", enabled: false }],
        user: { id: "u-staff", role: "family", accessRole: null },
      },
      STAFF,
    );
    const res = await request(app).get("/api/modules");
    const workspaceOn = res.body.modules
      .filter((m: { effective: boolean }) => m.effective)
      .map((m: { id: string }) => m.id)
      .sort();
    expect(ids(res.body)).toEqual(workspaceOn);
  });
});

describe("GET /api/modules — additive, resilient, unchanged", () => {
  it("leaves the workspace-level payload intact (no breaking change)", async () => {
    const { app } = makeApp(
      { user: { id: "u-staff", role: "family", accessRole: { featureGrants: [] } } },
      STAFF,
    );
    const res = await request(app).get("/api/modules");
    expect(res.body.businessType).toBe("clinic");
    expect(Array.isArray(res.body.modules)).toBe(true);
    expect(res.body.modules[0]).toMatchObject({
      id: expect.any(String),
      label: expect.any(String),
      available: expect.any(Boolean),
      enabled: expect.any(Boolean),
      effective: expect.any(Boolean),
    });
  });

  it("a role-holder on a box with AI_GATEWAY_URL unset still gets `chat`, never []", async () => {
    // WARP-1528 (QA): `chat` is core — exempt from workspace ENABLEMENT
    // everywhere else — but its AVAILABILITY is isSet(AI_GATEWAY_URL). With
    // the gateway unset, a role-holder whose grants don't survive the
    // intersection used to resolve to an empty set, and the dashboard's
    // fail-open guard then fell back to the FULL workspace list: the "Droplet
    // full of locked doors" this feature exists to prevent.
    const { app } = makeApp(
      {
        // Grant a module the workspace has switched off, so nothing but the
        // always-on floor can survive.
        moduleSettings: [{ moduleId: "cameras", enabled: false }],
        user: {
          id: "u-staff",
          role: "family",
          accessRole: { featureGrants: [{ moduleId: "cameras", level: "view" }] },
        },
      },
      STAFF,
      { ...CFG, AI_GATEWAY_URL: "" },
    );
    const res = await request(app).get("/api/modules");
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(["chat"]);
    // The field must be PRESENT — an omission here would silently fall the
    // nav back to the workspace view instead of narrowing.
    expect(res.body.effectiveForUser).toBeDefined();
  });

  it("OMITS the field when the resolver can't resolve the caller (fail OPEN in nav)", async () => {
    // No local row — the AUTH_ENABLED=false dev session / OCS fallback. The
    // nav must fall back to the workspace view, never hide every surface.
    const { app } = makeApp({ user: null }, STAFF);
    const res = await request(app).get("/api/modules");
    expect(res.status).toBe(200);
    expect(res.body.effectiveForUser).toBeUndefined();
    expect(res.body.modules.length).toBeGreaterThan(0);
  });

  it("OMITS the field (still 200) when the resolver throws", async () => {
    const { app } = makeApp({ throwOnUserRead: true }, STAFF);
    const res = await request(app).get("/api/modules");
    expect(res.status).toBe(200);
    expect(res.body.effectiveForUser).toBeUndefined();
  });

  it("still 401s an unauthenticated caller", async () => {
    const { app } = makeApp({ user: null }, null);
    expect((await request(app).get("/api/modules")).status).toBe(401);
  });

  it("resolves the caller's view from ONE RepeatableRead snapshot (WARP-1583)", async () => {
    // The route composes the nav out of the workspace module set AND the
    // caller's grants. Read across snapshots, a module toggle landing
    // mid-request could produce a nav that hides a surface the person's
    // grants still reach, or shows one they no longer do.
    const { app, prisma } = makeApp(
      {
        user: {
          id: "u-staff",
          role: "family",
          accessRole: { featureGrants: [{ moduleId: "cameras", level: "view" }] },
        },
      },
      STAFF,
    );
    await request(app).get("/api/modules");
    expectAllTransactionsAt(prisma._seam(), REPEATABLE_READ_TX);
  });

  it("resolves against the local User.id UUID, never the username (WARP-881)", async () => {
    const { app, prisma } = makeApp(
      { user: { id: "u-staff", role: "family", accessRole: { featureGrants: [] } } },
      STAFF,
    );
    await request(app).get("/api/modules");
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-staff" } }),
    );
  });
});
