/**
 * ADR-055 (P4a), brief §11.2 — the boot-time assertion that fails loudly if the
 * doors module is reachable-but-unwired.
 *
 * "Droplet has shipped features that were built, merged, tested and dark,
 * because the descriptor was written and one of the lists downstream of it was
 * not. The company brain is the standing example: built, and in no deploy
 * file. Every feature that shipped dark would have been caught by a single
 * startup check that asserts *I am registered where I claim to be*."
 *
 * This is that check. It runs once, from index.ts, after `createApp` and before
 * the server listens, and:
 *
 *   · with DOORS_ENABLED OFF, asserts the module is ABSENT — the registry must
 *     not be serving it. (Off is the shipped state, so this is the assertion
 *     that runs on nearly every box, and the one that stops "dark" from
 *     quietly meaning "half on".)
 *   · with DOORS_ENABLED ON, asserts every list the brief's §11.2 checklist
 *     names that lives in THIS repo: the registry entry (present, available,
 *     on its prefix), the per-person grant (FEATURE_GATED_MODULES and the
 *     access catalog — "an empty grant set is a deny"), the routes (mounted,
 *     behind the module gates, and before any catch-all path param), the two
 *     tools (registered, claimed by a module, and their routes mounted), the
 *     retention job, and — in the database — the two tables and BOTH triggers
 *     (a box that has the tables but not the append-only trigger has evidence
 *     anything could rewrite).
 *
 * It reports EVERY problem at once and throws one `DoorsWiringError`: a boot
 * that shows one missing list per restart is how a gap outlives a deploy. The
 * items of §11.2 that live outside this repo's runtime — the compose service,
 * the box's generated env, the nav entries — are not checkable here and are
 * not pretended to be: there is no compose service (no `services/access-
 * control/` yet) and no nav entry (no page until P4b). The "/access health row
 * on the panel" waits for that page.
 */
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import { TOOLS, TOOL_ROUTES } from "@droplet/tools-core";
import type { ToolRouteEntry } from "@droplet/tools-core";
import { FEATURE_GATED_MODULES } from "../modules/module-mounts.js";
import { MODULE_BY_ID, type AvailabilityConfig, type ModuleDef } from "../modules/module-registry.js";
import { OWNERS_BY_DOMAIN, isGateableModuleId } from "./access-catalog.js";
import { createDoorsRouter } from "../routes/doors.js";
import { doorsRetentionRegistered } from "./doors.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("doors-wiring");

export class DoorsWiringError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`doors is enabled (DOORS_ENABLED) but not wired:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "DoorsWiringError";
  }
}

/**
 * Where the assertion reads each list. Every field defaults to the real thing;
 * a test swaps one to show that exactly that list going missing is caught.
 */
export interface DoorsWiringSources {
  moduleById?: ReadonlyMap<string, ModuleDef>;
  featureGated?: ReadonlySet<string>;
  isGateable?: (id: string) => boolean;
  tools?: ReadonlyMap<string, { requiresWrite: boolean; requiresConfirmation: boolean }>;
  ownersByDomain?: ReadonlyMap<string, readonly string[]>;
  toolRoutes?: readonly ToolRouteEntry[];
}

export interface DoorsWiringInput {
  app: Express;
  config: AvailabilityConfig;
  prisma: Pick<PrismaClient, "$queryRaw">;
}

// ── the Express router stack (Express 4) ──────────────────────────────────

interface StackLayer {
  name?: string;
  regexp?: RegExp & { fast_slash?: boolean };
  handle?: { stack?: StackLayer[] };
  route?: { path?: unknown; methods?: Record<string, boolean> };
}

function stackOf(app: Express): StackLayer[] | null {
  const router = (app as unknown as { _router?: { stack?: StackLayer[] } })._router;
  return Array.isArray(router?.stack) ? router!.stack! : null;
}

/** A layer that is a mounted Router, with the routes it declares. */
function routesOfRouter(layer: StackLayer): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const inner of layer.handle?.stack ?? []) {
    const route = inner.route;
    if (!route || typeof route.path !== "string") continue;
    for (const [method, on] of Object.entries(route.methods ?? {})) {
      if (on) out.push({ method: method.toUpperCase(), path: route.path });
    }
  }
  return out;
}

const isRouterLayer = (l: StackLayer) => l.name === "router" && Array.isArray(l.handle?.stack);

/** A route path that would match `/api/doors` for any `doors` — a param or a wildcard at the top level. */
const CATCH_ALL = /^\/(:|\*)|^\*$/;

function mountedAtApi(layer: StackLayer): boolean {
  return layer.regexp?.test("/api/doors") === true;
}

/** Every route mounted at `/api`, as `METHOD /api/<path>`. */
function mountedApiRoutes(stack: StackLayer[]): Set<string> {
  const set = new Set<string>();
  for (const layer of stack) {
    if (!isRouterLayer(layer) || !mountedAtApi(layer)) continue;
    for (const r of routesOfRouter(layer)) set.add(`${r.method} /api${r.path}`);
  }
  return set;
}

// ── the database ──────────────────────────────────────────────────────────

interface DbFacts {
  point: boolean;
  event: boolean;
  append_only: boolean;
  derived_guard: boolean;
}

async function readDbFacts(prisma: Pick<PrismaClient, "$queryRaw">): Promise<DbFacts> {
  const rows = await prisma.$queryRaw<DbFacts[]>`
    SELECT
      to_regclass('"AccessPoint"') IS NOT NULL AS point,
      to_regclass('"AccessEvent"') IS NOT NULL AS event,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'AccessEvent_append_only' AND NOT tgisinternal
              AND tgrelid = to_regclass('"AccessEvent"')) AS append_only,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'AccessEvent_derived_guard' AND NOT tgisinternal
              AND tgrelid = to_regclass('"AccessEvent"')) AS derived_guard`;
  const row = rows[0];
  if (!row) throw new Error("the catalog query returned no row");
  return row;
}

// ── the assertion ─────────────────────────────────────────────────────────

const DOORS_TOOL_NAMES = ["doors_list", "doors_recent_events"] as const;

export async function assertDoorsWired(
  input: DoorsWiringInput,
  sources: DoorsWiringSources = {},
): Promise<{ state: "absent" | "wired" }> {
  const moduleById = sources.moduleById ?? MODULE_BY_ID;
  const def = moduleById.get("doors");
  const problems: string[] = [];

  // ── off: the module must be absent ────────────────────────────────────
  if (!input.config.DOORS_ENABLED) {
    // "off" is the shipped state; here the failure is the module being SERVED.
    if (def?.available(input.config)) {
      throw new DoorsWiringError(["the module registry marks `doors` available although DOORS_ENABLED is off"]);
    }
    return { state: "absent" };
  }

  // ── on: the registry ──────────────────────────────────────────────────
  if (!def) {
    problems.push("the module registry has no `doors` entry");
  } else {
    if (!def.available(input.config)) problems.push("`doors` is not available although DOORS_ENABLED is on (its `available` does not read the flag)");
    if (def.routePrefixes.length !== 1 || def.routePrefixes[0] !== "/api/doors") {
      problems.push(`the registry gives \`doors\` the route prefix ${JSON.stringify(def.routePrefixes)}, not ["/api/doors"]`);
    }
    if (!def.toolDomains.includes("doors")) problems.push("the registry entry does not claim the `doors` tool domain");
  }

  // ── on: the per-person grant ──────────────────────────────────────────
  if (!(sources.featureGated ?? FEATURE_GATED_MODULES).has("doors")) {
    problems.push("`doors` is not in FEATURE_GATED_MODULES, so a role narrowed away from it still reaches /api/doors");
  }
  if (!(sources.isGateable ?? isGateableModuleId)("doors")) {
    problems.push("`doors` has no ladder in the access catalog, so no role can be granted it (an empty grant set is a deny)");
  }

  // ── on: the routes, from a fresh router — the source of truth for what should exist ─
  const stack = stackOf(input.app);
  if (!stack) {
    problems.push("could not read the Express router stack, so the doors routes cannot be confirmed mounted");
  } else {
    const mounted = mountedApiRoutes(stack);
    const expected = routesOfRouter({ handle: createDoorsRouter({} as PrismaClient) as unknown as StackLayer["handle"] });
    for (const r of expected) {
      if (!mounted.has(`${r.method} /api${r.path}`)) problems.push(`${r.method} /api${r.path} is not mounted`);
    }

    const routerIndex = stack.findIndex(
      (l) => isRouterLayer(l) && mountedAtApi(l) && routesOfRouter(l).some((r) => r.path === "/doors" && r.method === "GET"),
    );
    if (routerIndex >= 0) {
      const before = stack.slice(0, routerIndex);
      // Before any catch-all path param: `/api/:x` above the router would answer
      // /api/doors with something else, and every doors test would still pass.
      for (const layer of before) {
        const swallowing = layer.route
          ? typeof layer.route.path === "string" && CATCH_ALL.test(layer.route.path)
          : isRouterLayer(layer) && mountedAtApi(layer) && routesOfRouter(layer).some((r) => CATCH_ALL.test(r.path));
        if (swallowing) {
          problems.push("a catch-all path param is mounted before the doors router and would answer /api/doors first");
          break;
        }
      }
      // The module gates: one prefix-scoped (non-global) layer per gate in front of the router.
      const wantedGates = (sources.featureGated ?? FEATURE_GATED_MODULES).has("doors") ? 2 : 1;
      const gates = before.filter(
        (l) => !l.route && !isRouterLayer(l) && l.regexp?.fast_slash !== true && l.regexp?.test("/api/doors/events") === true,
      );
      if (gates.length < wantedGates) {
        problems.push(
          `only ${gates.length} of ${wantedGates} module gates are mounted in front of /api/doors (mountModuleGates must run before the router)`,
        );
      }
    }
  }

  // ── on: the tools ─────────────────────────────────────────────────────
  const tools = sources.tools ?? TOOLS;
  for (const name of DOORS_TOOL_NAMES) {
    const t = tools.get(name);
    if (!t) problems.push(`${name} is not registered in @droplet/tools-core`);
    else if (t.requiresWrite || t.requiresConfirmation) problems.push(`${name} is registered as a write or confirming tool (§11.5)`);
  }
  if (!(sources.ownersByDomain ?? OWNERS_BY_DOMAIN).get("doors")?.includes("doors")) {
    problems.push("the tool domain `doors` is claimed by no module (its tools would reach nobody who holds a role)");
  }
  if (stack) {
    const mounted = mountedApiRoutes(stack);
    for (const entry of sources.toolRoutes ?? TOOL_ROUTES) {
      if (!entry.tool.startsWith("doors_")) continue;
      for (const hop of entry.hops) {
        const shape = hop.pathPattern.replace(/:[^/]+/g, ":param");
        const found = [...mounted].some((m) => m.replace(/:[^/ ]+/g, ":param") === `${hop.method.toUpperCase()} ${shape}`);
        if (!found) problems.push(`${entry.tool} dispatches ${hop.method.toUpperCase()} ${hop.pathPattern}, which is not mounted`);
      }
    }
  }

  // ── on: the retention job ─────────────────────────────────────────────
  if (!doorsRetentionRegistered()) {
    problems.push("the door event retention job is not registered (registerDoorsJobs must run before this check)");
  }

  // ── on: the migration ─────────────────────────────────────────────────
  try {
    const facts = await readDbFacts(input.prisma);
    if (!facts.point || !facts.event) {
      problems.push("the AccessPoint / AccessEvent tables do not exist — the doors migrations have not been applied");
    }
    if (facts.event && !facts.append_only) problems.push("the AccessEvent_append_only trigger is missing: door events could be rewritten or deleted");
    if (facts.event && !facts.derived_guard) problems.push("the AccessEvent_derived_guard trigger is missing: a forced-door alarm could be recorded for a door with no position source");
  } catch (err) {
    problems.push(`could not check the database: ${(err as Error).message}`);
  }

  if (problems.length > 0) {
    logger.error({ problems }, "doors is enabled but not wired");
    throw new DoorsWiringError(problems);
  }
  return { state: "wired" };
}
