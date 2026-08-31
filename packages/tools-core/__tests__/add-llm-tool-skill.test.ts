/**
 * WARP-2496 — the `add-llm-tool` skill must name every file the registry
 * drift gates read.
 *
 * ## Why this file exists
 *
 * `.claude/skills/add-llm-tool/SKILL.md` is TRACKED and shared with the team,
 * so an agent that follows it is following repo-sanctioned instructions. It
 * listed four steps. Registering a tool actually touches six sites, and the
 * gates that enforce the other two (`catalog.ts`, `INVENTORY.md`) live in this
 * package. Following the skill as written therefore produced a red suite — the
 * GOOD outcome. The bad one, and the reason this test exists, is the next
 * agent "fixing" the drift test instead of the skill.
 *
 * A prose fix rots the same way the first one did. So the skill's site list is
 * pinned to the repo the same way every other divergence-prone pair here is
 * pinned (`check-schema-drift.sh`, `check-agent-api-sync.mjs`, `build.mjs
 * --check`): derived on every run, never restated.
 *
 * ## What "derive from the tests, not a hand list" means here
 *
 * NO PATH IN THIS FILE IS HARD-CODED AS THE ANSWER. The expected set is
 * computed in two mechanical steps:
 *
 *   1. DISCOVER the registry drift gates — every `*.test.ts` under `apps/`,
 *      `packages/` and `services/` that both (a) imports `TOOLS` from the
 *      canonical registry and (b) enumerates it WHOLESALE (`TOOLS.keys()` /
 *      `.values()` / `.size`). That conjunction is what makes a test able to
 *      go red when a tool is added: a test that merely calls one named tool
 *      cannot. `services/mcp-server/__tests__/rbac.test.ts` is the live
 *      counter-example the second clause has to reject — it says
 *      "TOOLS.values()" in a test NAME while operating entirely on fakes.
 *
 *   2. For each gate, collect THE REPO FILES IT READS: its own path (the gate
 *      is where the assertion lives), its value imports resolved to real repo
 *      sources, the filesystem paths it walks, and the `.md` files it names.
 *
 * Three normalisations, each because the raw read would be noise rather than a
 * site:
 *   - anything under `src/handlers/` collapses to the handlers DIRECTORY —
 *     `tool-routes.test.ts` walks the whole tree, and the skill's step 1
 *     already tells you to add a file there;
 *   - `__fixtures__/` is dropped — a fixture is test scaffolding, not a site;
 *   - `import type` is dropped — a type-only import is erased before the gate
 *     executes, so the gate does not read that file at runtime.
 *
 * ## The mutation
 *
 * Delete any one path from the skill's marked site block → this goes red and
 * names the missing path. Adding a gate, or making an existing gate read a new
 * file, goes red the same way. Verified by mutation, not asserted by comment:
 * see the WARP-2496 Jira comment for the run.
 *
 * ## Deliberate non-goal
 *
 * This does NOT check that the skill's prose is correct, only that it is
 * COMPLETE. Prose accuracy is a review concern; silent omission is the one
 * that shipped.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/packages/tools-core/__tests__` → `<repo>`. */
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SKILL_PATH = join(REPO_ROOT, ".claude", "skills", "add-llm-tool", "SKILL.md");
const HANDLERS_DIR = resolve(REPO_ROOT, "packages", "tools-core", "src", "handlers");

/** Where a drift gate can live. Scoped to the workspace roots so the walk is
 *  deterministic and never descends into `.claude/worktrees/` (sibling agent
 *  checkouts, which would make the derived set depend on who else is running). */
const WORKSPACE_ROOTS = ["apps", "packages", "services"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".next", "coverage"]);

function walkTests(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTests(full, out);
    else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/** Imports the canonical registry binding — via the package or a relative path. */
const IMPORTS_TOOLS =
  /import\s*(?:type\s*)?\{[^}]*\bTOOLS\b[^}]*\}\s*from\s*"(?:@droplet\/tools-core|\.{1,2}\/[^"]*(?:registry|index)\.js)"/;
/** Enumerates the WHOLE registry, which is what lets it notice a new tool. */
const ENUMERATES_REGISTRY = /\bTOOLS\.(?:keys|values|size)\b/;

function discoverDriftGates(): string[] {
  const found: string[] = [];
  for (const root of WORKSPACE_ROOTS) {
    for (const file of walkTests(join(REPO_ROOT, root))) {
      const src = readFileSync(file, "utf8");
      if (IMPORTS_TOOLS.test(src) && ENUMERATES_REGISTRY.test(src)) found.push(file);
    }
  }
  return found.sort();
}

/** Resolve a TS-style `./x.js` specifier back to the source file on disk. */
function resolveSource(fromDir: string, spec: string): string | null {
  const base = resolve(fromDir, spec);
  for (const candidate of [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Repo-relative, POSIX-separated, with the three normalisations applied. */
function toSitePath(abs: string): string | null {
  const normalised = abs === HANDLERS_DIR || abs.startsWith(HANDLERS_DIR + sep) ? HANDLERS_DIR : abs;
  const rel = relative(REPO_ROOT, normalised).split(sep).join("/");
  if (!rel || rel.startsWith("..")) return null;
  if (rel.includes("__fixtures__")) return null;
  return rel;
}

/** Every repo file a gate reads, as repo-relative paths. */
function filesReadBy(gate: string): string[] {
  const src = readFileSync(gate, "utf8");
  const gateDir = dirname(gate);
  const hits = new Set<string>();
  const add = (abs: string | null): void => {
    if (!abs) return;
    const site = toSitePath(abs);
    if (site) hits.add(site);
  };

  // The gate itself: it is where the assertion — and, for
  // `registry.test.ts`'s `EXPECTED_TOOL_NAMES`, the hand-maintained list —
  // lives.
  add(gate);

  // Value imports only. `(?!type\s)` drops `import type { … }`, which is
  // erased before the gate runs.
  for (const m of src.matchAll(/import\s+(?!type\s)[\s\S]*?\s+from\s+"([^"]+)"/g)) {
    const spec = m[1];
    if (spec === "vitest" || spec.startsWith("node:")) continue;
    if (spec === "@droplet/tools-core") {
      add(join(REPO_ROOT, "packages", "tools-core", "src", "index.ts"));
      continue;
    }
    if (spec.startsWith(".")) add(resolveSource(gateDir, spec));
  }

  // Filesystem paths the gate walks: `join(HERE, "..", "src", "handlers")`
  // and friends. Non-literal arguments (`HERE`, `__dirname`) are the anchor
  // and resolve to the gate's own directory, which is what `resolve` does
  // with a relative tail anyway.
  for (const m of src.matchAll(/\b(?:join|resolve)\(([^)]*)\)/g)) {
    const segments = [...m[1].matchAll(/"([^"]*)"/g)].map((s) => s[1]);
    if (segments.length === 0) continue;
    const target = resolve(gateDir, ...segments);
    if (!existsSync(target)) continue;
    // Files, plus the one directory that is itself a site.
    if (statSync(target).isFile() || target === HANDLERS_DIR) add(target);
  }

  // `.md` files the gate names — `registry.test.ts` pins itself to
  // `INVENTORY.md` in prose and in a test name, never by import.
  for (const m of src.matchAll(/([A-Za-z0-9_.-]+\.md)/g)) {
    for (const root of [gateDir, resolve(gateDir, ".."), resolve(gateDir, "..", "..")]) {
      const candidate = resolve(root, m[1]);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        add(candidate);
        break;
      }
    }
  }

  return [...hits].sort();
}

const SITE_BLOCK = /<!--\s*add-llm-tool:sites:begin\s*-->([\s\S]*?)<!--\s*add-llm-tool:sites:end\s*-->/;

/** The paths the skill's site block names, as repo-relative code spans. */
function pathsNamedBySkill(): { block: string; paths: Set<string> } {
  const skill = readFileSync(SKILL_PATH, "utf8");
  const m = SITE_BLOCK.exec(skill);
  if (!m) {
    throw new Error(
      `${relative(REPO_ROOT, SKILL_PATH)} has no <!-- add-llm-tool:sites:begin --> … ` +
        `<!-- add-llm-tool:sites:end --> block. That block IS the machine-readable ` +
        `step list this test derives against; do not remove it.`,
    );
  }
  const block = m[1];
  const paths = new Set<string>();
  for (const span of block.matchAll(/`([^`\n]+)`/g)) {
    const text = span[1].trim();
    // Repo-relative only. A leading `/` is a URL path (`/api/…`), which the
    // route-manifest rows legitimately quote and which is not a file.
    if (text.startsWith("/")) continue;
    if (text.includes("/") && /^[A-Za-z0-9_@./-]+$/.test(text)) paths.add(text);
  }
  return { block, paths };
}

const GATES = discoverDriftGates();
const REQUIRED_SITES = [...new Set(GATES.flatMap(filesReadBy))].sort();

describe("the add-llm-tool skill names every file the registry drift gates read (WARP-2496)", () => {
  it("discovers the drift gates rather than trusting a list", () => {
    const rel = GATES.map((g) => relative(REPO_ROOT, g).split(sep).join("/"));

    // NON-VACUITY. Named specimens, so an over-narrow predicate cannot make
    // the completeness assertion below trivially true by discovering nothing.
    // These four are the gates WARP-2466 actually tripped over.
    for (const known of [
      "packages/tools-core/__tests__/registry.test.ts",
      "packages/tools-core/__tests__/catalog.test.ts",
      "packages/tools-core/__tests__/tool-routes.test.ts",
      "apps/orchestrator/src/services/chat-tool-scope.test.ts",
    ]) {
      expect(rel, `${known} must be discovered as a registry drift gate`).toContain(known);
    }

    // ...and the second clause of the predicate must actually reject
    // something, or it is decorative. `rbac.test.ts` mentions
    // "TOOLS.values()" in a test name but imports no registry.
    expect(rel).not.toContain("services/mcp-server/__tests__/rbac.test.ts");
  });

  it("derives a non-empty site set that includes the six sites WARP-2466 found", () => {
    // NON-VACUITY for the derivation itself: an empty or near-empty set would
    // make the skill assertion pass while checking nothing. The floor is the
    // ticket's own finding, used as a tripwire — never as the answer, which
    // is why the assertion below compares against REQUIRED_SITES.
    for (const site of [
      "packages/tools-core/src/registry.ts",
      "packages/tools-core/src/catalog.ts",
      "packages/tools-core/src/tool-routes.ts",
      "packages/tools-core/INVENTORY.md",
      "packages/tools-core/__tests__/registry.test.ts", // holds EXPECTED_TOOL_NAMES
      "apps/orchestrator/src/services/chat-tool-scope.ts", // the chat scope list
    ]) {
      expect(REQUIRED_SITES, `${site} must be derived from the gates`).toContain(site);
    }
    expect(REQUIRED_SITES.length).toBeGreaterThan(6);
  });

  it("names every derived file in its site block", () => {
    const { paths } = pathsNamedBySkill();
    const missing = REQUIRED_SITES.filter((p) => !paths.has(p));
    expect(
      missing,
      `${relative(REPO_ROOT, SKILL_PATH)} does not name these files, but a registry ` +
        `drift gate reads them — an agent following the skill will trip a gate it was ` +
        `never told about, and the tempting "fix" is to edit the gate:\n  ` +
        missing.join("\n  ") +
        `\n\nEach was derived from: ` +
        missing
          .map(
            (p) =>
              `${p} <- ${GATES.filter((g) => filesReadBy(g).includes(p))
                .map((g) => relative(REPO_ROOT, g).split(sep).join("/"))
                .join(", ")}`,
          )
          .join("; "),
    ).toEqual([]);
  });

  it("names no path that does not exist — the block cannot rot in the other direction", () => {
    // The completeness assertion above is one-directional: it would stay green
    // if the skill named a file that was later renamed or deleted. A stale
    // path in shared team instructions sends the next agent to a file that is
    // not there, so it fails here instead.
    const { paths } = pathsNamedBySkill();
    const dead = [...paths].filter((p) => !existsSync(join(REPO_ROOT, p))).sort();
    expect(dead, `the skill names paths that no longer exist: ${dead.join(", ")}`).toEqual([]);
  });

  it("states the prompt-budget rule with the measured ceiling, not an adjective", () => {
    // WARP-2496 AC 3. The failure this closes is a tool registered without
    // anyone measuring what it costs: WARP-2466 measured the shipping
    // advertisement at 196% of the derived ceiling, so "there is room" is
    // never true by default. The skill has to carry the number, because an
    // agent that is told to "be mindful of the budget" will register the tool
    // anyway.
    const skill = readFileSync(SKILL_PATH, "utf8");
    expect(skill, "the skill must cite the 12,410-token tools[] ceiling").toMatch(
      /12,?410/,
    );
    expect(skill, "the skill must cite the measured 196% overage").toMatch(/196\s?%/);
    expect(skill, "the skill must attribute the measurement to WARP-2466").toContain(
      "WARP-2466",
    );
    // The rule is to MEASURE FIRST, and the dynamic half is the half a
    // static-only reading misses (WARP-2446).
    expect(skill).toMatch(/dynamic half/i);
    expect(skill).toContain("base-prompt-budget.test.ts");
  });
});
