/**
 * /api/support/* behind the REAL module gates (WARP-3528).
 *
 * WS-12's acceptance criterion: "A member without the `support` grant gets
 * [denied] on every `/api/support/*` route." The route suite (support.routes.test)
 * drives the router alone; this one mounts it exactly as app.ts does — the
 * registry-driven `mountModuleGates` in front of `createSupportRouter` — and
 * walks EVERY route the router mounts.
 *
 * The denial is the box's own, not a 403: one 404 `{ error: "module_disabled",
 * module: "support" }` for a person narrowed away from Support, for a switched-off
 * module and for an external guest, byte-identical (ADR-032 §3 — a narrowed
 * person sees a smaller box, not a locked door; the slice spec's word "403" is
 * the loose form of this). The services are mocked: what is under test is who
 * reaches them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import type { ModuleId } from "@prisma/client";

vi.mock("../../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

const svc = vi.hoisted(() => {
  const fns = [
    "listAgents", "searchRequesterContacts", "createRequesterContact", "listDesks", "createDesk",
    "updateDesk", "getDesk", "queueCounts", "listTickets", "createTicket", "getTicket", "updateTicket",
    "getConversation", "addReply", "addNote", "escalateTicket", "listRequesterTickets",
  ] as const;
  const out: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const f of fns) out[f] = vi.fn().mockResolvedValue({});
  return {
    ...out,
    EMPTY_BODY: "empty_body",
    INVALID_CURSOR: "invalid_cursor",
    SupportContactExistsError: class extends Error {},
  };
});
vi.mock("../../services/support/support.service.js", () => svc);

import { mountModuleGates } from "../../modules/module-mounts.js";
import { createModuleGate } from "../../middleware/module-gate.js";
import { MODULES, type AvailabilityConfig } from "../../modules/module-registry.js";
import { createSupportRouter } from "./support.routes.js";
import { ROUTES, grants } from "../../__tests__/helpers/support-routes.js";
import type { AuthUser } from "../../middleware/auth.js";
import type { FeatureLevel } from "../../services/access-catalog.js";

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

const person = (role: string): AuthUser =>
  ({ id: `u-${role}`, username: role, displayName: role, role }) as AuthUser;

function appWith(opts: {
  role?: string;
  disabled?: ModuleId[];
  features: Array<[ModuleId, FeatureLevel]>;
}): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = person(opts.role ?? "family");
    next();
  });
  const settings = {
    moduleSetting: {
      findMany: async () =>
        MODULES.map((m) => ({ moduleId: m.id, enabled: !(opts.disabled ?? []).includes(m.id) })),
    },
  } as never;
  const resolve = async () => grants(opts.features);
  mountModuleGates(app, createModuleGate(settings, CFG, 0), resolve);
  app.use("/api", createSupportRouter({} as never, { resolveAccess: resolve }));
  return app;
}

const call = (app: Express, c: (typeof ROUTES)[number]) => {
  const r = request(app)[c.method](c.url);
  return c.body === undefined ? r : r.send(c.body as object);
};

const nothingRan = () => {
  for (const fn of Object.values(svc)) {
    if (typeof fn === "function" && "mock" in fn) expect(fn).not.toHaveBeenCalled();
  }
};

beforeEach(() => vi.clearAllMocks());

describe("a person narrowed away from Support", () => {
  it("is denied on EVERY support route with the box's own 404, and no service runs", async () => {
    const app = appWith({ features: [["projects", "manage"], ["crm", "manage"]] });
    for (const c of ROUTES) {
      const res = await call(app, c);
      expect(res.status, `${c.method} ${c.url}`).toBe(404);
      expect(res.body, `${c.method} ${c.url}`).toEqual({ error: "module_disabled", module: "support" });
    }
    nothingRan();
  });

  it("is told exactly what a switched-off module tells everyone", async () => {
    const narrowed = appWith({ features: [["files", "view"]] });
    const off = appWith({ disabled: ["support"], features: [["support", "manage"]] });
    for (const c of ROUTES) {
      const a = await call(narrowed, c);
      const b = await call(off, c);
      expect([b.status, b.body], `${c.method} ${c.url}`).toEqual([a.status, a.body]);
    }
  });

  it("has no way in through the Projects grant", async () => {
    const app = appWith({ features: [["projects", "manage"]] });
    expect((await call(app, ROUTES[0]!)).status).toBe(404);
    nothingRan();
  });
});

describe("an external guest", () => {
  it("is refused on every route by the tier floor — even with a stale Support grant", async () => {
    const app = appWith({ role: "guest", features: [["support", "manage"]] });
    for (const c of ROUTES) {
      const res = await call(app, c);
      expect(res.status, `${c.method} ${c.url}`).toBe(404);
      expect(res.body).toEqual({ error: "module_disabled", module: "support" });
    }
    nothingRan();
  });
});

describe("a member who holds Support", () => {
  it("reaches the routes their level allows, with Projects switched off box-wide (no parent module)", async () => {
    const app = appWith({ disabled: ["projects"], features: [["support", "act"]] });
    for (const c of ROUTES) {
      if (c.adminOnly || c.path.endsWith("/escalate")) continue;
      const res = await call(app, c);
      expect(res.status, `${c.method} ${c.url}`).toBe(c.ok);
    }
  });

  it("is told 404 for what needs a second grant, naming the module that is missing", async () => {
    const app = appWith({ features: [["support", "act"]] });
    const esc = ROUTES.find((c) => c.path.endsWith("/escalate"))!;
    expect((await call(app, esc)).body).toEqual({ error: "module_disabled", module: "projects" });
  });

  it("is refused desk setup by role first, and an admin on `act` alone by level", async () => {
    const desk = ROUTES.find((c) => c.path === "/support/desks" && c.method === "post")!;
    // A member is not an admin: 403 by role, before any grant is asked.
    expect((await call(appWith({ features: [["support", "manage"]] }), desk)).status).toBe(403);
    // An admin whose role holds Support at `act` only: the box's 404 by level.
    const res = await call(appWith({ role: "admin", features: [["support", "act"]] }), desk);
    expect(res.body).toEqual({ error: "module_disabled", module: "support" });
    // …and with `manage` it goes through.
    expect((await call(appWith({ role: "admin", features: [["support", "manage"]] }), desk)).status).toBe(201);
  });
});
