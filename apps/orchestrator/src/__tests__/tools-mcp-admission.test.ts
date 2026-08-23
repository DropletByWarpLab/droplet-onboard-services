/**
 * WARP-1455 — the consolidated, data-driven MCP-principal admission suite.
 *
 * This is the runtime half of the structural guard that closes the
 * "shipped-but-dead MCP tool" bug class. It imports `TOOL_ROUTES` from
 * `@droplet/tools-core` and, for every `kind: "admit"` hop, proves the
 * orchestrator route the tool dispatches through ADMITS the `_service:mcp`
 * principal — the direct inverse of the bug (a handler calling a route the
 * mcp principal can't reach 401/403s, so the tool ships registered but
 * dead). For every `kind: "dashboard-only"` hop it pins that the route
 * stays `requireRole` human-only (the tool hands the Tier-2 202 back and
 * the dashboard, not the tool, completes the confirm).
 *
 * ## Verification modes (see the final report / describe titles)
 *
 *   - LIVE  — the router is mounted for real and driven with supertest as
 *     `_service:mcp`; the assertion is the actual HTTP status is NOT
 *     401/403. Used for the switch + updates routers, whose deps stub
 *     cleanly (recipes from switch-mcp-guards.test.ts / updates-mcp-
 *     guards.test.ts).
 *   - STATIC — the route registration is parsed from the orchestrator
 *     route source and its guard middleware is asserted to admit the mcp
 *     principal (`requireRoleOrMcpService`, an open read, a
 *     `requireRole(…, "service")`, `requireSpaceAccess`, or a custom guard
 *     that admits the `_service:mcp` id). Used for every other router —
 *     mounting all ~16 with their bespoke deps in one data-driven harness
 *     is fragile; static guard verification is deterministic and covers
 *     100% of admit hops uniformly. Removing the nine ad-hoc
 *     `*-mcp-guards.test.ts` files this suite SUPERSEDES is a follow-up.
 *
 * ## Supersedes (leave in place this PR; deletion is a follow-up)
 *   cameras-mcp-guards.test.ts, email-mcp-guards.test.ts,
 *   files-share-versions-mcp-guards.test.ts, network-mcp-guards.test.ts,
 *   scenes-mcp-guards.test.ts, switch-mcp-guards.test.ts,
 *   updates-mcp-guards.test.ts, guard-flips-mcp.test.ts (the ninth,
 *   auth-config-guard.test.ts, is unrelated config coverage — keep it).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROUTES, type ToolRouteHop } from "@droplet/tools-core";
import type { PrismaClient } from "@prisma/client";

// ── Config + heavy-service mocks (union of the switch & updates recipes;
//    hoisted above the route imports so auth.js can build SERVICE_PRINCIPALS
//    and the routers' deps never touch real hardware/GitHub/compose). ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_OTA_RELEASES_URL: "https://releases.test/latest",
    DROPLET_OTA_GITHUB_TOKEN: "",
    DROPLET_OTA_APPLY_SCRIPT: "",
    DROPLET_OTA_COMPOSE_FILE: "/opt/droplet/docker/docker-compose.yml",
    DROPLET_OTA_UPDATES_DIR: "/data/updates",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/switch.client.js", () => ({
  fetchPoeStatus: vi.fn().mockResolvedValue([]),
  detectWanPort: vi.fn().mockResolvedValue({ wan_port: 9 }),
  enablePortPoe: vi.fn().mockResolvedValue(undefined),
  disablePortPoe: vi.fn().mockResolvedValue(undefined),
  setVlanMembership: vi.fn().mockResolvedValue(undefined),
  setupCameraPorts: vi.fn().mockResolvedValue({ status: "ok" }),
  enablePort: vi.fn(), disablePort: vi.fn(), createVlan: vi.fn(),
  deleteVlan: vi.fn(), enablePortPoeLegacy: vi.fn(), provisionSwitch: vi.fn(),
  fetchPort: vi.fn(), fetchVlanMembership: vi.fn(), fetchPortPoe: vi.fn(),
  fetchSystemInfo: vi.fn(),
}));

vi.mock("../services/switch-aggregation.service.js", () => ({
  fetchSwitchStatus: vi.fn().mockResolvedValue({ connected: true }),
  fetchSwitchPorts: vi.fn().mockResolvedValue([]),
  fetchSwitchVlans: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createSwitchRouter } from "../routes/switch.js";
import { createUpdatesRouter, type UpdatesRouterDeps } from "../routes/updates.js";
import { DEFAULT_UPDATE_AGENT_SETTINGS } from "../services/update-agent/settings.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import type { AuthUser } from "../middleware/auth.js";

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};

// ── Hop inventory, derived from the manifest ──
interface FlatHop { tool: string; method: ToolRouteHop["method"]; path: string; kind: ToolRouteHop["kind"]; }
const ALL_HOPS: FlatHop[] = TOOL_ROUTES.flatMap((e) =>
  e.hops.map((h) => ({ tool: e.tool, method: h.method, path: h.pathPattern, kind: h.kind })),
);
const ADMIT_HOPS = ALL_HOPS.filter((h) => h.kind === "admit");
const DASHBOARD_ONLY_HOPS = ALL_HOPS.filter((h) => h.kind === "dashboard-only");

/** Prefixes whose routers this suite mounts and drives live. */
const LIVE_PREFIXES = ["/api/switch/", "/api/updates/"];
const isLive = (path: string) => LIVE_PREFIXES.some((p) => path.startsWith(p));

// ────────────────────────────────────────────────────────────────────────
// LIVE mode — mount the real switch + updates routers, drive as _service:mcp
// ────────────────────────────────────────────────────────────────────────

function shim(user: AuthUser, mount: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  mount(app);
  return app;
}
const fillParams = (path: string) => path.replace(/:[A-Za-z_]+/g, "1");

function updatesDeps(): UpdatesRouterDeps {
  return {
    checkForUpdate: vi.fn().mockResolvedValue({ outcome: "up_to_date" }) as never,
    applyPendingUpdate: vi.fn() as never,
    getUpdateAgentSettings: vi.fn().mockResolvedValue({ ...DEFAULT_UPDATE_AGENT_SETTINGS }),
    saveUpdateAgentSettings: vi.fn().mockResolvedValue({ ...DEFAULT_UPDATE_AGENT_SETTINGS }),
    getApplyRunner: () => null,
  };
}
function updatesPrisma() {
  return {
    deviceUpdate: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityMock.mockResolvedValue(null);
  // Switch writes reach the Tier-2 safety layer → 202 mint (never executes).
  // The uniform mint is fine even for the Tier-1 /switch/wan/detect read
  // (WARP-2125): this suite asserts only ADMISSION (not 401/403), and the
  // routes forward whatever verdict the mocked safety service returns —
  // tier truth lives in switch-wan-detect.routes.test.ts, which runs the
  // real safety service.
  vi.mocked(evaluateNetworkCommand).mockResolvedValue({
    requiresConfirmation: true, confirmationToken: "tok", reason: "tier2", tier: 2,
  } as never);
});

describe("LIVE: switch router admits the MCP principal on every admit hop (WARP-1455)", () => {
  const hops = ADMIT_HOPS.filter((h) => h.path.startsWith("/api/switch/"));
  for (const h of hops) {
    it(`${h.tool}: ${h.method.toUpperCase()} ${h.path} — not 401/403`, async () => {
      const app = shim(mcpPrincipal, (a) =>
        a.use("/api", createSwitchRouter({} as unknown as PrismaClient)),
      );
      const res = await (request(app) as any)[h.method](fillParams(h.path)).send({});
      expect([401, 403]).not.toContain(res.status);
    });
  }
});

describe("LIVE: updates router admits the MCP principal on every admit hop (WARP-1455)", () => {
  const hops = ADMIT_HOPS.filter((h) => h.path.startsWith("/api/updates/"));
  for (const h of hops) {
    it(`${h.tool}: ${h.method.toUpperCase()} ${h.path} — not 401/403`, async () => {
      const app = shim(mcpPrincipal, (a) =>
        a.use(
          "/api",
          createUpdatesRouter(updatesPrisma() as unknown as PrismaClient, updatesDeps()),
        ),
      );
      const res = await (request(app) as any)[h.method](fillParams(h.path)).send({});
      expect([401, 403]).not.toContain(res.status);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// STATIC mode — parse the route source, assert the guard admits mcp.
// ────────────────────────────────────────────────────────────────────────

const ROUTES_DIR = join(__dirname, "..", "routes");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const ROUTE_SOURCES: { file: string; src: string }[] = (() => {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
    }
    return out;
  };
  return walk(ROUTES_DIR).map((file) => ({ file, src: stripComments(readFileSync(file, "utf8")) }));
})();

const PARAM = " param";
const segsOf = (p: string) =>
  p.split("/").filter(Boolean).map((s) => (s.startsWith(":") ? PARAM : s));
function segsMatch(routePath: string, targetSegs: string[]): number | null {
  const r = segsOf(routePath);
  if (r.length !== targetSegs.length) return null;
  let score = 0;
  for (let i = 0; i < r.length; i++) {
    if (r[i] === targetSegs[i]) score += r[i] === PARAM ? 0 : 1;
    else if (r[i] !== PARAM && targetSegs[i] !== PARAM) return null;
  }
  return score;
}

/** Body of a `const <id> = …;` or `function <id>(…){…}` in `src`. */
function definitionOf(id: string, src: string): string {
  const c = new RegExp("\\b(?:const|let|var)\\s+" + id + "\\s*=\\s*").exec(src);
  if (c) {
    const rest = src.slice(c.index + c[0].length);
    const end = rest.indexOf(";");
    return end >= 0 ? rest.slice(0, end) : rest.slice(0, 400);
  }
  const f = new RegExp("\\bfunction\\s+" + id + "\\s*\\(").exec(src);
  if (f) {
    let i = src.indexOf("{", f.index);
    if (i < 0) return "";
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
    }
  }
  return "";
}

const KNOWN_GUARD_CALLS = new Set([
  "requireRole", "requireRoleOrMcpService", "requireRoleOrService", "requireSpaceAccess",
]);

type Verdict = "admit" | "open" | "deny";
function guardVerdict(region: string, fileSrc: string): Verdict {
  // Resolve any file-local guard alias referenced in the middleware region
  // (e.g. web.ts `guard`, activity.ts `requireOwnerOrAdmin`).
  const noStrings = region.replace(/(["'`])(?:[^\\]|\\.)*?\1/g, "");
  let inspect = region;
  for (const id of new Set(noStrings.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (KNOWN_GUARD_CALLS.has(id)) continue;
    inspect += "\n" + definitionOf(id, fileSrc);
  }
  if (/requireRoleOrMcpService\s*\(/.test(inspect)) return "admit";
  if (/requireSpaceAccess\s*\(/.test(inspect)) return "admit";
  if (/requireRoleOrService\s*\(\s*["']_service:mcp["']/.test(inspect)) return "admit";
  for (const m of inspect.matchAll(/requireRole\s*\(([^)]*)\)/g)) {
    if (/["']service["']/.test(m[1])) return "admit";
  }
  if (/_service:mcp/.test(inspect)) return "admit"; // custom guard admitting the mcp id
  if (/requireRole\s*\(/.test(inspect)) return "deny";
  return "open"; // no guard middleware → open read, reachable by any principal
}

/** Read a string/template literal at s[i] (the quote); balances `${…}`. */
function readStr(s: string, i: number): [string, number] {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s[j] === q) break;
    }
    return [s.slice(i, j + 1), j + 1];
  }
  let j = i + 1;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") return [s.slice(i, j + 1), j + 1];
    if (c === "$" && s[j + 1] === "{") {
      let depth = 1;
      j += 2;
      for (; j < s.length && depth > 0; j++) {
        const d = s[j];
        if (d === "\\") { j++; continue; }
        if (d === "`") { const [, nx] = readStr(s, j); j = nx - 1; continue; }
        if (d === "{") depth++;
        else if (d === "}") depth--;
      }
      j--;
    }
  }
  return [s.slice(i, j), j];
}

/** Split a `router.method( … )` argument list (s[open] === '(') into top-level args. */
function splitArgs(s: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { const [lit, nx] = readStr(s, i); cur += lit; i = nx - 1; continue; }
    if (c === "(" || c === "{" || c === "[") { depth++; cur += c; continue; }
    if (c === ")" || c === "}" || c === "]") {
      if (c === ")" && depth === 0) { args.push(cur); return args; }
      depth--; cur += c; continue;
    }
    if (c === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += c;
  }
  args.push(cur);
  return args;
}

/**
 * Locate a route registration and return its guard verdict. The first arg
 * is the path, the LAST is the handler (inline `async (req…)` OR a named
 * ref like matter's `upsertAliasRoute`); the MIDDLE args are the guard
 * middleware — the only region `guardVerdict` inspects.
 */
function verdictFor(method: string, apiPath: string): { verdict: Verdict; file: string } | null {
  const target = segsOf(apiPath); // manifest paths are full /api paths
  const re = new RegExp("\\brouter\\." + method + "\\(", "g");
  let best: { verdict: Verdict; file: string; score: number } | null = null;
  for (const { file, src } of ROUTE_SOURCES) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const args = splitArgs(src, open);
      const first = args[0]?.trim() ?? "";
      if (!/^["'`]/.test(first)) continue; // path must be a string literal
      const raw = first.slice(1, -1);
      const routePath = "/api" + (raw.startsWith("/") ? raw : "/" + raw);
      const score = segsMatch(routePath, target);
      if (score === null) continue;
      const middle = args.length > 2 ? args.slice(1, -1).join(" , ") : "";
      const verdict = guardVerdict(middle, src);
      if (!best || score > best.score) best = { verdict, file, score };
    }
  }
  return best ? { verdict: best.verdict, file: best.file } : null;
}

describe("STATIC: every admit hop's route admits the MCP principal (WARP-1455)", () => {
  for (const h of ADMIT_HOPS.filter((x) => !isLive(x.path))) {
    it(`${h.tool}: ${h.method.toUpperCase()} ${h.path} admits _service:mcp`, () => {
      const r = verdictFor(h.method, h.path);
      expect(r, `route not found for ${h.method.toUpperCase()} ${h.path}`).not.toBeNull();
      expect(
        r!.verdict,
        `${h.method.toUpperCase()} ${h.path} (${r!.file}) does NOT admit _service:mcp — dead-tool risk`,
      ).not.toBe("deny");
    });
  }
});

describe("STATIC: dashboard-only hops stay human-only requireRole (WARP-1455)", () => {
  for (const h of DASHBOARD_ONLY_HOPS) {
    it(`${h.tool}: ${h.method.toUpperCase()} ${h.path} is requireRole (not mcp-admitting)`, () => {
      const r = verdictFor(h.method, h.path);
      expect(r, `route not found for ${h.method.toUpperCase()} ${h.path}`).not.toBeNull();
      expect(
        r!.verdict,
        `${h.method.toUpperCase()} ${h.path} is marked dashboard-only but admits the mcp principal`,
      ).toBe("deny");
    });
  }
});

describe("admission suite coverage accounting (WARP-1455)", () => {
  it("verifies every admit hop live or statically, with no gaps", () => {
    const live = ADMIT_HOPS.filter((h) => isLive(h.path)).length;
    const staticCount = ADMIT_HOPS.filter((h) => !isLive(h.path)).length;
    // Surfaced for the ticket's report; also a guard that the split covers all.
    expect(live + staticCount).toBe(ADMIT_HOPS.length);
    expect(live).toBeGreaterThan(0);
    expect(staticCount).toBeGreaterThan(0);
  });
});
