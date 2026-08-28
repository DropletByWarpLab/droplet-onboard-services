/**
 * WARP-1455 — the TOOL_ROUTES completeness gate.
 *
 * This is the CI gate that closes the "shipped-but-dead MCP tool" bug
 * class at the manifest layer. It proves three things:
 *
 *   1. Bijection with the registry — every registered tool has EXACTLY
 *      one manifest row (no missing, no extra, no dupes). Add a tool to
 *      `registry.ts` without a `TOOL_ROUTES` entry and this goes red.
 *   2. Shape rules — an `orchestrator`/`nextcloud` entry has ≥1 hop; a
 *      `none` entry has 0 hops; `client`/`kind`/`method` are in-enum.
 *   3. No manifest drift — for every non-`none` tool we read the handler
 *      SOURCE, extract the `ctx.http.<client>.<method>(...)` (and pm
 *      `callOrch(...)`) calls it actually makes, and assert the manifest's
 *      declared `admit` hops match (method + path shape) bidirectionally.
 *      This is the check that would have caught all 8 of the WARP tool-
 *      rollout dead-tool bugs: a manifest can't claim a route the handler
 *      doesn't call, and a handler can't call a route the manifest omits.
 *
 * Path matching is by SHAPE (segment count + literal segments; `:param`
 * and `${…}` interpolations are wildcards on either side), so the exact
 * param name in the manifest is documentation, not load-bearing.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../src/registry.js";
import {
  TOOL_ROUTES,
  type ToolRouteEntry,
  type ToolRouteHop,
} from "../src/tool-routes.js";

// `__dirname`, not `import.meta.url`: this package builds to CommonJS
// (`module: NodeNext` + no `"type": "module"`), where `import.meta` is a
// TS1470 error. `vitest` does not typecheck (esbuild strips types), so
// only `npm run -w @droplet/tools-core typecheck:tests` catches it — same
// note as `apps/orchestrator/src/__tests__/write-tools-derivation.guard.test.ts`.
const HERE = __dirname;
const HANDLERS_DIR = join(HERE, "..", "src", "handlers");

const REGISTERED = new Set(TOOLS.keys());

// ── Source parsing helpers (shared with the orchestrator admission suite's
//    intent — kept local so tools-core has no test-time dep on the app). ──

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Read a string / template literal starting at `s[i]` (the opening quote),
 * returning `[literal, endIndex]`. Templates balance `${…}` and nested
 * backticks so a `${cond ? `a` : "b"}` interpolation doesn't truncate the
 * outer literal.
 */
function readStr(s: string, i: number): [string, number] {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === "\\") {
        j++;
        continue;
      }
      if (s[j] === q) break;
    }
    return [s.slice(i, j + 1), j + 1];
  }
  // backtick template
  let j = i + 1;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") return [s.slice(i, j + 1), j + 1];
    if (c === "$" && s[j + 1] === "{") {
      let depth = 1;
      j += 2;
      for (; j < s.length && depth > 0; j++) {
        const d = s[j];
        if (d === "\\") {
          j++;
          continue;
        }
        if (d === "`") {
          const [, nx] = readStr(s, j);
          j = nx - 1;
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") depth--;
      }
      j--;
    }
  }
  return [s.slice(i, j), j];
}

function collectLiterals(expr: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      const [lit, nx] = readStr(expr, i);
      out.push(lit);
      i = nx;
    } else i++;
  }
  return out;
}

/** Strip the literal's delimiters, replace balanced `${…}` with `§`, drop query. */
function normPath(lit: string): string {
  const inner = lit.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "$" && inner[i + 1] === "{") {
      let depth = 1;
      i += 2;
      for (; i < inner.length && depth > 0; i++) {
        const d = inner[i];
        if (d === "\\") {
          i++;
          continue;
        }
        if (d === "`") {
          const [, nx] = readStr(inner, i);
          i = nx - 1;
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") depth--;
      }
      out += "§";
    } else {
      out += inner[i];
      i++;
    }
  }
  return out.split("?")[0];
}

/** Resolve the first-arg path token that begins at the start of `s`. */
function firstArgPaths(s: string, src: string): string[] {
  const lead = s.match(/^\s*/)![0].length;
  const c = s[lead];
  if (c === '"' || c === "'" || c === "`") {
    const [lit] = readStr(s, lead);
    return [normPath(lit)];
  }
  // identifier → resolve its assignment(s) in the whole handler source
  const id = s.slice(lead).match(/^[A-Za-z_$][\w$]*/);
  if (!id) return [];
  const re = new RegExp("\\b" + id[0] + "\\s*=\\s*", "g");
  const lits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(re.lastIndex);
    const end = rest.indexOf(";");
    const rhs = end >= 0 ? rest.slice(0, end) : rest;
    lits.push(...collectLiterals(rhs).map(normPath));
  }
  return lits;
}

interface ActualHop {
  client: string;
  method: string;
  path: string; // normalised, `§` for interpolations, no query
}

/** Every ctx.http / callOrch hop a handler source actually dispatches. */
function extractHops(raw: string): ActualHop[] {
  const src = stripComments(raw);
  const hops: ActualHop[] = [];
  const callRe = /(?:ctx\.)?http\.(\w+)\.(get|post|patch|put|delete)\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    for (const p of firstArgPaths(src.slice(callRe.lastIndex), src)) {
      hops.push({ client: m[1], method: m[2], path: p });
    }
  }
  // pm handlers dispatch through a thin `callOrch(ctx, "<method>", <path>)`
  // wrapper (always the orchestrator target). `[^(]*` skips the generic
  // `<{…}>` (which never contains a paren) up to the call paren.
  const orchRe = /callOrch\b[^(]*\(\s*ctx\s*,\s*["'](\w+)["']\s*,\s*/g;
  while ((m = orchRe.exec(src)) !== null) {
    for (const p of firstArgPaths(src.slice(orchRe.lastIndex), src)) {
      hops.push({ client: "orchestrator", method: m[1], path: p });
    }
  }
  return hops;
}

const PARAM = "\x00param";
/** Full orchestrator path (nextcloud client is based at /api/files) → segments. */
function segsOf(client: string, path: string): string[] {
  const base = client === "nextcloud" ? "/api/files" : "";
  return (base + path)
    .split("/")
    .filter(Boolean)
    .map((s) => (s.includes("§") || s.startsWith(":") ? PARAM : s));
}
function compatible(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || seg === PARAM || b[i] === PARAM);
}

// ── Handler file discovery: tool-name → source (via the registered `name`). ──

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Registered tool name(s) declared in a handler source (the `name:` field). */
function registeredNames(raw: string): string[] {
  const re = /\bname:\s*["']([a-z0-9_]+)["']/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) if (REGISTERED.has(m[1])) found.add(m[1]);
  return [...found];
}

const SOURCE_BY_TOOL: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const file of walk(HANDLERS_DIR)) {
    const raw = readFileSync(file, "utf8");
    const names = registeredNames(raw);
    if (names.length === 0) continue; // helper / shared file
    if (names.length > 1) {
      throw new Error(`handler file ${file} declares multiple tools: ${names.join(", ")}`);
    }
    if (map.has(names[0])) {
      throw new Error(`tool ${names[0]} declared in two files (second: ${file})`);
    }
    map.set(names[0], raw);
  }
  return map;
})();

const ENTRY_BY_TOOL = new Map(TOOL_ROUTES.map((e) => [e.tool, e]));

describe("TOOL_ROUTES manifest (WARP-1455)", () => {
  it("has exactly one entry per registered tool — no missing, extra, or dupe", () => {
    const manifestTools = TOOL_ROUTES.map((e) => e.tool);
    expect(manifestTools.length, "duplicate tool rows in TOOL_ROUTES").toBe(
      new Set(manifestTools).size,
    );

    const missing = [...REGISTERED].filter((t) => !ENTRY_BY_TOOL.has(t));
    const extra = manifestTools.filter((t) => !REGISTERED.has(t));
    expect(missing, "registered tools with no TOOL_ROUTES row").toEqual([]);
    expect(extra, "TOOL_ROUTES rows for unregistered tools").toEqual([]);
    expect(TOOL_ROUTES.length).toBe(TOOLS.size);
  });

  it("enforces the client/hop shape rules and in-enum values", () => {
    const CLIENTS = new Set(["orchestrator", "nextcloud", "none"]);
    const METHODS = new Set(["get", "post", "patch", "put", "delete"]);
    const KINDS = new Set(["admit", "dashboard-only"]);
    for (const e of TOOL_ROUTES) {
      expect(CLIENTS.has(e.client), `${e.tool}: bad client ${e.client}`).toBe(true);
      if (e.client === "none") {
        expect(e.hops, `${e.tool}: none client must have 0 hops`).toEqual([]);
      } else {
        expect(e.hops.length, `${e.tool}: ${e.client} client needs ≥1 hop`).toBeGreaterThan(0);
      }
      for (const h of e.hops) {
        expect(METHODS.has(h.method), `${e.tool}: bad method ${h.method}`).toBe(true);
        expect(KINDS.has(h.kind), `${e.tool}: bad kind ${h.kind}`).toBe(true);
        expect(h.pathPattern.startsWith("/api/"), `${e.tool}: ${h.pathPattern} must be a full /api path`).toBe(true);
      }
    }
  });

  it("every registered tool maps to exactly one handler source file", () => {
    const unmapped = [...REGISTERED].filter((t) => !SOURCE_BY_TOOL.has(t));
    expect(unmapped, "tools with no discoverable handler file").toEqual([]);
  });

  // ── The drift gate: manifest hops vs the handler's real dispatch. ──
  describe("declared hops match the handler source (no drift)", () => {
    for (const entry of TOOL_ROUTES) {
      it(`${entry.tool}`, () => {
        const raw = SOURCE_BY_TOOL.get(entry.tool);
        expect(raw, `no handler source for ${entry.tool}`).toBeDefined();
        const actual = extractHops(raw!);

        if (entry.client === "none") {
          expect(
            actual,
            `${entry.tool} is client:"none" but its handler makes HTTP calls: ${JSON.stringify(actual)}`,
          ).toEqual([]);
          return;
        }

        // The declared client must be one the handler actually uses.
        const actualClients = new Set(actual.map((h) => h.client));
        expect(
          actualClients.has(entry.client),
          `${entry.tool}: manifest client "${entry.client}" not used by handler (uses ${[...actualClients].join(", ") || "nothing"})`,
        ).toBe(true);

        const admitHops = entry.hops.filter((h) => h.kind === "admit");
        const declared = admitHops.map((h: ToolRouteHop) => ({
          method: h.method,
          segs: segsOf("orchestrator", h.pathPattern), // pathPattern is already full
        }));
        const actualShaped = actual.map((h) => ({
          method: h.method,
          segs: segsOf(h.client, h.path),
        }));

        // Forward: every declared admit hop is actually called.
        for (const d of declared) {
          const hit = actualShaped.some(
            (a) => a.method === d.method && compatible(a.segs, d.segs),
          );
          expect(
            hit,
            `${entry.tool}: declared admit hop ${d.method.toUpperCase()} ${d.segs.join("/")} is not called by the handler`,
          ).toBe(true);
        }
        // Reverse: every real call is a declared admit hop.
        for (const a of actualShaped) {
          const hit = declared.some(
            (d) => d.method === a.method && compatible(a.segs, d.segs),
          );
          expect(
            hit,
            `${entry.tool}: handler calls ${a.method.toUpperCase()} ${a.segs.join("/")} but no admit hop declares it`,
          ).toBe(true);
        }
        // dashboard-only hops must NOT be called by the handler (that's the point).
        for (const h of entry.hops.filter((x) => x.kind === "dashboard-only")) {
          const segs = segsOf("orchestrator", h.pathPattern);
          const called = actualShaped.some(
            (a) => a.method === h.method && compatible(a.segs, segs),
          );
          expect(
            called,
            `${entry.tool}: ${h.pathPattern} is marked dashboard-only but the handler calls it`,
          ).toBe(false);
        }
      });
    }
  });
});
