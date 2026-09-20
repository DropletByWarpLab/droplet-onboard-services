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
 * owning file. `process.cwd()` never is, because cwd is a property of whoever
 * typed the command, not of the tree under test.
 *
 * WARP-2654 adds the second half. `__dirname` and
 * `fileURLToPath(import.meta.url)` BOTH anchor to the owning file, so neither
 * was ever the bug — but this package carried both (17 files against 10) with
 * the two sets of header comments giving contradictory reasons, and a reader
 * picking a pattern got no answer. It is now `__dirname` everywhere, which is
 * what `vitest.config.ts` already uses for its `server.fs.allow` roots
 * (WARP-2613) and what the two CommonJS workspaces are forced onto (TS1470).
 * That is a convention, not a correctness rule, so it is gated the cheap way:
 * one assertion below, in a suite that already runs. The full argument, and
 * the one case that would justify the other spelling, is in
 * `helpers/test-paths.ts`.
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
   *
   * Explicit timeout, because vitest's 5 s default is sized for a unit test
   * and this one stats and reads ~545 files. Measured in the full 544-file
   * dashboard run on Windows: 2.9 s on a lightly loaded run, 5.6 s on a
   * saturated one — a coin flip against the default, and a timeout here reads
   * exactly like the real assertion failing. A path guard that goes red at
   * random teaches developers to ignore it, which is the one thing a guard
   * cannot afford. (Its sibling `dashboard-classes-guard.test.ts` has the same
   * problem and is out of scope here — see WARP-2613's PR notes.)
   */
  it(
    "no test file resolves a path from the cwd",
    () => {
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
    },
    30_000,
  );

  /**
   * WARP-2654 — one anchoring idiom, not two.
   *
   * Mutation: put `fileURLToPath(import.meta.url)` back into any dashboard
   * test → red, naming the file.
   *
   * Same walk as the cwd scan above — and this file's own error message
   * spells the forbidden token, so `rel()` is what keeps it from reporting
   * itself on Windows — hence the same timeout.
   */
  it(
    "anchors on __dirname everywhere, the idiom vitest.config.ts uses",
    () => {
      const offenders = testFiles(SRC)
        .filter((f) => rel(f) !== SELF)
        .filter((f) => code(readFileSync(f, "utf8")).includes("import.meta.url"))
        .map(rel);

      expect(
        offenders,
        "This package anchors test paths on `__dirname` — the spelling " +
          "`vitest.config.ts` already uses for `server.fs.allow`, and the one " +
          "apps/orchestrator and packages/tools-core are forced onto by their " +
          "CommonJS output. `fileURLToPath(import.meta.url)` is equally correct " +
          "and equally anchored; carrying both is what left this package with " +
          "two sets of comments contradicting each other. See " +
          "src/__tests__/helpers/test-paths.ts (WARP-2654).",
      ).toEqual([]);
    },
    30_000,
  );

  it("the idiom assertion is not vacuous — vitest.config.ts really does use __dirname", () => {
    // Otherwise the rule above is a preference with nothing behind it, and
    // `toEqual([])` over an empty scan would pass either way.
    expect(readFileSync(packagePath("vitest.config.ts"), "utf8")).toContain(
      "const packageRoot = __dirname;",
    );
    expect(code(readFileSync(packagePath("src/__tests__/helpers/test-paths.ts"), "utf8"))).toContain(
      "const here = __dirname;",
    );
  });
});
