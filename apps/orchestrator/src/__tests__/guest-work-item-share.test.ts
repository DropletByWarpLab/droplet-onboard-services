/**
 * WARP-3369 (Romain, 2026-09-30) — assigning a work item to an external guest
 * SHARES that one item with them. The guest may read it, read and write its
 * comments and move its state, and sees NOTHING else in Projects: no other item,
 * no project list, no board, no search, no activity feed, no relations. To find
 * those items (WARP-3407) they list the ones assigned to them, and only those.
 *
 * Driven through the REAL mount (`mountModuleGates`, whose `projects` tier floor
 * refuses a guest on the whole of `/api/pm`) and the REAL native PM router, with
 * a prisma double that answers only the per-item lookup:
 *
 *   - `modules/guest-shares.ts` names six requests that get past the prefix
 *     floor; every other route of the three PM routers (found by scanning their
 *     source, so a route added tomorrow is covered) stays 404 for a guest even
 *     when an item IS assigned to them;
 *   - five are then guarded per record (`middleware/guest-share.ts`):
 *     assigned → served, not assigned → the same 404, existing item or not;
 *     the sixth, the own list, lists by the caller's id and nothing else;
 *   - the allowlist and the guards cannot drift apart: every pattern is served
 *     by a route carrying the guard, and every route carrying the guard is on the
 *     allowlist.
 * The per-item behaviour with real data is in routes/pm/native.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { ModuleId } from "@prisma/client";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: false } };
});
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { mountModuleGates } from "../modules/module-mounts.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { MODULES, type AvailabilityConfig } from "../modules/module-registry.js";
import { GUEST_SHARES } from "../modules/guest-shares.js";
import { fullCatalogFeatures, type FeatureLevel } from "../services/access-catalog.js";
import { createPmNativeRouter } from "../routes/pm/native.js";
import { createPmAttachmentsRouter } from "../routes/pm/attachments.js";
import { createPmScheduleRouter } from "../routes/pm/schedule.js";
import { createPmImportExportRouter } from "../routes/pm/import-export.js";
import { isGuestShareGuard } from "../middleware/guest-share.js";
import type { AuthUser } from "../middleware/auth.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { readPackageFile } from "./helpers/test-paths.js";

type Role = "owner" | "admin" | "family" | "guest";

const PRINCIPAL: Record<Role, AuthUser> = {
  owner: { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" },
  admin: { id: "u-admin", username: "admin", displayName: "Admin", role: "admin" },
  family: { id: "u-member", username: "member", displayName: "Member", role: "family" },
  guest: { id: "u-guest", username: "guest", displayName: "Guest", role: "guest" },
};

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

const ALL_ON = {
  moduleSetting: { findMany: async () => MODULES.map((m) => ({ moduleId: m.id, enabled: true })) },
} as never;

function roleLess(tier: Role): EffectiveAccessResult {
  const features = fullCatalogFeatures(tier).map((f) => ({ moduleId: f.moduleId as ModuleId, level: f.level as FeatureLevel }));
  return {
    tier,
    features,
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
  };
}

type Method = "get" | "post" | "put" | "patch" | "delete";
interface RouteRow {
  method: Method;
  path: string;
}

function scanRoutes(...file: string[]): RouteRow[] {
  const source = readPackageFile("src", ...file);
  return [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => ({
    method: m[1] as Method,
    path: m[2],
  }));
}

const mountedAt = (path: string): string => (path.startsWith("/api/") ? path : `/api${path}`);
const concrete = (path: string): string => mountedAt(path).replace(/:[A-Za-z]+/g, "x");

/** Every PM route family, including attachments, planning, schedule and mobile. */
const PM_ROUTES: RouteRow[] = [
  ...scanRoutes("routes", "pm", "native.ts"),
  ...scanRoutes("routes", "pm", "relations.ts"),
  ...scanRoutes("routes", "pm", "attachments.ts"),
  ...scanRoutes("routes", "pm", "planning.ts"),
  ...scanRoutes("routes", "pm", "schedule.ts"),
  ...scanRoutes("routes", "pm", "import-export.ts"),
  ...scanRoutes("routes", "mobile", "pm.ts"),
];

/** The six requests a guest may make, as `METHOD /registered/path`. */
const SHARED_KEYS = [
  "GET /pm/work-items/:id",
  "GET /pm/work-items/:id/comments",
  "POST /pm/work-items/:id/comments",
  "POST /pm/work-items/:id/transition",
  "GET /pm/projects/:id/states",
  "GET /pm/assigned-to-me",
] as const;
/** The one of the six with no record to check: it lists the caller's own. */
const OWN_LIST = "GET /pm/assigned-to-me";
const key = (r: RouteRow): string => `${r.method.toUpperCase()} ${r.path}`;

const findFirst = vi.fn();
const findMany = vi.fn();
const count = vi.fn();
const prisma = { pmWorkItemAssignee: { findFirst }, pmWorkItem: { findMany, count } } as never;

function appAs(role: Role): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = PRINCIPAL[role];
    next();
  });
  mountModuleGates(app, createModuleGate(ALL_ON, CFG, 0), async () => roleLess(role));
  app.use("/api", createPmNativeRouter(prisma));
  // WARP-1505 — the attachment routes sit under the same prefix, so the same
  // floor answers a guest 404 for them; a file is never part of what assigning
  // a work item to a guest shares.
  app.use("/api", createPmAttachmentsRouter(prisma));
  // Timeline and My Work are not guest shares either: the gates refuse them
  // before a handler or database read runs.
  app.use("/api", createPmScheduleRouter(prisma));
  app.use("/api", createPmImportExportRouter(prisma));
  // A handler that clears every gate and then meets a prisma double with no PM
  // models fails inside itself: anything but the gates' own 404 is "admitted".
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "handler_error" });
  });
  return app;
}

const refused = (res: { status: number; body?: { error?: string; module?: string } }): boolean =>
  res.status === 404 && res.body?.error === "module_disabled" && res.body?.module === "projects";

async function probe(app: Express, routes: RouteRow[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const r of routes) {
    const res = await request(app)[r.method](concrete(r.path)).send({});
    out.set(key(r), refused(res));
  }
  return out;
}

beforeEach(() => {
  findFirst.mockReset();
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  count.mockReset();
  count.mockResolvedValue(0);
});

describe("the allowlist and the per-record guards cannot drift apart", () => {
  const native = createPmNativeRouter(prisma) as unknown as {
    stack: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
    }>;
  };
  const routes = native.stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods)
          .filter((m) => layer.route!.methods[m])
          .map((m) => ({
            key: `${m.toUpperCase()} ${layer.route!.path}`,
            method: m.toUpperCase(),
            path: layer.route!.path,
            guarded: layer.route!.stack.some((h) => isGuestShareGuard(h.handle)),
          }))
      : [],
  );

  it("scans the real routers (never a pass over an empty list)", () => {
    expect(PM_ROUTES.length).toBeGreaterThanOrEqual(30);
    expect(routes.length).toBeGreaterThanOrEqual(25);
  });

  it("the routes carrying a guest share guard are exactly the six", () => {
    expect(routes.filter((r) => r.guarded).map((r) => r.key).sort()).toEqual([...SHARED_KEYS].sort());
  });

  it("every allowlisted pattern is served by a guarded route, and every guarded route is on the allowlist", () => {
    const shares = GUEST_SHARES.projects ?? [];
    expect(shares).toHaveLength(SHARED_KEYS.length);
    for (const share of shares) {
      const serving = routes.filter((r) => r.method === share.method && share.path.test(concrete(r.path).toLowerCase()));
      expect(serving.length, String(share.path)).toBeGreaterThan(0);
      for (const r of serving) expect(r.guarded, `${r.key} is on the allowlist but carries no guard`).toBe(true);
    }
    for (const r of routes.filter((x) => x.guarded)) {
      const listed = shares.some((s) => s.method === r.method && s.path.test(concrete(r.path).toLowerCase()));
      expect(listed, `${r.key} carries a guard but is not on the allowlist`).toBe(true);
    }
  });

  it("the allowlist is for Projects alone: no other module lets a guest past its floor", () => {
    expect(Object.keys(GUEST_SHARES)).toEqual(["projects"]);
  });
});

describe("a guest to whom an item IS assigned: exactly six requests get through", () => {
  it("every other route of the PM routers stays 404 module_disabled", async () => {
    findFirst.mockResolvedValue({ id: "as-1" }); // "assigned" for any item or project
    const out = await probe(appAs("guest"), PM_ROUTES);
    const admitted = [...out.entries()].filter(([, isRefused]) => !isRefused).map(([k]) => k);
    expect(admitted.sort()).toEqual([...SHARED_KEYS].sort());
    // the per-record lookups were made with the guest's own id
    expect(findFirst).toHaveBeenCalled();
    for (const [args] of findFirst.mock.calls) {
      expect(args.where.userId).toBe("u-guest");
    }
  });

  it("the list, the board, the search, the activity feed and the relations are closed to them", async () => {
    findFirst.mockResolvedValue({ id: "as-1" });
    const app = appAs("guest");
    for (const path of [
      "/api/pm/projects",
      "/api/pm/summary",
      "/api/pm/workspaces",
      "/api/pm/work-items",
      "/api/pm/projects/p1/work-items",
      "/api/pm/work-items/w1/activity",
      "/api/pm/work-items/w1/relations",
      "/api/pm/projects/p1/labels",
      "/api/mobile/pm/work-items/w1",
    ]) {
      expect(refused(await request(app).get(path)), path).toBe(true);
    }
    // and no write but a comment and a state move
    for (const [method, path] of [
      ["patch", "/api/pm/work-items/w1"],
      ["delete", "/api/pm/work-items/w1"],
      ["post", "/api/pm/projects/p1/work-items"],
      ["post", "/api/pm/projects"],
    ] as const) {
      expect(refused(await request(app)[method](path).send({})), `${method} ${path}`).toBe(true);
    }
  });
});

describe("a guest to whom the item is NOT assigned: the same 404 on all five, exists or not", () => {
  it("is refused on every route but their own (empty) list", async () => {
    findFirst.mockResolvedValue(null);
    const out = await probe(appAs("guest"), PM_ROUTES);
    const admitted = [...out.entries()].filter(([, isRefused]) => !isRefused).map(([k]) => k);
    expect(admitted).toEqual([OWN_LIST]);
  });

  it("the own list asks for the caller's id, whatever the query names (WARP-3407)", async () => {
    const res = await request(appAs("guest")).get("/api/pm/assigned-to-me?assignee=u-owner&userId=u-owner");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ work_items: [], nextCursor: null, total: 0 });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ isArchived: false, assignees: { some: { userId: "u-guest" } }, project: { kind: "PROJECT" } });
    // WARP-3371 — the `total` is counted over the SAME caller-pinned filter, so
    // the count can never reveal how many items someone else was assigned.
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0][0].where).toEqual({ isArchived: false, assignees: { some: { userId: "u-guest" } }, project: { kind: "PROJECT" } });
  });

  it("asks for the item by the guest's id: the item routes by workItemId, the state list by the project", async () => {
    findFirst.mockResolvedValue(null);
    const app = appAs("guest");
    await request(app).get("/api/pm/work-items/w-42");
    expect(findFirst).toHaveBeenLastCalledWith({ where: { workItemId: "w-42", userId: "u-guest" }, select: { id: true } });
    await request(app).get("/api/pm/projects/p-7/states");
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { userId: "u-guest", workItem: { projectId: "p-7" } },
      select: { id: true },
    });
  });

  it("a lookup that throws is not an admission (fails closed, not open)", async () => {
    findFirst.mockRejectedValue(new Error("db down"));
    const res = await request(appAs("guest")).get("/api/pm/work-items/w-42");
    expect(refused(res)).toBe(false);
    expect(res.status).toBe(500);
  });
});

describe("everyone else is untouched", () => {
  it.each(["family", "admin", "owner"] as const)("a %s reaches every route, and no per-record lookup is made", async (role) => {
    const out = await probe(appAs(role), PM_ROUTES);
    expect([...out.entries()].filter(([, r]) => r).map(([k]) => k)).toEqual([]);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
