/**
 * WARP-2632 — no dashboard test resolves a path from `process.cwd()`.
 *
 * This is the third time the class has been fixed. WARP-2613 anchored
 * `setup-fluid-type.test.ts` and the vite `fs.allow`; WARP-2632 anchored the
 * three remaining hand-rolled walk-up loops. Nothing stopped a fourth from
 * being written, and the failure mode is the quiet kind: a walk-up does not
 * error on a wrong cwd, it climbs until *some* directory matches and then
 * asserts a source contract against a tree it never meant to read.
 *
 * So the invariant gets a gate rather than trust — the repo's standing
 * convention for anything that can silently diverge (`check-schema-drift.sh`,
 * `check-agent-api-sync.mjs`, `build.mjs --check`). It costs no CI leg: it is
 * a test in the suite that already runs.
 *
 * The rule is narrow on purpose: **path resolution** must be anchored to the
 * owning file. `__dirname` and `fileURLToPath(import.meta.url)` both satisfy
 * that and are both already in use here; `process.cwd()` never does, because
 * cwd is a property of whoever typed the command, not of the tree under test.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { PACKAGE_ROOT, REPO_ROOT, packagePath, repoPath } from "./helpers/test-paths";

const SRC = packagePath("src");

/** This file names the forbidden call in its own error message, which is code. */
const SELF = "src/__tests__/test-paths.guard.test.ts";

/**
 * `SELF`, and every path this guard reports, is written with `/` — the way the
 * repo names files everywhere else. `path.relative` answers in the PLATFORM
 * separator, so on Windows it returns `src\__tests__\…` and a raw `!==`
 * against `SELF` never matches. The guard then scans its own source, finds the
 * `"process.cwd("` literal it tests FOR (a string in code, which `code()`
 * rightly keeps), and reports itself: a deterministic red for every developer
 * on the repo's primary dev platform, invisible to CI because the
 * `node / web-dashboard` leg is ubuntu-only. Normalise on the way out, once,
 * so the comparison and the message are both platform-independent.
 */
function rel(full: string): string {
  return relative(PACKAGE_ROOT, full).split(sep).join("/");
}

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
 * `*.test.ts(x)` anywhere under `src/`, plus EVERY file under
 * `src/__tests__/` — not just `__tests__/helpers/`, which is what this used to
 * collect. The clause that mattered most was the one missing: `setup.ts` is
 * the `setupFiles` entry in `vitest.config.ts`, so it is loaded by every suite
 * in the package and is the single highest-blast-radius place to reintroduce a
 * cwd walk-up — and it matches neither `*.test.ts(x)` nor the helpers prefix.
 * The header states the invariant over "no dashboard test"; enforce that, not
 * a subset of it. `+ sep` so a future sibling named `__tests__something` is
 * not swept in by a bare prefix match.
 */
const TESTS_DIR = join(SRC, "__tests__") + sep;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      testFiles(full, out);
      continue;
    }
    if (/\.test\.tsx?$/.test(entry) || full.startsWith(TESTS_DIR)) {
      out.push(full);
    }
  }
  return out;
}

describe("test path resolution is anchored to the owning file", () => {
  it("derives the package and repo roots without consulting the cwd", () => {
    expect(basename(PACKAGE_ROOT)).toBe("web-dashboard");
    expect(JSON.parse(readFileSync(packagePath("package.json"), "utf8")).name).toBe(
      "@droplet/web-dashboard",
    );
    // The repo root is the one that owns the guides the dashboard bundles.
    expect(statSync(repoPath("docs/integrations")).isDirectory()).toBe(true);
    expect(relative(REPO_ROOT, PACKAGE_ROOT)).toBe(join("apps", "web-dashboard"));
  });

  /**
   * The other door into the same failure. Anchoring the ROOT is only half the
   * contract: `resolve(ROOT, relative)` happily walks back out of it, so
   * `repoPath("../shared_brain/…")` — or any absolute argument — reads a tree
   * this repo does not own and then asserts a source contract about it. That
   * is exactly the walk-up failure the helper replaced, reached through a
   * different door, and the `process.cwd(` gate above cannot see it because
   * such a call contains no `process.cwd(`.
   *
   * Mutation: drop either containment check in
   * `src/__tests__/helpers/test-paths.ts` → the matching case here goes green
   * where it should throw.
   */
  it("refuses to resolve outside the tree it is anchored to", () => {
    expect(() => repoPath("../something")).toThrow(/outside the monorepo root/);
    expect(() => packagePath("../orchestrator/package.json")).toThrow(
      /outside the web-dashboard package/,
    );
    // An absolute argument wins outright against `resolve()`'s base.
    expect(() => packagePath(REPO_ROOT)).toThrow(/outside the web-dashboard package/);
    // A sibling whose name merely starts with the root's is still outside it.
    expect(() => repoPath(`${REPO_ROOT}-evil/x`)).toThrow(/outside the monorepo root/);

    // The paths the suites actually ask for are unaffected.
    expect(repoPath("docs/integrations")).toBe(join(REPO_ROOT, "docs", "integrations"));
    expect(packagePath("src/app/globals.css")).toBe(
      join(PACKAGE_ROOT, "src", "app", "globals.css"),
    );
  });

  /**
   * Mutation: put `process.cwd()` back into any dashboard test, into a
   * `__tests__/helpers/` module, or into `__tests__/setup.ts` → red, naming
   * the file.
   */
  it("no test file resolves a path from the cwd", () => {
    const offenders = testFiles(SRC)
      .filter((f) => rel(f) !== SELF)
      .filter((f) => code(readFileSync(f, "utf8")).includes("process.cwd("))
      .map(rel);

    expect(
      offenders,
      "Resolve paths from the owning file, not the runner's cwd — " +
        "import PACKAGE_ROOT / REPO_ROOT / readPackageFile / readRepoFile from " +
        "src/__tests__/helpers/test-paths (WARP-2632).",
    ).toEqual([]);
  });
});
