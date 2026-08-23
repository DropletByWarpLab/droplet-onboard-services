/**
 * WARP-540 — route tests for the /api/updates/* operator surface.
 *
 * Contract under test:
 *   - owner/admin gate across the WHOLE surface (reads included);
 *   - GET status: current committed / pending / lastVerdict rows, the
 *     degraded_health signal, settings, applyAvailable honesty, and the
 *     updateSourceAuthenticated release-source flag (WARP-2133);
 *   - GET history: newest-first slim rows (never manifestJson);
 *   - POST check-now: delegates to the poller and relays the typed
 *     outcome verbatim, audits the mutation;
 *   - POST apply-now: 503 when apply isn't provisioned, 409 on
 *     nothing-pending / already-applying, 202 + dispatch otherwise;
 *   - POST skip: pending → superseded with `skipped_by_operator`,
 *     status-guarded against a racing apply;
 *   - GET/PUT settings: WARP-538 persistence, strict-write 400s.
 *
 * Strategy mirrors settings-email.route.test.ts: a minimal Express app +
 * supertest with a synthetic auth middleware that stuffs req.user, an
 * in-memory Prisma mock, and INJECTED update-agent deps — the real
 * checkForUpdate/applyPendingUpdate are never called, so no GitHub
 * endpoint, cosign binary, or compose socket is ever touched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    DROPLET_OTA_RELEASES_URL: "https://releases.test/latest",
    DROPLET_OTA_GITHUB_TOKEN: "",
    DROPLET_OTA_APPLY_SCRIPT: "",
    DROPLET_OTA_COMPOSE_FILE: "/opt/droplet/docker/docker-compose.yml",
    DROPLET_OTA_UPDATES_DIR: "/data/updates",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createUpdatesRouter, type UpdatesRouterDeps } from "./updates.js";
import {
  getUpdateAgentSettings,
  saveUpdateAgentSettings,
  DEFAULT_UPDATE_AGENT_SETTINGS,
} from "../services/update-agent/settings.js";
import { config } from "../config.js";

const GIT_SHA_A = "a".repeat(40);
const GIT_SHA_B = "b".repeat(40);

interface RowSeed {
  id: string;
  status: string;
  channel?: string;
  releaseTag?: string | null;
  gitSha?: string;
  builtAt?: Date;
  failureReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function seedRow(seed: RowSeed) {
  return {
    channel: "stable",
    releaseTag: "ota-1-gaaaaaaa",
    gitSha: GIT_SHA_A,
    builtAt: new Date("2026-07-01T00:00:00Z"),
    failureReason: null,
    createdAt: new Date("2026-07-01T01:00:00Z"),
    updatedAt: new Date("2026-07-01T01:00:00Z"),
    // manifestJson deliberately present in the store so a leak through
    // the select contract would be visible in response assertions.
    manifestSha256: "f".repeat(64),
    manifestJson: { schemaVersion: 1 },
    ...seed,
  };
}

/**
 * In-memory Prisma mock: DeviceUpdate rows + the SystemFlag row the real
 * WARP-538 settings module reads/writes (settings code runs for real).
 */
function createPrismaMock(rows: ReturnType<typeof seedRow>[] = []) {
  const updates = rows.map((r) => ({ ...r }));
  const flags = new Map<string, { key: string; valueJson: unknown }>();

  const matches = (row: (typeof updates)[number], where: any): boolean => {
    if (where?.id !== undefined && row.id !== where.id) return false;
    if (where?.status !== undefined) {
      if (typeof where.status === "string") {
        if (row.status !== where.status) return false;
      } else if (Array.isArray(where.status.in)) {
        if (!where.status.in.includes(row.status)) return false;
      }
    }
    return true;
  };
  const sortBy = (list: typeof updates, orderBy: any) => {
    const [[field, dir]] = Object.entries(orderBy ?? { createdAt: "desc" }) as [
      [keyof (typeof updates)[number], string],
    ];
    return [...list].sort((a, b) => {
      const av = (a[field] as Date).getTime();
      const bv = (b[field] as Date).getTime();
      return dir === "desc" ? bv - av : av - bv;
    });
  };
  const project = (row: (typeof updates)[number], select: any) => {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(select)) if (v) out[k] = (row as any)[k];
    return out;
  };

  return {
    _updates: updates,
    deviceUpdate: {
      findFirst: vi.fn(async ({ where, orderBy, select }: any = {}) => {
        const hit = sortBy(updates.filter((r) => matches(r, where)), orderBy)[0];
        return hit ? project(hit, select) : null;
      }),
      findMany: vi.fn(async ({ orderBy, take, select }: any = {}) =>
        sortBy(updates, orderBy)
          .slice(0, take ?? updates.length)
          .map((r) => project(r, select)),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hits = updates.filter((r) => matches(r, where));
        for (const row of hits) Object.assign(row, data, { updatedAt: new Date() });
        return { count: hits.length };
      }),
    },
    systemFlag: {
      findUnique: vi.fn(async ({ where }: any) => flags.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const next = flags.has(where.key)
          ? { ...flags.get(where.key)!, ...update }
          : { ...create };
        flags.set(where.key, next);
        return next;
      }),
    },
  };
}

/** Deps double — the routes must never reach the real update agent. */
function createDepsMock(overrides: Partial<UpdatesRouterDeps> = {}): UpdatesRouterDeps {
  return {
    checkForUpdate: vi.fn(async () => ({ outcome: "no_release" as const })),
    applyPendingUpdate: vi.fn(async () => ({
      outcome: "self_swap_started" as const,
      deviceUpdateId: "du-pending",
    })),
    // Real WARP-538 settings code over the prisma mock's SystemFlag —
    // exercises the strict-write validation the PUT contract leans on.
    getUpdateAgentSettings,
    saveUpdateAgentSettings,
    getApplyRunner: () => null,
    ...overrides,
  };
}

function buildApp(
  prismaMock: any,
  deps: UpdatesRouterDeps,
  user: { id: string; username: string; role: string } | null = {
    id: "owner-id",
    username: "romain",
    role: "owner",
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as any).user = { ...user };
    next();
  });
  app.use("/api", createUpdatesRouter(prismaMock, deps));
  // Mirror the app's error-handler contract enough for next(err) paths.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── RBAC posture ──────────────────────────────────────────────────

describe("/api/updates RBAC (owner+admin only, reads included)", () => {
  it.each([
    ["get", "/api/updates/status"],
    ["get", "/api/updates/history"],
    ["get", "/api/updates/settings"],
    ["post", "/api/updates/check-now"],
    ["post", "/api/updates/apply-now"],
    ["post", "/api/updates/skip"],
    ["put", "/api/updates/settings"],
  ] as const)("rejects family on %s %s with 403", async (method, path) => {
    const app = buildApp(createPrismaMock(), createDepsMock(), {
      id: "fam",
      username: "fam",
      role: "family",
    });
    const res = await (request(app) as any)[method](path).send({});
    expect(res.status).toBe(403);
  });

  it("admits admin on GET /api/updates/status", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock(), {
      id: "adm",
      username: "adm",
      role: "admin",
    });
    const res = await request(app).get("/api/updates/status");
    expect(res.status).toBe(200);
  });
});

// ── GET /api/updates/status ───────────────────────────────────────

describe("GET /api/updates/status", () => {
  it("returns current committed, pending, settings, and applyAvailable=false without a runner", async () => {
    const prisma = createPrismaMock([
      seedRow({
        id: "du-committed",
        status: "committed",
        updatedAt: new Date("2026-07-02T04:00:00Z"),
      }),
      seedRow({
        id: "du-pending",
        status: "pending",
        gitSha: GIT_SHA_B,
        releaseTag: "ota-2-gbbbbbbb",
        createdAt: new Date("2026-07-03T01:00:00Z"),
        updatedAt: new Date("2026-07-03T01:00:00Z"),
      }),
    ]);
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app).get("/api/updates/status");
    expect(res.status).toBe(200);
    expect(res.body.current.id).toBe("du-committed");
    expect(res.body.current.gitSha).toBe(GIT_SHA_A);
    expect(res.body.pending.id).toBe("du-pending");
    expect(res.body.pending.gitSha).toBe(GIT_SHA_B);
    expect(res.body.degraded).toBe(false);
    expect(res.body.applyAvailable).toBe(false);
    expect(res.body.settings).toEqual(DEFAULT_UPDATE_AGENT_SETTINGS);
    // The verified manifest snapshot is apply material — never serialized.
    expect(res.body.current.manifestJson).toBeUndefined();
    expect(res.body.pending.manifestJson).toBeUndefined();
  });

  it("reports null current/pending honestly on a factory-image box", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock());
    const res = await request(app).get("/api/updates/status");
    expect(res.status).toBe(200);
    expect(res.body.current).toBeNull();
    expect(res.body.pending).toBeNull();
    expect(res.body.lastVerdict).toBeNull();
    expect(res.body.degraded).toBe(false);
  });

  it("raises degraded when the newest terminal verdict is failed/degraded_health", async () => {
    const prisma = createPrismaMock([
      seedRow({
        id: "du-failed",
        status: "failed",
        failureReason: "degraded_health",
        updatedAt: new Date("2026-07-04T03:10:00Z"),
      }),
    ]);
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app).get("/api/updates/status");
    expect(res.body.degraded).toBe(true);
    expect(res.body.lastVerdict.id).toBe("du-failed");
  });

  it("clears degraded once a LATER apply commits", async () => {
    const prisma = createPrismaMock([
      seedRow({
        id: "du-failed",
        status: "failed",
        failureReason: "degraded_health",
        updatedAt: new Date("2026-07-04T03:10:00Z"),
      }),
      seedRow({
        id: "du-committed",
        status: "committed",
        gitSha: GIT_SHA_B,
        updatedAt: new Date("2026-07-05T03:10:00Z"),
      }),
    ]);
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app).get("/api/updates/status");
    expect(res.body.degraded).toBe(false);
    expect(res.body.lastVerdict.id).toBe("du-committed");
  });

  it("reports applyAvailable=true when a runner is provisioned", async () => {
    const deps = createDepsMock({ getApplyRunner: () => ({} as any) });
    const app = buildApp(createPrismaMock(), deps);
    const res = await request(app).get("/api/updates/status");
    expect(res.body.applyAvailable).toBe(true);
  });

  // WARP-2133: without a token the box polls the private releases repo
  // unauthenticated, 404s, and can't see the feed at all — the flag is
  // what lets the page say that instead of "up to date".
  it("reports updateSourceAuthenticated=false without a releases token", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock());
    const res = await request(app).get("/api/updates/status");
    expect(res.body.updateSourceAuthenticated).toBe(false);
  });

  it("reports updateSourceAuthenticated=true when a releases token is provisioned", async () => {
    config.DROPLET_OTA_GITHUB_TOKEN = "ghp_test";
    try {
      const app = buildApp(createPrismaMock(), createDepsMock());
      const res = await request(app).get("/api/updates/status");
      expect(res.body.updateSourceAuthenticated).toBe(true);
    } finally {
      config.DROPLET_OTA_GITHUB_TOKEN = "";
    }
  });
});

// ── GET /api/updates/history ──────────────────────────────────────

describe("GET /api/updates/history", () => {
  it("returns rows newest-first without manifestJson", async () => {
    const prisma = createPrismaMock([
      seedRow({ id: "du-old", status: "committed", createdAt: new Date("2026-07-01T01:00:00Z") }),
      seedRow({
        id: "du-new",
        status: "pending",
        gitSha: GIT_SHA_B,
        createdAt: new Date("2026-07-02T01:00:00Z"),
      }),
    ]);
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app).get("/api/updates/history");
    expect(res.status).toBe(200);
    expect(res.body.updates.map((u: any) => u.id)).toEqual(["du-new", "du-old"]);
    expect(res.body.updates[0].manifestJson).toBeUndefined();
    expect(res.body.updates[0].manifestSha256).toBeUndefined();
  });

  it("clamps ?limit to the bounds", async () => {
    const prisma = createPrismaMock([
      seedRow({ id: "du-1", status: "committed", createdAt: new Date("2026-07-01T01:00:00Z") }),
      seedRow({
        id: "du-2",
        status: "superseded",
        gitSha: GIT_SHA_B,
        createdAt: new Date("2026-07-02T01:00:00Z"),
      }),
    ]);
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app).get("/api/updates/history?limit=1");
    expect(res.body.updates).toHaveLength(1);
    const bogus = await request(app).get("/api/updates/history?limit=nope");
    expect(bogus.body.updates).toHaveLength(2);
  });
});

// ── POST /api/updates/check-now ───────────────────────────────────

describe("POST /api/updates/check-now", () => {
  it("delegates to the poller with the deployment config and relays the outcome", async () => {
    const checkForUpdateMock = vi.fn(async () => ({
      outcome: "pending_created" as const,
      deviceUpdateId: "du-x",
      gitSha: GIT_SHA_B,
      supersededCount: 1,
    }));
    const deps = createDepsMock({ checkForUpdate: checkForUpdateMock });
    const app = buildApp(createPrismaMock(), deps);
    const res = await request(app).post("/api/updates/check-now").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: "pending_created",
      deviceUpdateId: "du-x",
      gitSha: GIT_SHA_B,
      supersededCount: 1,
    });
    expect(checkForUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        releasesLatestUrl: "https://releases.test/latest",
        githubToken: undefined,
      }),
    );
  });

  it("relays an expected failure outcome as 200 data, not a 5xx", async () => {
    const deps = createDepsMock({
      checkForUpdate: vi.fn(async () => ({
        outcome: "fetch_failed" as const,
        detail: "releases latest endpoint unreachable: getaddrinfo ENOTFOUND",
      })),
    });
    const app = buildApp(createPrismaMock(), deps);
    const res = await request(app).post("/api/updates/check-now").send({});
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("fetch_failed");
  });

  it("audits the forced check", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock());
    await request(app).post("/api/updates/check-now").send({});
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "OTA update check forced",
        refs: expect.objectContaining({ outcome: "no_release", actor: "romain" }),
      }),
    );
  });
});

// ── POST /api/updates/apply-now ───────────────────────────────────

describe("POST /api/updates/apply-now", () => {
  it("503s apply_unavailable when no runner is provisioned (never fakes a start)", async () => {
    const prisma = createPrismaMock([seedRow({ id: "du-pending", status: "pending" })]);
    const deps = createDepsMock(); // getApplyRunner → null
    const app = buildApp(prisma, deps);
    const res = await request(app).post("/api/updates/apply-now").send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("apply_unavailable");
    expect(deps.applyPendingUpdate).not.toHaveBeenCalled();
  });

  it("409s nothing_pending when there is no pending/verifying row", async () => {
    const deps = createDepsMock({ getApplyRunner: () => ({} as any) });
    const app = buildApp(createPrismaMock(), deps);
    const res = await request(app).post("/api/updates/apply-now").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("nothing_pending");
  });

  it("409s apply_in_progress when a row is already applying", async () => {
    const prisma = createPrismaMock([seedRow({ id: "du-applying", status: "applying" })]);
    const deps = createDepsMock({ getApplyRunner: () => ({} as any) });
    const app = buildApp(prisma, deps);
    const res = await request(app).post("/api/updates/apply-now").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("apply_in_progress");
    expect(deps.applyPendingUpdate).not.toHaveBeenCalled();
  });

  it("202s, dispatches the apply with the runner, and audits", async () => {
    const prisma = createPrismaMock([seedRow({ id: "du-pending", status: "pending" })]);
    const runner = { fake: "runner" } as any;
    let resolveApply!: (v: any) => void;
    const applyPendingUpdateMock = vi.fn(
      () => new Promise((r) => (resolveApply = r)),
    ) as any;
    const deps = createDepsMock({
      getApplyRunner: () => runner,
      applyPendingUpdate: applyPendingUpdateMock,
    });
    const app = buildApp(prisma, deps);

    const res = await request(app).post("/api/updates/apply-now").send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true, deviceUpdateId: "du-pending" });
    expect(applyPendingUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ runner, releasesLatestUrl: "https://releases.test/latest" }),
    );
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "OTA apply forced",
        refs: expect.objectContaining({ deviceUpdateId: "du-pending" }),
      }),
    );

    // Single-flight: a second apply-now while the first is in flight 409s.
    const second = await request(app).post("/api/updates/apply-now").send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("apply_in_progress");

    // Once the dispatched apply settles the flag clears.
    resolveApply({ outcome: "rolled_back", deviceUpdateId: "du-pending" });
    await vi.waitFor(async () => {
      const third = await request(app).post("/api/updates/apply-now").send({});
      expect(third.status).toBe(202);
    });
  });

  it("picks up a resumable verifying row (retry cursor)", async () => {
    const prisma = createPrismaMock([seedRow({ id: "du-verifying", status: "verifying" })]);
    const deps = createDepsMock({ getApplyRunner: () => ({} as any) });
    const app = buildApp(prisma, deps);
    const res = await request(app).post("/api/updates/apply-now").send({});
    expect(res.status).toBe(202);
    expect(res.body.deviceUpdateId).toBe("du-verifying");
  });
});

// ── POST /api/updates/skip ────────────────────────────────────────

describe("POST /api/updates/skip", () => {
  it("retires the newest pending row as superseded/skipped_by_operator and audits", async () => {
    const prisma = createPrismaMock([seedRow({ id: "du-pending", status: "pending" })]);
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app).post("/api/updates/skip").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skipped: true, deviceUpdateId: "du-pending" });
    const row = prisma._updates.find((r: any) => r.id === "du-pending")!;
    expect(row.status).toBe("superseded");
    expect(row.failureReason).toBe("skipped_by_operator");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "OTA release skipped" }),
    );
  });

  it("409s nothing_pending with no pending row", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock());
    const res = await request(app).post("/api/updates/skip").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("nothing_pending");
  });

  it("409s apply_in_progress when the row set is mid-apply", async () => {
    const prisma = createPrismaMock([seedRow({ id: "du-applying", status: "applying" })]);
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app).post("/api/updates/skip").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("apply_in_progress");
  });
});

// ── GET/PUT /api/updates/settings ─────────────────────────────────

describe("GET/PUT /api/updates/settings", () => {
  it("GET returns the persisted WARP-538 settings (defaults on a fresh box)", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock());
    const res = await request(app).get("/api/updates/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_UPDATE_AGENT_SETTINGS);
  });

  it("PUT persists a partial patch and audits it", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, createDepsMock());
    const res = await request(app)
      .put("/api/updates/settings")
      .send({ applyWindowCron: "30 4 * * *", autoApply: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      channel: "stable",
      applyWindowCron: "30 4 * * *",
      autoApply: false,
    });
    // Round-trips through the SystemFlag row.
    const read = await request(app).get("/api/updates/settings");
    expect(read.body.applyWindowCron).toBe("30 4 * * *");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "OTA update settings changed" }),
    );
  });

  it("PUT 400s an invalid cron via the settings module's strict write", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock());
    const res = await request(app)
      .put("/api/updates/settings")
      .send({ applyWindowCron: "definitely not cron" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/applyWindowCron/);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("PUT 400s a non-object body", async () => {
    const app = buildApp(createPrismaMock(), createDepsMock());
    const res = await request(app)
      .put("/api/updates/settings")
      .set("Content-Type", "application/json")
      .send('["not","an","object"]');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_settings");
  });
});
