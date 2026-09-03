/**
 * WARP-2654 — the one way a tools-core test finds a file on disk.
 *
 * Every path here is anchored to THIS FILE, never to `process.cwd()`. This
 * package was already clean when the guard beside it was written — every
 * suite here anchors on `__dirname` — so the helper exists to keep it that
 * way and to give the four hop-count copies one place to live, not to repair
 * a live defect. The two failure shapes it forecloses, both observed in other
 * workspaces:
 *
 *   - A `[process.cwd(), join(process.cwd(), <pkg path>)]` candidate list
 *     takes the first entry that EXISTS, and a cwd inside a second checkout
 *     of this repo makes one exist. The suite then asserts a source contract
 *     against that tree while reporting green (WARP-2632 reproduced this in
 *     the dashboard against a decoy directory).
 *   - A cwd-resolved read with no fallback throws at import, and vitest
 *     reports `Tests  no tests` — which is not a failure anyone reads as a
 *     gap (WARP-2654, `tool-selection.parity.test.ts`).
 *
 * `__dirname`, NOT `fileURLToPath(import.meta.url)` (WARP-2606): this package
 * builds to CommonJS (`module: NodeNext` + no `"type": "module"`), where
 * `import.meta` is a TS1470 error — and `tsconfig.test.json` deliberately
 * keeps `__tests__/` on the package's own module setting precisely so that
 * error is CAUGHT rather than configured away. `vitest` defines `__dirname`
 * in its CJS-interop module scope. The erp-connector is ESM and uses
 * `fileURLToPath(import.meta.url)` for the same purpose; both anchor to the
 * owning file, which is the invariant — the module system picks the spelling.
 *
 * NOTE for whoever migrates the remaining suites: the four registry drift
 * gates in this package (`registry.test.ts`, `catalog.test.ts`,
 * `tool-routes.test.ts`, `confirmation-interceptor-compat.test.ts`) are
 * deliberately NOT on this helper. `add-llm-tool-skill.test.ts` derives the
 * files each gate reads from its relative value-imports, so importing this
 * helper from a gate adds it to the skill's machine-checked site block. That
 * is correct behaviour, not a bug — but it means each such migration is a
 * documentation change too, and those four gates are already anchored to
 * their own `__dirname`, which is the invariant this ticket is about.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

/** `<repo>/packages/tools-core/__tests__/helpers` → `<repo>/packages/tools-core`. */
export const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

/** The monorepo root that owns `apps/`, `docs/`, `packages/` and `.claude/`. */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

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
    pkg = JSON.parse(readFileSync(path.resolve(dir, "package.json"), "utf8"));
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
  (pkg) => (pkg as { name?: string }).name === "@droplet/tools-core",
  "tools-core package root",
);
assertAnchor(
  REPO_ROOT,
  (pkg) => Array.isArray((pkg as { workspaces?: unknown }).workspaces),
  "monorepo root (a package.json declaring `workspaces`)",
);

/** An absolute path inside `packages/tools-core`, e.g. `"src/handlers"`. */
export function packagePath(...relative: string[]): string {
  return path.resolve(PACKAGE_ROOT, ...relative);
}

/** An absolute path inside the monorepo, e.g. `".claude/skills"`. */
export function repoPath(...relative: string[]): string {
  return path.resolve(REPO_ROOT, ...relative);
}

/**
 * Read a file from `packages/tools-core` as UTF-8. Throws ENOENT naming the
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
