/**
 * WARP-2972 — `GET /api/modules/tool-verdict`: the verdict the mcp-server asks
 * for before it lists or dispatches a tool.
 *
 * The callers are the mcp-server's `_service:mcp` principal and the owner (with
 * AUTH_ENABLED=false every request is the synthetic `dev` owner, and the
 * mcp-server must still be answered). The body says which modules are off for a
 * named person, which is not something any other principal needs from this
 * route (`GET /api/modules` and `/api/capabilities` are theirs).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { FAIL_CLOSED_MODULE_VERDICT } from "@droplet/tools-core";
import { createModulesRouter } from "./modules.routes.js";
import {
  _setToolModuleVerdictForTests,
  type ModuleVerdictResolver,
} from "../services/tool-module-verdict.service.js";
import type { AuthUser } from "../middleware/auth.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";

const GATE = {
  requireModuleEnabled: () => (_r: Request, _s: Response, n: NextFunction) => n(),
  effectiveIds: async () => new Set(),
  invalidate: vi.fn(),
};

const MCP: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "mcp", role: "service" };
const VOICE: AuthUser = { id: "_service:voice", username: "_service:voice", displayName: "voice", role: "service" };
const OWNER: AuthUser = { id: "u-owner", username: "olive", displayName: "Olive", role: "owner" };
const ADMIN: AuthUser = { id: "u-admin", username: "ada", displayName: "Ada", role: "admin" };
const FAMILY: AuthUser = { id: "u-fam", username: "fay", displayName: "Fay", role: "family" };

function makeApp(user: AuthUser | null) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });
  app.use("/api", createModulesRouter({} as never, {} as AvailabilityConfig, GATE as never));
  return app;
}

let resolver: ReturnType<typeof vi.fn<ModuleVerdictResolver>>;

beforeEach(() => {
  resolver = vi.fn<ModuleVerdictResolver>(async () => ({ withheldDomains: new Set(["email", "cameras"]) }));
  _setToolModuleVerdictForTests(resolver);
});

describe("GET /api/modules/tool-verdict", () => {
  it("answers the mcp-server with the withheld domains, sorted", async () => {
    const res = await request(makeApp(MCP)).get("/api/modules/tool-verdict");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ withheldDomains: ["cameras", "email"] });
  });

  it("asks about the person the mcp-server names in X-Nextcloud-User", async () => {
    await request(makeApp(MCP)).get("/api/modules/tool-verdict").set("X-Nextcloud-User", "carol");
    expect(resolver).toHaveBeenCalledWith("carol");
  });

  it("asks about nobody (the box) when no person is named", async () => {
    await request(makeApp(MCP)).get("/api/modules/tool-verdict");
    expect(resolver).toHaveBeenCalledWith(null);
  });

  it("is never cached by an intermediary", async () => {
    const res = await request(makeApp(MCP)).get("/api/modules/tool-verdict");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("carries a fail-closed verdict through as data, not as an error", async () => {
    resolver.mockResolvedValue(FAIL_CLOSED_MODULE_VERDICT);
    const res = await request(makeApp(MCP)).get("/api/modules/tool-verdict").set("X-Nextcloud-User", "ghost");
    expect(res.status).toBe(200);
    expect(res.body.withheldDomains).toContain("cameras");
    expect(res.body.withheldDomains).not.toContain("system");
  });

  it("admits an owner: with AUTH_ENABLED=false every request is the synthetic `dev` owner, and the mcp-server must still be answered", async () => {
    const res = await request(makeApp(OWNER)).get("/api/modules/tool-verdict");
    expect(res.status).toBe(200);
  });

  it.each([
    ["an admin", ADMIN],
    ["a family member", FAMILY],
    ["another service principal", VOICE],
  ])("refuses %s", async (_label, user) => {
    const res = await request(makeApp(user)).get("/api/modules/tool-verdict");
    expect(res.status).toBe(403);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses a request with no principal", async () => {
    const res = await request(makeApp(null)).get("/api/modules/tool-verdict");
    expect(res.status).toBe(403);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("does not shadow GET /api/modules", async () => {
    // A path-shape guard: the verdict route must not be swallowed by, or swallow, /modules.
    const res = await request(makeApp(MCP)).get("/api/modules/tool-verdict");
    expect(res.body).not.toHaveProperty("modules");
  });
});
