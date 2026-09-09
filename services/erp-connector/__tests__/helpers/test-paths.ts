/**
 * WARP-2654 — the one way an erp-connector test finds a file on disk.
 *
 * Every path here is anchored to THIS FILE, never to `process.cwd()`. This
 * package was already clean when the guard beside it was written — every suite
 * here anchors on `import.meta.url` — so the helper exists to keep it that way
 * and to give the per-suite hop counts one place to live, not to repair a live
 * defect. The two failure shapes it forecloses, both observed in other
 * workspaces:
 *
 *   - A `[process.cwd(), join(process.cwd(), <pkg path>)]` candidate list
 *     takes the first entry that EXISTS, and a cwd inside a second checkout of
 *     this repo makes one exist. The suite then asserts a source contract
 *     against that tree while reporting green (WARP-2632 reproduced this in
 *     the dashboard against a decoy directory; ~15 orchestrator schema suites
 *     carried the same shape).
 *   - A cwd-resolved read with no fallback throws at import, and vitest
 *     reports `Tests  no tests` — which is not a failure anyone reads as a gap
 *     (WARP-2654, `tool-selection.parity.test.ts`).
 *
 * `fileURLToPath(import.meta.url)`, which is correct HERE and only here:
 * this package sets `"type": "module"` and compiles with `module: ES2022`, so
 * `import.meta` is available and `__dirname` is not. `apps/orchestrator` and
 * `packages/tools-core` build to CommonJS and must use `__dirname` instead
 * (`import.meta` is TS1470 there). Both spellings anchor to the owning file,
 * which is the invariant — the module system picks which one you write.
 *
 * `fileURLToPath`, NOT `new URL(import.meta.url).pathname` — the latter yields
 * `/C:/…` on Windows, which `path.resolve` doubles into `C:\C:\…`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `<repo>/services/erp-connector/__tests__/helpers` → `<repo>/services/erp-connector`. */
export const PACKAGE_ROOT = resolve(here, "..", "..");

/** The monorepo root that owns `docs/`, `apps/`, `packages/` and `services/`. */
export const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

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
        `Has __tests__/helpers/test-paths.ts moved? (${String(err)})`,
    );
  }
  if (!predicate(pkg)) {
    throw new Error(
      `test-paths: ${dir} is not the ${what}. Has __tests__/helpers/test-paths.ts moved?`,
    );
  }
}

assertAnchor(
  PACKAGE_ROOT,
  (pkg) => (pkg as { name?: string }).name === "@droplet/erp-connector",
  "erp-connector package root",
);
assertAnchor(
  REPO_ROOT,
  (pkg) => Array.isArray((pkg as { workspaces?: unknown }).workspaces),
  "monorepo root (a package.json declaring `workspaces`)",
);

/** An absolute path inside `services/erp-connector`, e.g. `"src/hubspot"`. */
export function packagePath(...relative: string[]): string {
  return resolve(PACKAGE_ROOT, ...relative);
}

/** An absolute path inside the monorepo, e.g. `"docs/security"`. */
export function repoPath(...relative: string[]): string {
  return resolve(REPO_ROOT, ...relative);
}

/**
 * Read a file from `services/erp-connector` as UTF-8. Throws ENOENT naming the
 * absolute path if it is not there — a source assertion must never quietly
 * read a different file than the one it names.
 */
export function readPackageFile(...relative: string[]): string {
  return readFileSync(packagePath(...relative), "utf8");
}

/** Read a file from the monorepo root as UTF-8. Same failure contract. */
export function readRepoFile(...relative: string[]): string {
  return readFileSync(repoPath(...relative), "utf8");
}
