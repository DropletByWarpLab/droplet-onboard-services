/**
 * GET /api/capabilities (WARP-1154/WARP-1155, WARP-1306) — the
 * module-capability probe every authenticated principal may read. Drives the
 * dashboard's Projects nav/route gating, so the contract is pinned here:
 *
 *   - 401 without an authenticated principal.
 *   - `projects` mirrors the module-toggles EFFECTIVE state (WARP-1306): the
 *     registry ships the projects module `defaultEnabled: false`, and the
 *     module gate 404s `/api/pm/projects` accordingly — a probe that kept
 *     answering a hardcoded `true` let the dashboard offer a New-project
 *     dialog whose POST could only die on `module_disabled`.
 *       - no ModuleSetting row  → registry default → { projects: false }
 *       - row enabled: true     → { projects: true } for every human role AND
 *         the service principal (the flag is role-independent)
 *       - row enabled: false    → { projects: false }
 *   - Fail CLOSED on an enablement read error — the same posture as the
 *     module gate (which would 404 the PM routes anyway); answering `true`
 *     while the gate answers 404 recreates the WARP-1306 dead-end.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import type { PrismaClient } from "@prisma/client";

import { createCapabilitiesRouter } from "./capabilities.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";

/** Availability config the projects module ignores (available: () => true);
 *  empty strings keep every URL-gated module unavailable, which is irrelevant
 *  to the flag under test. */
const CFG: AvailabilityConfig = {
  AI_GATEWAY_URL: "",
  FILE_INDEXER_URL: "",
  NEXTCLOUD_URL: "",
  DOCS_ENABLED: "",
  DOCS_INTERNAL_URL: "",
  SERVICE_TOKEN_EMAIL: "",
  SERVICE_TOKEN_VOICE: "",
  FRIGATE_URL: "",
  DROPLET_MATTER_SERVICE_URL: "",
  ROUTING_SERVICE_URL: "",
  SWITCH_SERVICE_URL: "",
};

function fakePrisma(
  rows: Array<{ moduleId: string; enabled: boolean }> | Error,
): PrismaClient {
  return {
    moduleSetting: {
      findMany: async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      },
    },
  } as unknown as PrismaClient;
}

function appWithUser(
  user: { role: string } | undefined,
  rows: Array<{ moduleId: string; enabled: boolean }> | Error = [],
) {
  const app = express();
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: { role: string } }).user = user;
    next();
  });
  app.use("/api", createCapabilitiesRouter(fakePrisma(rows), CFG));
  return app;
}

describe("GET /api/capabilities", () => {
  it("401s without an authenticated principal", async () => {
    const res = await request(appWithUser(undefined)).get("/api/capabilities");
    expect(res.status).toBe(401);
  });

  it("answers false for every module with no enablement row (registry default)", async () => {
    const res = await request(appWithUser({ role: "owner" }, [])).get(
      "/api/capabilities",
    );
    expect(res.status).toBe(200);
    // WARP-2545 — `crm` and `contacts` join the contract here. They are
    // `defaultEnabled: false` in the registry, so a fresh box answers false
    // for both, and the dashboard renders the Projects surface it always had.
    expect(res.body).toEqual({ projects: false, crm: false, contacts: false });
  });

  it.each(["owner", "admin", "family", "guest", "service"])(
    "answers projects:true for role %s once the module is enabled",
    async (role) => {
      const res = await request(
        appWithUser({ role }, [{ moduleId: "projects", enabled: true }]),
      ).get("/api/capabilities");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ projects: true, crm: false, contacts: false });
    },
  );

  it("answers projects:false when the module is explicitly disabled", async () => {
    const res = await request(
      appWithUser({ role: "owner" }, [{ moduleId: "projects", enabled: false }]),
    ).get("/api/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projects: false, crm: false, contacts: false });
  });

  it("answers crm:true with Projects OFF — the CRM has its own route now", async () => {
    // WARP-2558 (ADR-044) — this assertion is the INVERSE of what it pinned
    // under WARP-2545, and deliberately so.
    //
    // The CRM used to render as sub-tabs on the Projects page, so the registry
    // declared `requires: "projects"` and a Projects-off box could not serve
    // it. /customers is the CRM's own route, so that edge is gone and the
    // shape it forbade — Customers with no PM at all — is the shape of most
    // dental boxes.
    //
    // The route still must NOT re-derive any dependency of its own: whatever
    // edges exist belong to `satisfiedModuleIds` inside getEffectiveModuleIds,
    // and a second copy here is free to drift from the one the module gate
    // enforces. Mutation: write `crm = effective.has("crm") && projects` →
    // the first assertion below goes red.
    const crmOnProjectsOff = await request(
      appWithUser({ role: "owner" }, [
        { moduleId: "crm", enabled: true },
        { moduleId: "projects", enabled: false },
      ]),
    ).get("/api/capabilities");
    expect(crmOnProjectsOff.body).toEqual({ projects: false, crm: true, contacts: false });

    const bothOn = await request(
      appWithUser({ role: "owner" }, [
        { moduleId: "crm", enabled: true },
        { moduleId: "projects", enabled: true },
      ]),
    ).get("/api/capabilities");
    expect(bothOn.body).toEqual({ projects: true, crm: true, contacts: false });
  });

  it("answers contacts independently of the CRM", async () => {
    // Contacts is its own surface (WARP-2038) and works with the CRM off —
    // declaring a dependency it does not have would hide it for no reason.
    const res = await request(
      appWithUser({ role: "owner" }, [{ moduleId: "contacts", enabled: true }]),
    ).get("/api/capabilities");
    expect(res.body).toEqual({ projects: false, crm: false, contacts: true });
  });

  it("fails CLOSED for every flag when the enablement read errors — module-gate parity", async () => {
    const res = await request(
      appWithUser({ role: "owner" }, new Error("db down")),
    ).get("/api/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projects: false, crm: false, contacts: false });
  });

  it("allows brief private caching so the nav doesn't re-probe every mount", async () => {
    const res = await request(
      appWithUser({ role: "family" }, [{ moduleId: "projects", enabled: true }]),
    ).get("/api/capabilities");
    expect(res.headers["cache-control"]).toBe("private, max-age=30");
  });
});
