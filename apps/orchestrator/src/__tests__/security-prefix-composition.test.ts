/**
 * WARP-2977 review — the `security` module's prefix is shared with a route
 * that predates it.
 *
 * The new `security` module owns `/api/security` and is OFF by default. The
 * WARP-268 egress-audit collector already pushed to
 * `POST /api/security/egress-anomaly`. With the egress router mounted after
 * `mountModuleGates`, every box without Security switched on answered the
 * collector `404 module_disabled`; the collector's sink suppresses repeats,
 * so the egress audit — one of the threat mirror's sources — went silent
 * with nothing on screen to say so.
 *
 * Driven through the REAL `mountModuleGates`, the real module gate and the
 * real egress + security routers, in both orders, plus a pin on the order
 * `app.ts` actually uses.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ModuleId } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, FRIGATE_URL: "", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));
// The egress route's per-IP rate limiter reads/writes the cache.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn(),
}));
vi.mock("../services/camera.service.js", () => ({
  securityStatusSnapshot: () => new Map(),
}));

import { mountModuleGates } from "../modules/module-mounts.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { MODULES, type AvailabilityConfig } from "../modules/module-registry.js";
import { createEgressAuditRouter } from "../routes/egress-audit.js";
import { createSecurityRouter } from "../routes/security.js";
import type { AuthUser } from "../middleware/auth.js";

const SRC = resolve(__dirname, "..");

const CFG: AvailabilityConfig = {
  AI_GATEWAY_URL: "http://ai:8000",
  FILE_INDEXER_URL: "http://fi:8090",
  NEXTCLOUD_URL: "http://nc:8080",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://docs",
  SERVICE_TOKEN_EMAIL: "tok",
  SERVICE_TOKEN_VOICE: "tok",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter:8083",
  ROUTING_SERVICE_URL: "http://routing:8080",
  SWITCH_SERVICE_URL: "http://switch:8081",
};

/** Security switched off box-wide — today's default on every box. */
function prismaWith(disabled: ModuleId[]) {
  return {
    moduleSetting: {
      findMany: async () => MODULES.map((m) => ({ moduleId: m.id, enabled: !disabled.includes(m.id) })),
    },
    securityEvent: { findMany: vi.fn().mockResolvedValue([]) },
    cameraAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
    securityIngestState: { findUnique: vi.fn().mockResolvedValue(null) },
  } as never;
}

type Principal = AuthUser;
const COLLECTOR: Principal = { id: "_service:egress-audit", username: "_service:egress-audit", displayName: "egress", role: "service" };
const OWNER: Principal = { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" };

function build(order: "egress-first" | "gates-first", user: Principal, disabled: ModuleId[] = ["security"]) {
  const prisma = prismaWith(disabled);
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = user;
    next();
  });
  // Layer 2 resolves the person's grants; the owner holds Security at manage.
  const resolve = async () =>
    ({
      tier: user.role,
      features: [{ moduleId: "security", level: "manage" }],
      toolDomains: [],
      locks: false,
      cloud: false,
      connectors: {},
      connectorGrants: null,
      usage: {
        storageQuotaBytes: null,
        maxUploadSizeMb: null,
        llmDailyMessageCap: null,
        source: "default",
        sources: { storageQuotaBytes: "default", maxUploadSizeMb: "default", llmDailyMessageCap: "default" },
      },
      deptRights: [],
      exceptions: [],
    }) as never;
  const gates = () => mountModuleGates(app, createModuleGate(prisma, CFG, 0), resolve);
  if (order === "egress-first") {
    app.use("/api", createEgressAuditRouter());
    gates();
  } else {
    gates();
    app.use("/api", createEgressAuditRouter());
  }
  app.use("/api", createSecurityRouter(prisma));
  return app;
}

// An empty body reaches the handler and fails ITS validation (400); a 404
// module_disabled means the module gate answered instead.
const post = (app: express.Express) => request(app).post("/api/security/egress-anomaly").send({});

describe("the egress-audit collector is not behind the Security toggle", () => {
  it("production order: Security OFF, the collector still reaches its handler", async () => {
    const res = await post(build("egress-first", COLLECTOR));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid egress anomaly");
  });

  it("…while the command center itself is gated: Security OFF → 404 module_disabled", async () => {
    const res = await request(build("egress-first", OWNER)).get("/api/security/events");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "security" });
  });

  it("…and serves once Security is on", async () => {
    const res = await request(build("egress-first", OWNER, [])).get("/api/security/events");
    expect(res.status).toBe(200);
  });

  it("the hazard, reproduced: gates mounted first swallow the collector", async () => {
    const res = await post(build("gates-first", COLLECTOR));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "security" });
  });

  it("app.ts mounts the egress router BEFORE mountModuleGates", () => {
    const src = readFileSync(join(SRC, "app.ts"), "utf8");
    const egress = src.indexOf('app.use("/api", createEgressAuditRouter())');
    const gates = src.indexOf("mountModuleGates(app, moduleGate)");
    expect(egress).toBeGreaterThan(-1);
    expect(gates).toBeGreaterThan(-1);
    expect(egress).toBeLessThan(gates);
  });

  it("no OTHER existing route lives under /api/security (a new one must be checked the same way)", () => {
    // Every router file that declares a `/security…` path, other than the
    // command center's own and the egress collector's. A new one appearing
    // here must be deliberately placed before or after the gate.
    const routes = join(SRC, "routes");
    const offenders = readdirSync(routes)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => f !== "security.ts" && f !== "egress-audit.ts")
      .filter((f) => /["'`]\/security[/"'`]/.test(readFileSync(join(routes, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
