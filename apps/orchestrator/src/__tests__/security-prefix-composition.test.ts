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
 *
 * WARP-2981 (ADR-059 P6) — the rack panel's count, GET /api/panel/security,
 * is the second piece of host plumbing that must not sit behind the toggle:
 * it has to be able to answer `off`, which a gated route never can (the gate
 * answers 404 for a switched-off module and for a toggle it could not read
 * alike). Pinned the same way, at the bottom.
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
import { createPanelSecurityRouter } from "../routes/panel-security.js";
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
    // WARP-2977 P2b: the feed resolves each row's areas from the active links.
    securityZoneLink: { findMany: vi.fn().mockResolvedValue([]) },
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
    // command center's own three (WARP-2977 P2b split areas and the site mode
    // into their own routers — pinned as gated below) and the egress
    // collector's. A new one appearing here must be deliberately placed
    // before or after the gate.
    const routes = join(SRC, "routes");
    // WARP-2978 adds incidents, acknowledgement and alert routing (security-incidents.ts);
    // WARP-2980 adds "what normal looks like" (security-patterns.ts);
    // WARP-2979 (P4) the chat tools' read-only routes (security-assistant.ts).
    // WARP-2981's panel-security.ts is deliberately NOT here and needs no
    // exemption: its path is /api/panel/security, outside the module prefix.
    const SECURITY_MODULE_ROUTERS = new Set([
      "security.ts",
      "security-zones.ts",
      "security-site.ts",
      "security-incidents.ts",
      "security-patterns.ts",
      "security-assistant.ts",
    ]);
    const offenders = readdirSync(routes)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => !SECURITY_MODULE_ROUTERS.has(f) && f !== "egress-audit.ts")
      .filter((f) => /["'`]\/security[/"'`]/.test(readFileSync(join(routes, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("app.ts mounts the Security module's own routers AFTER mountModuleGates (they are gated)", () => {
    // The mirror of the egress pin: these ARE the module, so they must sit
    // behind the toggle and the per-person view gate. Mounted before it,
    // every area and opening-hours route would answer with Security off.
    const src = readFileSync(join(SRC, "app.ts"), "utf8");
    const gates = src.indexOf("mountModuleGates(app, moduleGate)");
    expect(gates).toBeGreaterThan(-1);
    for (const mount of [
      'app.use("/api", createSecurityRouter(prisma))',
      'app.use("/api", createSecurityZonesRouter(prisma))',
      'app.use("/api", createSecuritySiteRouter(prisma))',
      // WARP-2978 (P3) — incidents, acknowledgement and alert routing.
      'app.use("/api", createSecurityIncidentsRouter(prisma))',
      // WARP-2980 (P5) — "what normal looks like".
      'app.use("/api", createSecurityPatternsRouter(prisma))',
      // WARP-2979 (P4) — the chat tools' routes: a switched-off Security is off for Droplet's AI too.
      'app.use("/api", createSecurityAssistantRouter(prisma))',
    ]) {
      expect(src.indexOf(mount), mount).toBeGreaterThan(gates);
    }
  });

  it("WARP-2979: the chat tools' router sits behind the WARP-2988 acting-user gate too", () => {
    // `security` is in MCP_ACTING_USER_GATED_DOMAINS: the gate narrows the
    // `_service:mcp` principal by the person's own tool scope on /api/security,
    // which only works when it is mounted in front of the router it guards.
    const src = readFileSync(join(SRC, "app.ts"), "utf8");
    const acting = src.indexOf("mountMcpActingUserGates(app, ");
    expect(acting).toBeGreaterThan(src.indexOf("mountModuleGates(app, moduleGate)"));
    expect(src.indexOf('app.use("/api", createSecurityAssistantRouter(prisma))')).toBeGreaterThan(acting);
  });
});

describe("WARP-2981 — the rack panel's count is not behind the Security toggle", () => {
  const DISPLAY: Principal = { id: "_service:display", username: "_service:display", displayName: "Rack Panel Bridge", role: "service" };

  /** The REAL gates mounted FIRST, then the panel router — its default toggle read over the same moduleSetting rows. */
  function panelBehindGates(user: Principal, disabled: ModuleId[]) {
    const prisma = prismaWith(disabled);
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: unknown }).user = user;
      next();
    });
    mountModuleGates(app, createModuleGate(prisma, CFG, 0), async () => ({ tier: user.role, features: [] }) as never);
    app.use("/api", createPanelSecurityRouter(prisma));
    return app;
  }

  it("Security OFF → the panel still reaches its handler and hears `off`, never 404 module_disabled", async () => {
    const res = await request(panelBehindGates(DISPLAY, ["security"])).get("/api/panel/security");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ security: "off" });
  });

  it("…and a person reaching it the same way is refused by its own guard (403), not by a module gate", async () => {
    const res = await request(panelBehindGates(OWNER, ["security"])).get("/api/panel/security");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
  });

  it("app.ts mounts the panel router BEFORE mountModuleGates", () => {
    const src = readFileSync(join(SRC, "app.ts"), "utf8");
    const panel = src.indexOf('app.use("/api", createPanelSecurityRouter(prisma))');
    const gates = src.indexOf("mountModuleGates(app, moduleGate)");
    expect(panel).toBeGreaterThan(-1);
    expect(panel).toBeLessThan(gates);
  });
});
