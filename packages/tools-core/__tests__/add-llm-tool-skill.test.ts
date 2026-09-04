/**
 * WARP-2496 — the `add-llm-tool` skill must name every file the registry
 * drift gates read. WARP-2612 — and only those gates.
 *
 * ## Why this file exists
 *
 * `.claude/skills/add-llm-tool/SKILL.md` is TRACKED and shared with the team,
 * so an agent that follows it is following repo-sanctioned instructions. It
 * listed four steps. Registering a tool actually touches ten sites, and the
 * gates that enforce two of them (`catalog.ts`, `INVENTORY.md`) live in this
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
 *   1. DISCOVER the add-a-tool drift gates — every `*.test.ts` under `apps/`,
 *      `packages/` and `services/` that carries the `add-llm-tool:gate`
 *      pragma. The pragma is the whole predicate: a gate declares itself.
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
 * ## WARP-2612 — why a pragma, and not "imports and enumerates TOOLS"
 *
 * Step 1 used to CLASSIFY rather than read a declaration: any test that both
 * imported `TOOLS` and touched `TOOLS.keys/values/size` was a gate, and every
 * file it imported was then demanded of the skill's site block. Two defects,
 * both found by the WARP-2300 implementer (PR #1944):
 *
 *   - It over-matched. `remote-mcp-servers.test.ts` reads the registry to
 *     prove a REMOTE tool cannot collide with a local one. The remedy this
 *     file demanded was to list `mcp-multiplexer.service.ts`,
 *     `remote-mcp-servers.ts` and `runtime-tool-registry.service.ts` in a
 *     skill that tells an agent which files to edit when ADDING a tool —
 *     files a tool author must never touch (ADR-043: runtime tools live
 *     outside `TOOLS`). That author narrowed their test to a named specimen
 *     to dodge this file, which is the wrong direction of causation.
 *   - It read raw source, COMMENTS INCLUDED, so prose that merely quoted the
 *     token classified the file. #1944's test carries a comment saying the
 *     literal token is "deliberately not spelled anywhere in this file" —
 *     source written around a test's parser is the symptom.
 *
 * So: a gate SAYS it is one. `add-llm-tool:gate` on a test means "this
 * asserts on an add-a-tool site; the skill must name what I read".
 * `add-llm-tool:not-a-gate` is the documented opt-out for a test that reads
 * the registry for some other reason. A file carrying neither is still read —
 * by its PARSED CODE, comments and string literals excluded — and if it does
 * enumerate the registry wholesale it fails here asking for one of the two
 * pragmas, naming which it thinks the file is and why.
 *
 * ## The mutations
 *
 * Delete any one path from the skill's marked site block → the completeness
 * test goes red and names the missing path. Delete a gate's pragma → both the
 * discovery test and the unclassified-gate test go red. Widen the fallback
 * back to a bare `TOOLS` import (drop the enumeration clause) → the
 * named-specimen fixture goes red. Match the raw source instead of the AST →
 * the comment and string-literal fixtures go red. Recorded in the WARP-2612
 * PR body.
 *
 * ## Deliberate non-goal
 *
 * This does NOT check that the skill's prose is correct, only that it is
 * COMPLETE. Prose accuracy is a review concern; silent omission is the one
 * that shipped.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

// `__dirname`, not `import.meta.url` (WARP-2606): this package builds to
// CommonJS (`module: NodeNext` + no `"type": "module"`), where `import.meta`
// is a TS1470 error — and `tsconfig.test.json` deliberately keeps the tests on
// the package's own module setting precisely so that error is CAUGHT rather
// than configured away. `vitest` does not typecheck, so this file was green
// under `npm run -w @droplet/tools-core test` while `typecheck:tests` was red
// on `stage`. Same note, and the same resolution, as `tool-routes.test.ts`,
// which already anchors its walk this way; `vitest` defines `__dirname` in its
// CJS-interop module scope.
const HERE = __dirname;
/** This file, so the walk can skip it — see `CANDIDATES`. */
const SELF = __filename;
/** `<repo>/packages/tools-core/__tests__` → `<repo>`. */
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SKILL_PATH = join(REPO_ROOT, ".claude", "skills", "add-llm-tool", "SKILL.md");
const HANDLERS_DIR = resolve(REPO_ROOT, "packages", "tools-core", "src", "handlers");

/** Where a drift gate can live. Scoped to the workspace roots so the walk is
 *  deterministic and never descends into `.claude/worktrees/` (sibling agent
 *  checkouts, which would make the derived set depend on who else is running). */
const WORKSPACE_ROOTS = ["apps", "packages", "services"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".next", "coverage"]);

/** The pragmas, assembled from a prefix so neither reads as a declaration on
 *  the fixture sources below — those are strings inside this file, and this
 *  file is excluded from the walk anyway, but keeping the two facts
 *  independent means a future reader cannot break one by fixing the other. */
const PRAGMA_PREFIX = "add-llm-tool:";
/** "This test asserts on an add-a-tool site; the skill must name what I read." */
const GATE_PRAGMA = `${PRAGMA_PREFIX}gate`;
/** The documented opt-out: "I read the registry for another reason." */
const NOT_A_GATE_PRAGMA = `${PRAGMA_PREFIX}not-a-gate`;

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
const REGISTRY_MODULE = /^(?:@droplet\/tools-core|\.{1,2}\/.*(?:registry|index)\.js)$/;
/** Members that read the WHOLE registry, which is what lets a test notice a
 *  new tool. `has` / `get` take a name and cannot. */
const WHOLESALE_MEMBERS = new Set(["keys", "values", "size"]);

interface RegistryFacts {
  /** A value import of `TOOLS` from the canonical registry. Type-only imports
   *  are erased before the test runs, so they do not count. */
  importsTools: boolean;
  /** Wholesale reads, as `TOOLS.size (line 42)`, for the failure message. */
  enumerations: string[];
}

/**
 * Read the registry usage out of a test's PARSED CODE.
 *
 * The parser is the point (WARP-2612): comments are trivia and never reach the
 * AST, and string and regex literals are literals rather than code, so prose
 * or an assertion message quoting `TOOLS.values()` cannot classify a file. A
 * hand-rolled comment stripper cannot make that distinction safely — a regex
 * literal such as `/"([^"]*)"/g` desynchronises a quote-aware scanner.
 */
function registryFacts(src: string, fileName: string): RegistryFacts {
  // Cheap gate: the walk sees >1,300 test files and parsing each one costs
  // more than this whole suite. A file with no `TOOLS` token cannot qualify.
  if (!src.includes("TOOLS")) return { importsTools: false, enumerations: [] };

  const sourceFile = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let importsTools = false;
  const enumerations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      REGISTRY_MODULE.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "TOOLS") {
            importsTools = true;
          }
        }
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "TOOLS" &&
      WHOLESALE_MEMBERS.has(node.name.text)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      enumerations.push(`TOOLS.${node.name.text} (line ${line + 1})`);
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return { importsTools, enumerations };
}

type Verdict = "gate" | "opted-out" | "unmarked-gate" | "unrelated" | "conflicting-pragmas";

interface Classification {
  verdict: Verdict;
  /** Says which of the two this file is taken for, and on what evidence. */
  why: string;
}

/** The whole predicate, as a pure function of a test's source. */
function classifySource(src: string, fileName: string): Classification {
  const declaresGate = src.includes(GATE_PRAGMA);
  const declaresOptOut = src.includes(NOT_A_GATE_PRAGMA);

  if (declaresGate && declaresOptOut) {
    return {
      verdict: "conflicting-pragmas",
      why: `it carries both \`${GATE_PRAGMA}\` and \`${NOT_A_GATE_PRAGMA}\`, which cannot both be true`,
    };
  }
  if (declaresGate) {
    return { verdict: "gate", why: `it declares itself one with \`${GATE_PRAGMA}\`` };
  }
  if (declaresOptOut) {
    return { verdict: "opted-out", why: `it declares itself not one with \`${NOT_A_GATE_PRAGMA}\`` };
  }

  // No declaration. Fall back to the CODE — never the comments — so a gate
  // whose author forgot the pragma is told so instead of being skipped.
  const facts = registryFacts(src, fileName);
  if (!facts.importsTools) {
    return {
      verdict: "unrelated",
      why: "it carries no pragma and its code never value-imports `TOOLS` from the canonical registry",
    };
  }
  if (facts.enumerations.length === 0) {
    return {
      verdict: "unrelated",
      why:
        "it carries no pragma and, although its code imports `TOOLS`, it only ever looks a " +
        "name up (`TOOLS.has(...)` / `TOOLS.get(...)`) — it cannot go red when a tool is " +
        "added, so it does not gate adding one",
    };
  }
  return {
    verdict: "unmarked-gate",
    why:
      "it carries no pragma, but its code imports `TOOLS` from the canonical registry AND " +
      `reads the whole thing: ${facts.enumerations.join(", ")}`,
  };
}

/** Every candidate test file, including this one. */
const ALL_TEST_FILES = WORKSPACE_ROOTS.flatMap((root) => walkTests(join(REPO_ROOT, root))).sort();

/** This file derives the convention and quotes both pragmas as data; it is not
 *  itself a gate, so it must not classify itself. */
const CANDIDATES = ALL_TEST_FILES.filter((file) => file !== SELF);

const CLASSIFICATIONS = new Map<string, Classification>(
  CANDIDATES.map((file) => [file, classifySource(readFileSync(file, "utf8"), file)] as const),
);

const relPath = (abs: string): string => relative(REPO_ROOT, abs).split(sep).join("/");

function filesWithVerdict(verdict: Verdict): string[] {
  return CANDIDATES.filter((file) => CLASSIFICATIONS.get(file)?.verdict === verdict);
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

const GATES = filesWithVerdict("gate");
const REQUIRED_SITES = [...new Set(GATES.flatMap(filesReadBy))].sort();

/** A gate-shaped test, used as the base for the pragma fixtures. */
const ENUMERATING_TEST = `
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import { TOOL_ROUTES } from "../src/tool-routes.js";

describe("the route manifest", () => {
  it("covers every registered tool", () => {
    expect([...TOOLS.keys()].sort()).toEqual(Object.keys(TOOL_ROUTES).sort());
  });
});
`;

const withPragma = (pragma: string, src: string): string => `// ${pragma}\n${src}`;

/**
 * The predicate's contract, as sources rather than as repo files — a repo file
 * can be renamed or narrowed out from under the case it was pinning, which is
 * exactly what happened to #1944's `remote-mcp-servers.test.ts`.
 */
const FIXTURES: ReadonlyArray<{ name: string; source: string; verdict: Verdict }> = [
  {
    // #1944's shape, before its author narrowed it to dodge this file.
    name: "imports TOOLS only to look up a named specimen",
    verdict: "unrelated",
    source: `
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import { syncRemoteCatalog } from "./remote-mcp-servers.js";

const LOCAL_SPECIMEN = "list_files";

describe("the remote layer", () => {
  it("refuses a remote tool that collides with a local one", () => {
    expect(TOOLS.has(LOCAL_SPECIMEN)).toBe(true);
    expect(syncRemoteCatalog([LOCAL_SPECIMEN])).toEqual([]);
  });
});
`,
  },
  {
    name: "only mentions the registry in a comment",
    verdict: "unrelated",
    source: `
/**
 * Not a gate. This prose explains that the discovery step used to look for
 *   import { TOOLS } from "@droplet/tools-core";
 * together with TOOLS.values() in the RAW source, comments included, so a
 * paragraph like this one classified the file.
 */
import { describe, it, expect } from "vitest";
import { renderHelp } from "./help.js";

describe("help copy", () => {
  it("renders", () => {
    expect(renderHelp()).toContain("tools");
  });
});
`,
  },
  {
    name: "only mentions the registry inside string and regex literals",
    verdict: "unrelated",
    source: `
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import { explain } from "./explain.js";

describe("the error copy", () => {
  it("names the enumeration it is asking for", () => {
    expect(explain(TOOLS.has("list_files"))).toMatch(/TOOLS\\.size|TOOLS\\.values\\(\\)/);
    expect(explain(false)).toContain("TOOLS.keys()");
  });
});
`,
  },
  {
    name: "enumerates the registry but declares nothing",
    verdict: "unmarked-gate",
    source: ENUMERATING_TEST,
  },
  {
    name: "declares itself a gate",
    verdict: "gate",
    source: withPragma(GATE_PRAGMA, ENUMERATING_TEST),
  },
  {
    name: "enumerates the registry but takes the documented opt-out",
    verdict: "opted-out",
    source: withPragma(NOT_A_GATE_PRAGMA, ENUMERATING_TEST),
  },
  {
    name: "declares both pragmas",
    verdict: "conflicting-pragmas",
    source: withPragma(GATE_PRAGMA, withPragma(NOT_A_GATE_PRAGMA, ENUMERATING_TEST)),
  },
];

describe("the add-llm-tool skill names every file the registry drift gates read (WARP-2496)", () => {
  it("classifies a test by its pragma and its parsed code, never by its prose (WARP-2612)", () => {
    // Every fixture is judged before anything is asserted, so a mutation that
    // breaks several of them reports ALL of them rather than only the first.
    const wrong = FIXTURES.map((fixture) => ({
      fixture,
      got: classifySource(fixture.source, `fixture-${fixture.name}.test.ts`),
    })).filter(({ fixture, got }) => got.verdict !== fixture.verdict);

    expect(
      wrong.map(({ fixture, got }) => `${fixture.name}: want ${fixture.verdict}, got ${got.verdict}`),
      wrong.map(({ fixture, got }) => `${fixture.name}\n    -> ${got.why}`).join("\n  "),
    ).toEqual([]);
  });

  it("discovers the drift gates from their pragma rather than trusting a list", () => {
    // The self-exclusion has to exclude something: this file quotes both
    // pragmas as data, so if `__filename` ever stopped matching the walk it
    // would classify itself as a gate and pull its own imports into the
    // required site set.
    expect(ALL_TEST_FILES, "this file must be found by the walk, then skipped").toContain(SELF);
    expect(CANDIDATES).not.toContain(SELF);

    const rel = GATES.map(relPath);

    // NON-VACUITY. Named specimens, so a lost pragma cannot make the
    // completeness assertion below trivially true by discovering nothing.
    // These four are the gates WARP-2466 actually tripped over.
    for (const known of [
      "packages/tools-core/__tests__/registry.test.ts",
      "packages/tools-core/__tests__/catalog.test.ts",
      "packages/tools-core/__tests__/tool-routes.test.ts",
      "apps/orchestrator/src/services/chat-tool-scope.test.ts",
    ]) {
      expect(rel, `${known} must declare itself an add-a-tool gate`).toContain(known);
    }

    // ...and the predicate must actually reject something, or it is
    // decorative. `rbac.test.ts` mentions "TOOLS.values()" in a test NAME
    // while operating entirely on fakes: prose, not a gate.
    expect(rel).not.toContain("services/mcp-server/__tests__/rbac.test.ts");
  });

  it("leaves no test that reads the whole registry unclassified", () => {
    const unmarked = filesWithVerdict("unmarked-gate");
    expect(
      unmarked.map(relPath),
      `these tests read the WHOLE registry but declare neither pragma, so this file cannot ` +
        `tell whether the skill owes an agent their imports:\n  ` +
        unmarked
          .map((file) => `${relPath(file)} — ${CLASSIFICATIONS.get(file)?.why ?? "?"}`)
          .join("\n  ") +
        `\n\nAdd ONE comment line near the top of each:\n` +
        `  // ${GATE_PRAGMA}       if it asserts on a site an agent edits when ADDING a tool\n` +
        `  // ${NOT_A_GATE_PRAGMA} if it reads the registry for some other reason\n` +
        `The first pulls every file it imports into the skill's site block; the second does ` +
        `not. See the pragma section of .claude/skills/add-llm-tool/SKILL.md.`,
    ).toEqual([]);
  });

  it("has no test claiming to be both a gate and not one", () => {
    const conflicting = filesWithVerdict("conflicting-pragmas");
    expect(
      conflicting.map(relPath),
      `a test cannot declare both pragmas; delete the one that is wrong: ${conflicting
        .map(relPath)
        .join(", ")}`,
    ).toEqual([]);
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
          .map((p) => `${p} <- ${GATES.filter((g) => filesReadBy(g).includes(p)).map(relPath).join(", ")}`)
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

  it("documents the pragma convention, and keeps it out of the site block", () => {
    // WARP-2612. An author who trips the unclassified-gate test above is sent
    // to the skill, so the two pragmas have to be spelled there. They belong
    // in the skill's PROSE and not in its site block: the block is the list of
    // files an agent edits when adding a tool, and a test-file convention is
    // not one of them.
    const skill = readFileSync(SKILL_PATH, "utf8");
    for (const pragma of [GATE_PRAGMA, NOT_A_GATE_PRAGMA]) {
      expect(skill, `the skill must document the \`${pragma}\` pragma`).toContain(pragma);
    }
    const { block } = pathsNamedBySkill();
    for (const pragma of [GATE_PRAGMA, NOT_A_GATE_PRAGMA]) {
      expect(block, `\`${pragma}\` belongs in the skill's prose, not in the site block`).not.toContain(
        pragma,
      );
    }
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
