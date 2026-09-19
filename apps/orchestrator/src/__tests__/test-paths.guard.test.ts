/**
 * WARP-2654 — no orchestrator test resolves a path from `process.cwd()`.
 *
 * WARP-2613 anchored the dashboard's vite `fs.allow`; WARP-2632 anchored the
 * dashboard's hand-rolled walk-up loops and gated the invariant there. This is
 * the same gate for `apps/orchestrator`, where 38 test files resolved schema,
 * route and migration paths from the runner's working directory.
 *
 * The failure mode is two-sided and neither side is loud:
 *
 *   - The candidate-list idiom
 *     (`[process.cwd(), join(process.cwd(), "apps", "orchestrator")]`) takes
 *     the first entry that EXISTS. From a cwd inside another checkout of this
 *     repo one does exist, and ~15 schema suites then assert against that
 *     tree's `schema.prisma` while reporting green.
 *   - `tool-selection.parity.test.ts` had no fallback at all, so from the repo
 *     root it threw at import and vitest printed `Tests  no tests`. 23
 *     assertions of the route↔loop parity gate ran zero times.
 *
 * So the invariant gets a gate rather than trust — the repo's standing
 * convention for anything that can silently diverge (`check-schema-drift.sh`,
 * `check-agent-api-sync.mjs`, `build.mjs --check`). It costs no CI leg: it is
 * a test in the suite that already runs.
 *
 * The rule is narrow on purpose: **path resolution in test code** must be
 * anchored to the owning file. `__dirname` satisfies that and is what this
 * package must use (it compiles to CommonJS, where `import.meta` is TS1470);
 * `process.cwd()` never does, because cwd is a property of whoever typed the
 * command, not of the tree under test. Production modules are out of scope —
 * `src/index.ts` and friends legitimately read the process's working
 * directory, and that is the runtime's business, not a test's.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { PACKAGE_ROOT, REPO_ROOT, packagePath, repoPath } from "./helpers/test-paths.js";

const SRC = packagePath("src");
const TESTS_DIR = path.join(SRC, "__tests__");

/** This file names the forbidden call in its own error message, which is code. */
const SELF = path.join("src", "__tests__", "test-paths.guard.test.ts");

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

/**
 * Comments are not the offense — several of the suites this ticket fixed
 * explain in prose why they no longer call it, and those explanations are
 * worth keeping. Strip comments before scanning so the gate reads code only.
 *
 * A regex, not a parser: the `[^:"'\`]` guard keeps `https://…` inside a
 * string from being read as a line comment. The residual blind spot is code
 * that follows a string containing `//` on the same line, which cannot
 * meaningfully hide a path resolution.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Everything the guard covers: every `*.test.ts` anywhere under `src/` (the
 * package's vitest `include`), plus every non-test module under
 * `src/__tests__/` — the helpers, fixtures and setup files, which resolve
 * paths on behalf of the suites and so carry the same hazard.
 */
function scannedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      scannedFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry) || full.startsWith(TESTS_DIR + path.sep)) out.push(full);
  }
  return out;
}

describe("test path resolution is anchored to the owning file", () => {
  it("derives the package and repo roots without consulting the cwd", () => {
    expect(path.basename(PACKAGE_ROOT)).toBe("orchestrator");
    expect(JSON.parse(readFileSync(packagePath("package.json"), "utf8")).name).toBe(
      "@droplet/orchestrator",
    );
    // The repo root is the one that owns the schema this package's suites read.
    expect(statSync(packagePath("prisma", "schema.prisma")).isFile()).toBe(true);
    expect(statSync(repoPath("docs")).isDirectory()).toBe(true);
    expect(path.relative(REPO_ROOT, PACKAGE_ROOT)).toBe(path.join("apps", "orchestrator"));
  });

  it("scans a non-trivial number of files — an empty walk would pass vacuously", () => {
    // The assertion below is `toEqual([])`, which a broken walk satisfies for
    // free. 38 files carried the defect when this was written and the package
    // has ~250 test files, so a floor of 100 is a tripwire, not a target.
    expect(scannedFiles(SRC).length).toBeGreaterThan(100);
  });

  /**
   * Mutation: put `process.cwd()` back into any orchestrator test (or into a
   * `src/__tests__/` helper) → red, naming the file.
   */
  it("no test file resolves a path from the cwd", () => {
    const offenders = scannedFiles(SRC)
      .filter((f) => path.relative(PACKAGE_ROOT, f) !== SELF)
      .filter((f) => code(readFileSync(f, "utf8")).includes("process.cwd("))
      .map((f) => path.relative(PACKAGE_ROOT, f));

    expect(
      offenders,
      "Resolve paths from the owning file, not the runner's cwd — " +
        "import PACKAGE_ROOT / REPO_ROOT / SCHEMA_PATH / readPackageFile / readRepoFile from " +
        "src/__tests__/helpers/test-paths.js (WARP-2654).",
    ).toEqual([]);
  });
});
