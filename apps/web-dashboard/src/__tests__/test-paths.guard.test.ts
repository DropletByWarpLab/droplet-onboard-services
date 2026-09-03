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
import { basename, join, relative } from "node:path";
import { PACKAGE_ROOT, REPO_ROOT, packagePath, repoPath } from "./helpers/test-paths";

const SRC = packagePath("src");

/** This file names the forbidden call in its own error message, which is code. */
const SELF = "src/__tests__/test-paths.guard.test.ts";

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

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      testFiles(full, out);
      continue;
    }
    if (/\.test\.tsx?$/.test(entry) || full.startsWith(join(SRC, "__tests__", "helpers"))) {
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
   * Mutation: put `process.cwd()` back into any dashboard test (or into a
   * `__tests__/helpers/` module) → red, naming the file.
   */
  it("no test file resolves a path from the cwd", () => {
    const offenders = testFiles(SRC)
      .filter((f) => relative(PACKAGE_ROOT, f) !== SELF)
      .filter((f) => code(readFileSync(f, "utf8")).includes("process.cwd("))
      .map((f) => relative(PACKAGE_ROOT, f));

    expect(
      offenders,
      "Resolve paths from the owning file, not the runner's cwd — " +
        "import PACKAGE_ROOT / REPO_ROOT / readPackageFile / readRepoFile from " +
        "src/__tests__/helpers/test-paths (WARP-2632).",
    ).toEqual([]);
  });

  /**
   * WARP-2654 — one anchoring idiom, not two.
   *
   * Mutation: put `fileURLToPath(import.meta.url)` back into any dashboard
   * test → red, naming the file.
   */
  it("anchors on __dirname everywhere, the idiom vitest.config.ts uses", () => {
    const offenders = testFiles(SRC)
      .filter((f) => relative(PACKAGE_ROOT, f) !== SELF)
      .filter((f) => code(readFileSync(f, "utf8")).includes("import.meta.url"))
      .map((f) => relative(PACKAGE_ROOT, f));

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
  });

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
