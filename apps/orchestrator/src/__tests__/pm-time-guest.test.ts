/**
 * WARP-3526 (ADR-069 WS-10) — an external guest gets NO part of time tracking.
 *
 * WARP-3369 shares ONE work item with a guest by assignment: they may read it,
 * read and write its comments and move its state, and see nothing else in
 * Projects. `modules/guest-shares.ts` names exactly six requests that get past
 * the `projects` tier floor, and not one of them is a worklog, a timer, a
 * timesheet or a report. Hours are a person's own business data — who spent how
 * long on what — and a guest assigned one task has no claim on anybody's week.
 *
 * Driven through the REAL mount (`mountModuleGates`, whose `projects` tier floor
 * refuses a guest on the whole of `/api/pm`) and the REAL time router, with a
 * prisma double that has no models at all: a request that clears the gates
 * meets the double and fails inside its own handler, so anything but the gates'
 * own 404 is "admitted". Routes are found by scanning the router's source, so a
 * route added tomorrow is covered the day it is added — the same discipline
 * guest-work-item-share.test.ts uses for the other three PM routers.
 *
 *   - every route of the time router is 404 module_disabled for a guest, even
 *     when an item IS assigned to them;
 *   - the guest allowlist has not grown to include one;
 *   - a member of the household is NOT refused, so the guest result above is the
 *     tier floor doing its job and not a router that refuses everybody.
 */
import { describe, it, expect, vi } from "vitest";
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
import { GUEST_SHARES, isGuestShared } from "../modules/guest-shares.js";
import { fullCatalogFeatures, type FeatureLevel } from "../services/access-catalog.js";
import { createPmTimeRouter } from "../routes/pm/time.js";
import type { AuthUser } from "../middleware/auth.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { readPackageFile } from "./helpers/test-paths.js";

type Role = "owner" | "family" | "guest";

const PRINCIPAL: Record<Role, AuthUser> = {
  owner: { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" },
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

function accessFor(tier: Role): EffectiveAccessResult {
  const features = fullCatalogFeatures(tier).map((f) => ({
    moduleId: f.moduleId as ModuleId,
    level: f.level as FeatureLevel,
  }));
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

/** Every route the time router registers, read out of its own source. */
const TIME_ROUTES: RouteRow[] = [
  ...readPackageFile("src", "routes", "pm", "time.ts").matchAll(
    /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g,
  ),
].map((m) => ({ method: m[1] as Method, path: m[2] }));

const concrete = (path: string): string => `/api${path}`.replace(/:[A-Za-z]+/g, "x");

function appAs(role: Role): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = PRINCIPAL[role];
    next();
  });
  mountModuleGates(app, createModuleGate(ALL_ON, CFG, 0), async () => accessFor(role));
  // No models on purpose — see the header.
  app.use("/api", createPmTimeRouter({} as never));
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "handler_error" });
  });
  return app;
}

const refused = (res: { status: number; body?: { error?: string; module?: string } }): boolean =>
  res.status === 404 && res.body?.error === "module_disabled" && res.body?.module === "projects";

describe("time tracking is closed to an external guest", () => {
  it("scans the real router (never a pass over an empty list)", () => {
    expect(TIME_ROUTES.length).toBeGreaterThanOrEqual(9);
    expect(TIME_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        "get /pm/work-items/:id/worklogs",
        "post /pm/work-items/:id/worklogs",
        "patch /pm/worklogs/:id",
        "delete /pm/worklogs/:id",
        "get /pm/timer",
        "post /pm/timer/start",
        "post /pm/timer/stop",
        "get /pm/timesheet",
        "get /pm/time/report",
      ]),
    );
  });

  it("every route is 404 module_disabled for a guest — reads and writes, the clock and the hours", async () => {
    const app = appAs("guest");
    const admitted: string[] = [];
    for (const r of TIME_ROUTES) {
      const res = await request(app)[r.method](concrete(r.path)).send({});
      if (!refused(res)) admitted.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(admitted).toEqual([]);
  });

  it("…and the CSV export and a worklog list on an item assigned to them are closed too", async () => {
    const app = appAs("guest");
    for (const path of [
      "/api/pm/time/report?from=2026-09-01&to=2026-09-30&format=csv",
      "/api/pm/work-items/w1/worklogs",
      "/api/pm/timesheet?userId=u-guest",
      "/api/pm/timer",
    ]) {
      expect(refused(await request(app).get(path)), path).toBe(true);
    }
  });

  it("the guest allowlist still names exactly the six work-item requests and not one time route", () => {
    const shares = GUEST_SHARES.projects ?? [];
    expect(shares).toHaveLength(6);
    for (const r of TIME_ROUTES) {
      const method = r.method.toUpperCase();
      expect(
        isGuestShared("projects", method, concrete(r.path)),
        `${method} ${r.path} must not be a guest share`,
      ).toBe(false);
    }
    expect(Object.keys(GUEST_SHARES)).toEqual(["projects"]);
  });

  it("is the tier floor, not a router that refuses everybody: a member and an owner reach the handlers", async () => {
    for (const role of ["family", "owner"] as const) {
      const app = appAs(role);
      const res = await request(app).get("/api/pm/timer");
      expect(refused(res), role).toBe(false);
      expect(res.status, role).toBe(500); // past the gates, into a handler with no database
    }
  });
});
