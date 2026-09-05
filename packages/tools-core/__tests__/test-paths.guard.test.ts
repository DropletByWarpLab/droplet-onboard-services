/**
 * WARP-2654 — no tools-core test resolves a path from `process.cwd()`.
 *
 * The same gate WARP-2632 put on the dashboard and this ticket put on
 * `apps/orchestrator`. Here it is prevention rather than repair: this package
 * had zero cwd reads when it was written, because `tsconfig.test.json` forces
 * `__tests__/` onto the package's CommonJS module setting and so every suite
 * reached for `__dirname` (WARP-2606) instead of the cwd walk-ups the other
 * two workspaces grew.
 *
 * "Currently clean" is not an invariant, though, and this class has now been
 * fixed three times in three workspaces. What makes it worth gating rather
 * than trusting is that the failure is silent in both directions:
 *
 *   - A `[process.cwd(), …]` candidate list does not fail on a wrong cwd; it
 *     takes the first entry that exists, and a second checkout of this repo
 *     on the same disk provides one. Nine of this package's suites read
 *     handler and registry SOURCE, so a wrong tree means the drift gates
 *     assert about code that is not the code under test.
 *   - A cwd read with no fallback throws at import and vitest reports
 *     `Tests  no tests`, which nobody reads as a gap.
 *
 * The rule is narrow on purpose: **path resolution in test code** must be
 * anchored to the owning file. `__dirname` / `__filename` satisfy that and are
 * what this package must use; `process.cwd()` never does, because cwd is a
 * property of whoever typed the command, not of the tree under test.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { PACKAGE_ROOT, REPO_ROOT, packagePath, repoPath } from "./helpers/test-paths";

const TESTS = packagePath("__tests__");

/** This file names the forbidden call in its own error message, which is code. */
const SELF = path.join("__tests__", "test-paths.guard.test.ts");

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
 * resolve paths on their behalf. `src/` is out of scope — production modules
 * may legitimately consult the process's working directory, which is the
 * runtime's business and not a test's.
 */
function scannedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
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
    expect(path.basename(PACKAGE_ROOT)).toBe("tools-core");
    expect(JSON.parse(readFileSync(packagePath("package.json"), "utf8")).name).toBe(
      "@droplet/tools-core",
    );
    // The repo root is the one that owns the skill the drift gates read.
    expect(statSync(repoPath(".claude", "skills", "add-llm-tool")).isDirectory()).toBe(true);
    expect(path.relative(REPO_ROOT, PACKAGE_ROOT)).toBe(path.join("packages", "tools-core"));
  });

  it("scans a non-trivial number of files — an empty walk would pass vacuously", () => {
    // The assertion below is `toEqual([])`, which a broken walk satisfies for
    // free. This package had ~30 files under `__tests__/` when this was
    // written, so a floor of 10 is a tripwire, not a target.
    expect(scannedFiles(TESTS).length).toBeGreaterThan(10);
  });

  /**
   * Mutation: put `process.cwd()` into any file under `__tests__/` → red,
   * naming the file.
   */
  it("no test file resolves a path from the cwd", () => {
    const offenders = scannedFiles(TESTS)
      .filter((f) => path.relative(PACKAGE_ROOT, f) !== SELF)
      .filter((f) => code(readFileSync(f, "utf8")).includes("process.cwd("))
      .map((f) => path.relative(PACKAGE_ROOT, f));

    expect(
      offenders,
      "Resolve paths from the owning file, not the runner's cwd — " +
        "use `__dirname`, or import PACKAGE_ROOT / REPO_ROOT / readPackageFile / " +
        "readRepoFile from __tests__/helpers/test-paths (WARP-2654).",
    ).toEqual([]);
  });
});
