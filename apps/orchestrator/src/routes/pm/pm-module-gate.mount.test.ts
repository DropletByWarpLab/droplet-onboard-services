/**
 * WARP-1625 — module gates still miss routes. The standing invariant for the
 * `projects` module: every PM route sits behind its gate, and a route added
 * tomorrow cannot ship outside it without a red build.
 *
 * WARP-2875 found the gate covering `/api/pm/projects` and nothing else.
 * Work-items, workspaces, summary, states, labels, comments, activity and
 * relations all live BESIDE that sub-tree, so switching Projects off in
 * Settings kept serving most of the tracker. It moved the registry prefix to
 * `/api/pm` + `/api/mobile/pm`, which is the whole PM surface today. That was
 * an audit of the routes that existed on the day; nothing stops the next one.
 *
 * module-mounts.test.ts proves the gate against a hand-written list of stub
 * routes, and guest-company-data.test.ts against a regex over the router
 * SOURCE. Both protect only what somebody listed or a regex recognises. This
 * file reads the REAL routers:
 *
 *  1. The PM routers are mounted as app.ts mounts them (same bases, same
 *     order) behind the REAL `mountModuleGates`. A source pin on app.ts fails
 *     if that table drifts, or if another router registers PM routes.
 *  2. Each router's `router.stack` is ENUMERATED: every method + path it
 *     actually registers, not the ones anyone remembered. One that sits outside
 *     the registry's `projects` prefixes fails by name.
 *  3. Per route, a real HTTP request. Projects OFF: 404 `module_disabled`, so
 *     the gate ran before any handler and the database stub was never reached.
 *     Projects ON: the same request is NOT that answer — which is what makes
 *     the OFF assertion mean something. A URL no router matched would also
 *     "not be refused", so the ON case rejects that too.
 *
 * Only the edges are stubbed: a `ModuleGate` whose set is flipped by the test,
 * an effective-access resolver that never reads a database, and a Prisma
 * stand-in that rejects every call. The principal is an `owner`, so the
 * projects TIER floor passes; the floor is guest-company-data.test.ts's
 * subject, the module toggle is this file's.
 *
 * The route list is never written down here. When a PM route is added to
 * any listed router it is enumerated, and proved gated,
 * with no edit to this file.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ModuleId, PrismaClient } from "@prisma/client";

import { mountModuleGates } from "../../modules/module-mounts.js";
import { MODULES } from "../../modules/module-registry.js";
import type { ModuleGate } from "../../middleware/module-gate.js";
import type { EffectiveAccessResolver } from "../../middleware/feature-gate.js";
import type { AuthUser } from "../../middleware/auth.js";
import { packagePath } from "../../__tests__/helpers/test-paths.js";
import { createPmNativeRouter } from "./native.js";
import { createPmRelationsRouter } from "./relations.js";
import { createPmImportExportRouter } from "./import-export.js";
import { createPmPlanningRouter } from "./planning.js";
import { createPmInsightsRouter } from "./insights.js";
import { createPmTimeRouter } from "./time.js";
import { createPmWebhooksRouter } from "./webhooks.js";
import { createPmScheduleRouter } from "./schedule.js";
import { createPmDevelopmentRouter } from "./development.js";
import { createPmOpenApiRouter } from "./openapi.js";
import { createPmMobileRouter } from "../mobile/pm.js";

// ── the edges ───────────────────────────────────────────────────────────────

const OWNER: AuthUser = { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" };

/**
 * The workspace gate with its answer taken from a set the test flips. Status
 * and body are what middleware/module-gate.ts sends. Read per REQUEST, not at
 * mount time, so one app serves both the OFF and the ON assertions.
 */
const disabled = new Set<ModuleId>();
const GATE: ModuleGate = {
  requireModuleEnabled: (id) => (_req, res, next) => {
    if (disabled.has(id)) {
      res.status(404).json({ error: "module_disabled", module: id });
      return;
    }
    next();
  },
  effectiveIds: async () => new Set(MODULES.map((m) => m.id).filter((id) => !disabled.has(id))),
  invalidate: () => undefined,
};

/**
 * `projects` is not feature-gated (layer 2), on purpose. But `mountModuleGates`
 * mounts the OTHER modules' layer-2 gates in the same loop, so the resolver is
 * injected to keep all of them off the database. `null` = "no local user row,
 * nothing to narrow".
 */
const NO_NARROWING: EffectiveAccessResolver = async () => null;

/** Every `prisma.<model>.<method>(…)` the stub has been called with. */
const prismaCalls: string[] = [];

/**
 * A Prisma stand-in with no models: any call records itself and rejects. With
 * Projects OFF nothing may land here. With Projects ON a handler that reaches
 * it answers 500, which is fine — the only point is that the gate let it in.
 *
 * The rejection is created already-handled, so a service that builds two
 * queries and awaits one cannot leave an unhandled rejection to fail the run.
 * `then` answers undefined so the proxy is never mistaken for a thenable.
 */
function stubPrisma(): PrismaClient {
  const node = (callPath: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) =>
        typeof prop === "symbol" || prop === "then"
          ? undefined
          : node(callPath === "" ? prop : `${callPath}.${prop}`),
      apply: () => {
        prismaCalls.push(callPath);
        const rejection = Promise.reject(new Error(`stub prisma reached: ${callPath}`));
        rejection.catch(() => undefined);
        return rejection;
      },
    });
  return node("") as PrismaClient;
}

// ── the app: principal → the REAL module gates → the REAL PM routers ────────

interface PmRouterMount {
  /** The factory app.ts calls. The source pin looks for exactly this name. */
  readonly factory: string;
  /** What app.ts hands `app.use`; "" when it mounts with no base. */
  readonly base: string;
  /** The router file, relative to src/. Only used to exempt it from the
   *  "no OTHER file registers a PM route" scan below. */
  readonly file: string;
  readonly router: Router;
}

const PRISMA = stubPrisma();

/**
 * Mirrors the seven PM mounts in app.ts, base and ORDER. The six native
 * routers mount at `/api`; routes/mobile/pm.ts registers absolute
 * `/api/mobile/pm/...` paths and is mounted with no base. The source pin below
 * is what keeps this table honest.
 */
const PM_ROUTER_MOUNTS: readonly PmRouterMount[] = [
  {
    factory: "createPmOpenApiRouter",
    base: "/api",
    file: "routes/pm/openapi.ts",
    router: createPmOpenApiRouter(),
  },
  {
    factory: "createPmNativeRouter",
    base: "/api",
    file: "routes/pm/native.ts",
    router: createPmNativeRouter(PRISMA),
  },
  {
    factory: "createPmRelationsRouter",
    base: "/api",
    file: "routes/pm/relations.ts",
    router: createPmRelationsRouter(PRISMA),
  },
  {
    factory: "createPmImportExportRouter",
    base: "/api",
    file: "routes/pm/import-export.ts",
    router: createPmImportExportRouter(PRISMA),
  },
  {
    factory: "createPmPlanningRouter",
    base: "/api",
    file: "routes/pm/planning.ts",
    router: createPmPlanningRouter(PRISMA),
  },
  {
    factory: "createPmTimeRouter",
    base: "/api",
    file: "routes/pm/time.ts",
    router: createPmTimeRouter(PRISMA),
  },
  {
    factory: "createPmWebhooksRouter",
    base: "/api",
    file: "routes/pm/webhooks.ts",
    router: createPmWebhooksRouter(PRISMA),
  },
  {
    factory: "createPmScheduleRouter",
    base: "/api",
    file: "routes/pm/schedule.ts",
    router: createPmScheduleRouter(PRISMA),
  },
  {
    factory: "createPmDevelopmentRouter",
    base: "/api",
    file: "routes/pm/development.ts",
    router: createPmDevelopmentRouter(PRISMA),
  },
  {
    factory: "createPmInsightsRouter",
    base: "/api",
    file: "routes/pm/insights.ts",
    router: createPmInsightsRouter(PRISMA),
  },
  {
    factory: "createPmMobileRouter",
    base: "",
    file: "routes/mobile/pm.ts",
    router: createPmMobileRouter(PRISMA),
  },
];

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = OWNER;
    next();
  });
  mountModuleGates(app, GATE, NO_NARROWING);
  for (const { base, router } of PM_ROUTER_MOUNTS) {
    if (base === "") app.use(router);
    else app.use(base, router);
  }
  // Two terminal answers, both distinguishable from the gate's: a URL no
  // router matched, and a handler that threw (the stub prisma, when reached).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "unrouted" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status(500)
      .json({ error: "handler_error", message: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

const APP = buildApp();

beforeEach(() => {
  disabled.clear();
  prismaCalls.length = 0;
});

// ── enumerating what the routers register ───────────────────────────────────

type Method = "get" | "post" | "put" | "patch" | "delete";
const METHODS: readonly Method[] = ["get", "post", "put", "patch", "delete"];

interface PmRoute {
  readonly owner: string;
  readonly method: Method;
  /** Mount base + the route's own path, `:params` intact. */
  readonly pattern: string;
  /** The same, with every `:param` replaced by a dummy value. */
  readonly url: string;
  readonly label: string;
}

interface Layer {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: unknown };
  regexp?: { fast_slash?: boolean };
}

/**
 * Express 4 keeps one `Layer` per `router.METHOD(path, …)`, each with a `route`
 * carrying the literal path and a method map.
 *
 * Anything this walk cannot read exactly throws, naming the router, rather than
 * being skipped. A skipped route is a route the invariant silently does not
 * cover, which is the failure it exists to prevent: a RegExp / array path or a
 * `*` `?` `+` `()` pattern has no single concrete URL to request, and a nested
 * router or a path-scoped `use()` can answer requests that no `route` records.
 * Only a path-less `router.use(mw)` is let through: it opens no URL of its own.
 */
function enumerate({ factory, base, router }: PmRouterMount): PmRoute[] {
  const out: PmRoute[] = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    const route = layer.route;
    if (!route) {
      if (layer.handle?.stack !== undefined || layer.regexp?.fast_slash !== true) {
        throw new Error(
          `${factory} registers a layer that is not a plain router.METHOD route (a nested ` +
            `router or a path-scoped use()); this test cannot enumerate what it serves`,
        );
      }
      continue;
    }
    const routePath = route.path;
    if (typeof routePath !== "string") {
      throw new Error(`${factory} registers a non-string path (${String(routePath)}); this test cannot request it`);
    }
    if (!routePath.startsWith("/") || /[*?+()[\]{}|\\^$]/.test(routePath)) {
      throw new Error(
        `${factory} registers the pattern "${routePath}"; only plain "/segment/:param" paths can be turned into a request`,
      );
    }
    const registered = Object.keys(route.methods).filter((m) => route.methods[m]);
    const methods = registered.includes("_all")
      ? METHODS
      : registered.map((m) => {
          if (!METHODS.includes(m as Method)) {
            throw new Error(`${factory} registers ${m.toUpperCase()} ${routePath}; add that method to METHODS`);
          }
          return m as Method;
        });
    const pattern = `${base}${routePath}`;
    for (const method of methods) {
      out.push({
        owner: factory,
        method,
        pattern,
        url: pattern.replace(/:[A-Za-z0-9_]+/g, "x"),
        label: `${method.toUpperCase()} ${pattern}`,
      });
    }
  }
  return out;
}

const ROUTES: readonly PmRoute[] = PM_ROUTER_MOUNTS.flatMap(enumerate);
const CASES = ROUTES.map((route) => [route.label, route] as const);

const PROJECTS = MODULES.find((m) => m.id === "projects");
if (!PROJECTS) throw new Error("module-registry.ts has no `projects` module");
/** What the gate covers: the registry's own list, which `mountModuleGates` mounts off. */
const GATED_PREFIXES: readonly string[] = PROJECTS.routePrefixes;

const GATE_REFUSAL = { error: "module_disabled", module: "projects" };
const WITH_BODY: ReadonlySet<Method> = new Set<Method>(["post", "put", "patch"]);

/** The request for one route. A small JSON body on writes, so a body-parse
 *  failure can never be the reason the gate looks like it answered. */
function call(route: PmRoute) {
  const req = request(APP)[route.method](route.url);
  return WITH_BODY.has(route.method) ? req.send({ probe: true }) : req;
}

// ── source pin: the table above is the mount app.ts has ─────────────────────

const THIS_FILE = "src/routes/pm/pm-module-gate.mount.test.ts";
const APP_FILE = packagePath("src", "app.ts");

/**
 * The source with comments removed. String literals are copied whole, so a
 * `//` inside a URL is not a comment, and a quote string ends at a newline, so
 * a quote inside a regex literal derails at most one line.
 */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === "`" || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const APP_SOURCE = stripComments(readFileSync(APP_FILE, "utf8"));

/** `app.use(<optional "base",> factory(` — whitespace and line breaks tolerated. */
const MOUNT = /\bapp\s*\.\s*use\s*\(\s*(?:(["'`])([^"'`]*)\1\s*,\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
const APP_MOUNTS = [...APP_SOURCE.matchAll(MOUNT)].map((m) => ({
  base: m[2] ?? "",
  factory: m[3],
  index: m.index ?? -1,
}));

/** A path that looks like Projects': first segment `pm…`, optionally behind
 *  `/api` or `/api/mobile`. Deliberately wider than `/pm`: `/api/pm-cycles` is
 *  exactly the sibling that would sit OUTSIDE `/api/pm` and escape its gate. */
const PM_PATH = /^(?:\/api(?:\/mobile)?)?\/pm[\w-]*(?:\/|$)/;

/** `x.get("/…")`, `x.use("/…")`, `x.route("/…")`: the string-literal paths a file registers. */
const REGISTRATION = /\.\s*(?:get|post|put|patch|delete|all|use|route)\s*\(\s*(["'`])([^"'`]*)\1/g;

/** Every file app.ts imports by a relative specifier (`.js` resolves to `.ts`). */
function filesImportedByApp(): string[] {
  const found = new Set<string>();
  for (const m of APP_SOURCE.matchAll(/\b(?:from|import)\s*\(?\s*(["'])(\.{1,2}\/[^"']+)\1/g)) {
    const target = path.resolve(packagePath("src"), m[2]);
    const hit = [target.replace(/\.js$/, ".ts"), `${target}.ts`, path.join(target, "index.ts")].find(existsSync);
    if (hit) found.add(hit);
  }
  return [...found];
}

/** The PM-looking paths a comment-stripped `source` registers. String literals
 *  only: a path built at runtime is invisible here (the enumeration below still
 *  covers every router the table lists, whatever it builds its paths from). */
function pmRegistrations(source: string): string[] {
  return [...source.matchAll(REGISTRATION)].map((m) => m[2]).filter((p) => PM_PATH.test(p));
}

describe("WARP-1625 — PM_ROUTER_MOUNTS is the mount app.ts has", () => {
  it("reads app.ts the way the pin assumes: comments gone, string literals kept", () => {
    // If this stripped a `//` inside a string, or kept a commented-out mount,
    // every pin below would be answering about text app.ts does not contain.
    expect(stripComments('a("http://x"); // b\n/* c */ d')).toBe('a("http://x"); \n  d');
    expect(APP_MOUNTS.length).toBeGreaterThan(50);
  });

  it("mounts each PM router exactly once, at the base this test mounts it", () => {
    for (const { factory, base } of PM_ROUTER_MOUNTS) {
      expect(
        APP_MOUNTS.filter((m) => m.factory === factory).map((m) => m.base),
        `app.ts must mount ${factory} once, ${base === "" ? "with no base" : `at "${base}"`}. ` +
          `PM_ROUTER_MOUNTS in ${THIS_FILE} has drifted from app.ts: update the table to match the real mount.`,
      ).toEqual([base]);
    }
  });

  it("mounts them after mountModuleGates, and in the table's order", () => {
    const gates = APP_SOURCE.search(/\bmountModuleGates\s*\(\s*app\s*,/);
    expect(gates, "app.ts no longer calls mountModuleGates(app, …)").toBeGreaterThan(-1);
    const at = PM_ROUTER_MOUNTS.flatMap(({ factory }) => {
      const mount = APP_MOUNTS.find((m) => m.factory === factory);
      return mount ? [mount.index] : [];
    });
    expect(
      at.filter((i) => i < gates).length,
      "a PM router is mounted BEFORE mountModuleGates: it would serve with the projects gate not yet in place",
    ).toBe(0);
    expect(at, "app.ts mounts the PM routers in a different order than PM_ROUTER_MOUNTS").toEqual(
      [...at].sort((a, b) => a - b),
    );
  });

  it("mounts no other router that registers a PM route", () => {
    const tableFiles = new Set(PM_ROUTER_MOUNTS.map((m) => packagePath("src", m.file)));
    const imported = filesImportedByApp();
    // Not vacuous: the scan really did reach the routers it is exempting.
    expect(imported.length).toBeGreaterThan(50);
    for (const file of tableFiles) {
      expect(imported, `app.ts no longer imports ${file}`).toContain(file);
    }
    const strangers = [
      ...pmRegistrations(APP_SOURCE).map((p) => `app.ts registers "${p}"`),
      ...imported
        .filter((file) => !tableFiles.has(file))
        .flatMap((file) => {
          const raw = readFileSync(file, "utf8");
          if (!raw.includes("/pm")) return [];
          const name = path.relative(packagePath("src"), file).replaceAll("\\", "/");
          return pmRegistrations(stripComments(raw)).map((p) => `${name} registers "${p}"`);
        }),
    ];
    expect(
      strangers,
      `A router outside PM_ROUTER_MOUNTS registers a PM route (${strangers.join("; ")}). If app.ts ` +
        `mounts it, add its factory and base to PM_ROUTER_MOUNTS in ${THIS_FILE}, so its routes ` +
        `are enumerated and proved gated by the projects module. If it is not a PM route, give ` +
        `it a path that does not start with /pm.`,
    ).toEqual([]);
  });

  it("the registry still gates the prefixes the PM routers live under", () => {
    // The whole of WARP-2875 in one line: narrow this back to
    // `/api/pm/projects` and the work-item routes fall outside the gate.
    expect(
      GATED_PREFIXES,
      "the projects entry in modules/module-registry.ts no longer lists /api/pm and /api/mobile/pm: " +
        "the PM routes outside what it does list are served with the Projects toggle OFF (WARP-2875)",
    ).toEqual(expect.arrayContaining(["/api/pm", "/api/mobile/pm"]));
  });
});

// ── enumeration ─────────────────────────────────────────────────────────────

describe("WARP-1625 — the walk finds the routes the routers register", () => {
  /** Known routes, by the router that owns them. Not the route list: a handful
   *  to prove the walk reads the routers, so an enumeration that
   *  quietly stops matching Express's shape cannot pass over an empty set. */
  const KNOWN: ReadonlyArray<readonly [owner: string, label: string]> = [
    ["createPmNativeRouter", "GET /api/pm/summary"],
    ["createPmNativeRouter", "GET /api/pm/workspaces"],
    ["createPmNativeRouter", "POST /api/pm/projects"],
    ["createPmNativeRouter", "DELETE /api/pm/projects/:id"],
    ["createPmRelationsRouter", "GET /api/pm/work-items/:id/relations"],
    ["createPmDevelopmentRouter", "GET /api/pm/work-items/:id/development"],
    ["createPmWebhooksRouter", "GET /api/pm/webhooks"],
    ["createPmDevelopmentRouter", "GET /api/pm/development/repositories"],
    ["createPmWebhooksRouter", "POST /api/pm/webhooks/:id/deliveries/:deliveryId/redeliver"],
    ["createPmMobileRouter", "GET /api/mobile/pm/workspaces"],
  ];

  it("finds at least 30 routes, and each router contributes", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(30);
    for (const { factory } of PM_ROUTER_MOUNTS) {
      expect(
        ROUTES.some((r) => r.owner === factory),
        `${factory} contributed no routes to the enumeration`,
      ).toBe(true);
    }
  });

  it.each(KNOWN.map((k) => [`${k[0]}: ${k[1]}`, k] as const))("includes %s", (_name, [owner, label]) => {
    expect(ROUTES.filter((r) => r.owner === owner).map((r) => r.label)).toContain(label);
  });
});

// ── (a) the route is inside a gated prefix ──────────────────────────────────

describe("WARP-1625 — every PM route is under a projects-gated prefix", () => {
  it.each(CASES)("%s", (_label, route) => {
    // Segment-bounded, like `app.use(prefix)`: `/api/pm` itself and anything
    // below it, but not `/api/pmx/…`.
    const gated = GATED_PREFIXES.some(
      (prefix) => route.pattern === prefix || route.pattern.startsWith(`${prefix}/`),
    );
    expect(
      gated,
      `${route.label} (${route.owner}) is outside the \`projects\` gated prefixes ` +
        `(${GATED_PREFIXES.join(", ")}), so it is served with the Projects toggle OFF. Move it ` +
        `under one of them, or add its prefix to the projects entry in modules/module-registry.ts.`,
    ).toBe(true);
  });
});

// ── (b) Projects OFF: the gate answers, nothing else runs ───────────────────

describe("WARP-1625 — Projects OFF: the gate answers before any handler", () => {
  it.each(CASES)("%s → 404 module_disabled", async (_label, route) => {
    disabled.add("projects");
    const res = await call(route);
    expect(
      { status: res.status, body: res.body },
      `${route.label} was served while Projects is off: it is not behind the projects gate`,
    ).toEqual({ status: 404, body: GATE_REFUSAL });
    expect(prismaCalls, `${route.label} reached the database while Projects is off`).toEqual([]);
  });
});

// ── (c) Projects ON: the same request is let through ────────────────────────

describe("WARP-1625 — Projects ON: the same request gets past the gate", () => {
  it.each(CASES)("%s is not refused", async (_label, route) => {
    const res = await call(route);
    expect(res.body, `${route.label} is refused by the projects gate while Projects is ON`).not.toEqual(
      GATE_REFUSAL,
    );
    // A URL no router matched is also "not refused". It would make the OFF
    // assertion above vacuous for this route, so it fails here.
    expect(
      res.body,
      `${route.label}: the URL this test builds (${route.url}) matched no route handler`,
    ).not.toEqual({ error: "unrouted" });
  });
});
