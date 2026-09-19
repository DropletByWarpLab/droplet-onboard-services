/**
 * WARP-2654 — no erp-connector test resolves a path from `process.cwd()`.
 *
 * The same gate WARP-2632 put on the dashboard and this ticket put on
 * `apps/orchestrator` and `packages/tools-core`. Here, as in tools-core, it is
 * prevention rather than repair: every suite in this package already anchors
 * on `import.meta.url`.
 *
 * "Currently clean" is not an invariant, though, and this class has now been
 * fixed in three workspaces. What makes it worth gating rather than trusting
 * is that the failure is silent in both directions:
 *
 *   - A `[process.cwd(), …]` candidate list does not fail on a wrong cwd; it
 *     takes the first entry that exists, and a second checkout of this repo on
 *     the same disk provides one. Most of this package's suites read connector
 *     SOURCE — the Stripe/HubSpot/Mailchimp gates assert on the shipped code's
 *     text, and one reads `docs/security/allowed-egress.yaml` at the repo root
 *     — so a wrong tree means those gates report on code that is not the code
 *     under test.
 *   - A cwd read with no fallback throws at import and vitest reports
 *     `Tests  no tests`, which nobody reads as a gap.
 *
 * The rule is narrow on purpose: **path resolution in test code** must be
 * anchored to the owning file. `fileURLToPath(import.meta.url)` satisfies that
 * and is what this ESM package must use; `process.cwd()` never does, because
 * cwd is a property of whoever typed the command, not of the tree under test.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { PACKAGE_ROOT, REPO_ROOT, packagePath, repoPath } from "./helpers/test-paths.js";

const TESTS = packagePath("__tests__");

/** This file names the forbidden call in its own error message, which is code. */
const SELF = join("__tests__", "test-paths.guard.test.ts");

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

/**
 * Comments are not the offense — the suites in this package explain in prose
 * why they anchor the way they do, and those explanations are worth keeping.
 * Strip comments before scanning so the gate reads code only.
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
 * Everything under `__tests__/`: the suites, and the helpers and fixtures that
 * resolve paths on their behalf. `src/` and `harness/` are out of scope —
 * production and harness modules may legitimately consult the process's
 * working directory, which is the runtime's business and not a test's.
 */
function scannedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scannedFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("test path resolution is anchored to the owning file", () => {
  it("derives the package and repo roots without consulting the cwd", () => {
    expect(basename(PACKAGE_ROOT)).toBe("erp-connector");
    expect(JSON.parse(readFileSync(packagePath("package.json"), "utf8")).name).toBe(
      "@droplet/erp-connector",
    );
    // The repo root is the one that owns the egress allowlist these gates read.
    expect(statSync(repoPath("docs", "security", "allowed-egress.yaml")).isFile()).toBe(true);
    expect(relative(REPO_ROOT, PACKAGE_ROOT)).toBe(join("services", "erp-connector"));
  });

  it("scans a non-trivial number of files — an empty walk would pass vacuously", () => {
    // The assertion below is `toEqual([])`, which a broken walk satisfies for
    // free. This package had ~25 files under `__tests__/` when this was
    // written, so a floor of 10 is a tripwire, not a target.
    expect(scannedFiles(TESTS).length).toBeGreaterThan(10);
  });

  /**
   * Mutation: put `process.cwd()` into any file under `__tests__/` → red,
   * naming the file.
   */
  it("no test file resolves a path from the cwd", () => {
    const offenders = scannedFiles(TESTS)
      .filter((f) => relative(PACKAGE_ROOT, f) !== SELF)
      .filter((f) => code(readFileSync(f, "utf8")).includes("process.cwd("))
      .map((f) => relative(PACKAGE_ROOT, f).split(sep).join("/"));

    expect(
      offenders,
      "Resolve paths from the owning file, not the runner's cwd — " +
        "import PACKAGE_ROOT / REPO_ROOT / readPackageFile / readRepoFile from " +
        "__tests__/helpers/test-paths.js (WARP-2654).",
    ).toEqual([]);
  });
});
