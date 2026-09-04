/**
 * WARP-2632 — the one way a dashboard test finds a file on disk.
 *
 * Every path here is anchored to THIS FILE (`fileURLToPath(import.meta.url)`),
 * never to `process.cwd()`. The distinction is not cosmetic:
 *
 *   - `process.cwd()` is the directory the RUNNER was launched from, which is
 *     the dashboard package only when someone happened to `cd` there.
 *     `vitest run --root apps/web-dashboard` does not chdir (WARP-2613), and a
 *     runner launched from anywhere else leaves cwd somewhere else again.
 *   - The walk-up loops this file replaces (`let dir = process.cwd(); for …`)
 *     did not fail when cwd was wrong — they kept climbing until SOME
 *     directory matched. Given a cwd inside a different checkout, or any
 *     unrelated directory that happens to contain a `docs/integrations/`, they
 *     resolve to that tree and the suite then asserts a source contract about
 *     files it never read. That is the failure mode the comments on those
 *     loops said they were guarding against, and it is the one the loop
 *     created. Proven: with cwd in a scratch directory holding nothing but
 *     `docs/integrations/totally-not-a-provider.md`, the guide-bundling gate
 *     compared the shipped bundle against that scratch directory.
 *
 * A test file's location relative to its package is a fact the repo already
 * enforces (it is in git); cwd is a property of whoever typed the command. So
 * anchor to the former. Resolution here is a plain `resolve()` with no search:
 * a wrong path raises ENOENT naming the absolute path it tried, instead of
 * silently succeeding against the wrong tree.
 *
 * `fileURLToPath`, NOT `new URL(import.meta.url).pathname` — the latter yields
 * `/C:/…` on Windows, which `path.resolve` doubles into `C:\C:\…`. This is the
 * same pattern the a11y source-scrape suites already use
 * (`src/__tests__/a11y.side-panel-close.test.ts`).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `apps/web-dashboard` — the package this helper lives in. */
export const PACKAGE_ROOT = resolve(here, "../../..");

/** The monorepo root that owns `docs/`, `scripts/` and `packages/`. */
export const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

/**
 * Both constants above are hard-coded hop counts, so a move of this file would
 * silently retarget every consumer — precisely the class of bug this helper
 * exists to remove. Check the derivation against something only the real
 * directory has, at import time, and throw with the offending path rather than
 * hand a wrong root to a caller.
 */
function assertAnchor(dir: string, predicate: (pkg: unknown) => boolean, what: string): void {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  } catch (err) {
    throw new Error(
      `test-paths: no readable package.json at ${dir} — expected the ${what}. ` +
        `Has src/__tests__/helpers/test-paths.ts moved? (${String(err)})`,
    );
  }
  if (!predicate(pkg)) {
    throw new Error(
      `test-paths: ${dir} is not the ${what}. ` +
        `Has src/__tests__/helpers/test-paths.ts moved?`,
    );
  }
}

assertAnchor(
  PACKAGE_ROOT,
  (pkg) => (pkg as { name?: string }).name === "@droplet/web-dashboard",
  "web-dashboard package root",
);
assertAnchor(
  REPO_ROOT,
  (pkg) => Array.isArray((pkg as { workspaces?: unknown }).workspaces),
  "monorepo root (a package.json declaring `workspaces`)",
);

/**
 * Anchoring the roots is only half the contract. `resolve(ROOT, relative)`
 * walks straight back out of ROOT for a `../` argument, and an ABSOLUTE
 * argument discards ROOT altogether — so `repoPath("../shared_brain/…")` reads
 * a tree this repo does not own and the caller then asserts a source contract
 * about it. That is the walk-up failure this helper exists to remove, reached
 * through a different door, and the `process.cwd(` guard cannot see it because
 * such a call contains no `process.cwd(`.
 *
 * So resolution is contained, not just anchored: the result must live strictly
 * BELOW the root. `ROOT + sep` rather than a bare `startsWith(ROOT)`, so a
 * sibling directory whose name merely begins with the root's (`…/repo-evil`)
 * is still outside. Throw with both paths — a test that wanted a file outside
 * the tree has a design problem, and a silent wrong-tree read is what we are
 * here to stop.
 */
function contain(root: string, resolved: string, what: string, relative: string): string {
  if (!resolved.startsWith(root + sep)) {
    throw new Error(
      `test-paths: ${JSON.stringify(relative)} resolves to ${resolved}, which is ` +
        `outside the ${what} (${root}). Tests may only read files this repo owns.`,
    );
  }
  return resolved;
}

/** An absolute path inside the dashboard package, e.g. `"src/app/globals.css"`. */
export function packagePath(relative: string): string {
  return contain(
    PACKAGE_ROOT,
    resolve(PACKAGE_ROOT, relative),
    "web-dashboard package",
    relative,
  );
}

/** An absolute path inside the monorepo, e.g. `"docs/integrations"`. */
export function repoPath(relative: string): string {
  return contain(REPO_ROOT, resolve(REPO_ROOT, relative), "monorepo root", relative);
}

/**
 * Read a file from the dashboard package as UTF-8. Throws ENOENT naming the
 * absolute path if it is not there — a source assertion must never quietly
 * read a different file than the one it names.
 */
export function readPackageFile(relative: string): string {
  return readFileSync(packagePath(relative), "utf8");
}

/** Read a file from the monorepo root as UTF-8. Same failure contract. */
export function readRepoFile(relative: string): string {
  return readFileSync(repoPath(relative), "utf8");
}
