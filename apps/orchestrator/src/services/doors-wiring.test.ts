/**
 * ADR-055 (P4a), brief §11.2 — the boot-time "I am registered where I claim to
 * be" assertion.
 *
 * "Droplet has shipped features that were built, merged, tested and dark,
 * because the descriptor was written and one of the lists downstream of it was
 * not." Every case below is one of those lists going missing on a box that
 * turned the module ON — and each must fail LOUDLY, by name, at boot, rather
 * than leave a doors surface that is reachable-but-unwired.
 *
 * The healthy app is built the way app.ts builds it: `mountModuleGates` (the
 * real one, off the real registry) in front of the real router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { mountModuleGates } from "../modules/module-mounts.js";
import { MODULE_BY_ID, MODULES, type AvailabilityConfig } from "../modules/module-registry.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { createDoorsRouter } from "../routes/doors.js";
import {
  DoorsWiringError,
  assertDoorsWired,
  type DoorsWiringSources,
} from "./doors-wiring.js";
import { registerDoorsJobs, _resetDoorsJobsForTests } from "./doors.service.js";

const ON = { DOORS_ENABLED: true } as AvailabilityConfig;
const OFF = { DOORS_ENABLED: false } as AvailabilityConfig;

/** A Prisma stub that says the migration applied, with both triggers. */
function db(over: Partial<{ point: boolean; event: boolean; append_only: boolean; derived_guard: boolean; purge_fn: boolean }> = {}) {
  const $queryRaw = vi.fn(async () => [{ point: true, event: true, append_only: true, derived_guard: true, purge_fn: true, ...over }]);
  return { $queryRaw } as unknown as PrismaClient & { $queryRaw: typeof $queryRaw };
}

const gateStub = () =>
  createModuleGate(
    { moduleSetting: { findMany: async () => [] } } as never,
    { ...ON } as AvailabilityConfig,
    0,
  );

/** app.ts's shape: identity, module gates, then routers — with knobs to break each part. */
function buildApp(
  opts: {
    gates?: boolean;
    router?: boolean;
    catchAllBefore?: boolean;
    catchAllAfter?: boolean;
  } = {},
): Express {
  const { gates = true, router = true, catchAllBefore = false, catchAllAfter = true } = opts;
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => next());
  if (gates) mountModuleGates(app, gateStub(), (async () => null) as never);
  if (catchAllBefore) {
    const swallow = express.Router();
    swallow.get("/:anything", (_req, res) => res.json({ swallowed: true }));
    app.use("/api", swallow);
  }
  if (router) app.use("/api", createDoorsRouter({} as PrismaClient));
  if (catchAllAfter) {
    const later = express.Router();
    later.get("/:anything", (_req, res) => res.json({ ok: true }));
    app.use("/api", later);
  }
  return app;
}

function registerJobs() {
  registerDoorsJobs({ scheduleCron: vi.fn() } as never, {} as PrismaClient, 365);
}

beforeEach(() => {
  _resetDoorsJobsForTests();
});

async function problemsOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(DoorsWiringError);
    return [...(err as DoorsWiringError).problems];
  }
  return [];
}

describe("DOORS_ENABLED off — the module is absent, and that is asserted, not assumed", () => {
  it("returns 'absent' and touches nothing: no database query, no route walk", async () => {
    const prisma = db();
    const out = await assertDoorsWired({ app: express(), config: OFF, prisma });
    expect(out).toEqual({ state: "absent" });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("fails loudly if the registry would still serve the module with the flag off", async () => {
    const leaky: DoorsWiringSources = {
      moduleById: new Map([
        ["doors", { ...MODULE_BY_ID.get("doors")!, available: () => true }],
      ]) as never,
    };
    const problems = await problemsOf(assertDoorsWired({ app: express(), config: OFF, prisma: db() }, leaky));
    expect(problems.join("\n")).toMatch(/available.*DOORS_ENABLED is off/i);
  });
});

describe("DOORS_ENABLED on — every list downstream of the descriptor", () => {
  it("passes on a fully wired box, and says so", async () => {
    registerJobs();
    const out = await assertDoorsWired({ app: buildApp(), config: ON, prisma: db() });
    expect(out).toEqual({ state: "wired" });
  });

  it("the module missing from the registry", async () => {
    registerJobs();
    const p = await problemsOf(
      assertDoorsWired({ app: buildApp(), config: ON, prisma: db() }, { moduleById: new Map() as never }),
    );
    expect(p.join("\n")).toMatch(/module registry has no `doors`/);
  });

  it("the module registered but unavailable even though the flag is on", async () => {
    registerJobs();
    const dead = new Map([["doors", { ...MODULE_BY_ID.get("doors")!, available: () => false }]]);
    const p = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma: db() }, { moduleById: dead as never }));
    expect(p.join("\n")).toMatch(/not available although DOORS_ENABLED is on/);
  });

  it("the module registered on the wrong prefix", async () => {
    registerJobs();
    const wrong = new Map([["doors", { ...MODULE_BY_ID.get("doors")!, routePrefixes: ["/api/access"] }]]);
    const p = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma: db() }, { moduleById: wrong as never }));
    expect(p.join("\n")).toMatch(/route prefix/);
  });

  it("no per-person grant: doors not in FEATURE_GATED_MODULES, or not in the access catalog", async () => {
    registerJobs();
    const p1 = await problemsOf(
      assertDoorsWired({ app: buildApp(), config: ON, prisma: db() }, { featureGated: new Set() }),
    );
    expect(p1.join("\n")).toMatch(/FEATURE_GATED_MODULES/);
    const p2 = await problemsOf(
      assertDoorsWired({ app: buildApp(), config: ON, prisma: db() }, { isGateable: () => false }),
    );
    expect(p2.join("\n")).toMatch(/access catalog/);
  });

  it("the routes never mounted", async () => {
    registerJobs();
    const p = await problemsOf(assertDoorsWired({ app: buildApp({ router: false }), config: ON, prisma: db() }));
    expect(p.join("\n")).toMatch(/GET \/api\/doors is not mounted/);
    expect(p.join("\n")).toMatch(/POST \/api\/doors\/:id\/retire is not mounted/);
  });

  it("mounted AFTER a catch-all path param that swallows it (§11.2: mounted before any catch-all)", async () => {
    registerJobs();
    const p = await problemsOf(assertDoorsWired({ app: buildApp({ catchAllBefore: true }), config: ON, prisma: db() }));
    expect(p.join("\n")).toMatch(/catch-all/i);
  });

  it("a catch-all AFTER the router is fine — that is where they belong", async () => {
    registerJobs();
    await expect(assertDoorsWired({ app: buildApp({ catchAllAfter: true }), config: ON, prisma: db() })).resolves.toEqual({
      state: "wired",
    });
  });

  it("the module gates never mounted in front of the router — an ungated /api/doors", async () => {
    registerJobs();
    const p = await problemsOf(assertDoorsWired({ app: buildApp({ gates: false }), config: ON, prisma: db() }));
    expect(p.join("\n")).toMatch(/module gates/i);
  });

  it("the retention job never registered", async () => {
    const p = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma: db() }));
    expect(p.join("\n")).toMatch(/retention job/);
  });

  it("the migration never applied: tables missing", async () => {
    registerJobs();
    const p = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma: db({ point: false, event: false }) }));
    expect(p.join("\n")).toMatch(/AccessPoint.*migration/i);
  });

  it("the append-only trigger missing — evidence that anything could rewrite", async () => {
    registerJobs();
    const p = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma: db({ append_only: false }) }));
    expect(p.join("\n")).toMatch(/AccessEvent_append_only/);
    const p2 = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma: db({ derived_guard: false }) }));
    expect(p2.join("\n")).toMatch(/AccessEvent_derived_guard/);
  });

  it("the retention function missing — the purge job would have nothing to call", async () => {
    registerJobs();
    const p = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma: db({ purge_fn: false }) }));
    expect(p.join("\n")).toMatch(/access_event_purge/);
  });

  it("an unreachable database is a failure, not a pass", async () => {
    registerJobs();
    const prisma = { $queryRaw: vi.fn(async () => { throw new Error("connection refused"); }) } as unknown as PrismaClient;
    const p = await problemsOf(assertDoorsWired({ app: buildApp(), config: ON, prisma }));
    expect(p.join("\n")).toMatch(/could not check the database/i);
  });

  it("reports EVERY problem at once, so one boot shows the whole gap", async () => {
    const p = await problemsOf(
      assertDoorsWired(
        { app: buildApp({ router: false, gates: false }), config: ON, prisma: db({ point: false }) },
        { featureGated: new Set() },
      ),
    );
    expect(p.length).toBeGreaterThanOrEqual(4);
  });

  it("the error message names the surface and is one readable block", async () => {
    try {
      await assertDoorsWired({ app: buildApp({ router: false }), config: ON, prisma: db() });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/^doors is enabled \(DOORS_ENABLED\) but not wired:/);
    }
  });
});

describe("the registry still describes what the assertion checks", () => {
  it("doors is in MODULES with the prefix the routes use", () => {
    expect(MODULES.find((m) => m.id === "doors")?.routePrefixes).toEqual(["/api/doors"]);
  });
});
