/**
 * WARP-2654 — the one way an orchestrator test finds a file on disk.
 *
 * Every path here is anchored to THIS FILE, never to `process.cwd()`. The
 * distinction is not cosmetic:
 *
 *   - `process.cwd()` is the directory the RUNNER was launched from, which is
 *     `apps/orchestrator` only when someone happened to `cd` there.
 *     `vitest run --root apps/orchestrator` does not chdir (WARP-2613), and a
 *     runner launched from anywhere else leaves cwd somewhere else again.
 *   - The candidate lists this file replaces
 *     (`[process.cwd(), join(process.cwd(), "apps", "orchestrator")]`) did not
 *     fail when cwd was wrong. They took the FIRST entry that existed, and a
 *     cwd sitting in a second checkout of this repo — a sibling worktree, a CI
 *     scratch dir, a rebased copy — makes an entry exist. The suite then
 *     asserts a schema/source contract about files it never read. WARP-2632
 *     reproduced exactly that in the dashboard against a decoy directory.
 *   - The one case that DID fail was worse in a different way:
 *     `tool-selection.parity.test.ts` resolved `src/routes/llm.ts` from cwd, so
 *     from the repo root it died at import with ENOENT and vitest reported
 *     **"no tests"** — 23 assertions of the route↔loop parity gate contributed
 *     nothing, and a file that runs zero tests does not look like a gap.
 *
 * A test file's location relative to its package is a fact the repo already
 * enforces (it is in git); cwd is a property of whoever typed the command. So
 * anchor to the former. Resolution here is a plain `resolve()` with no search:
 * a wrong path raises ENOENT naming the absolute path it tried, instead of
 * silently succeeding against the wrong tree.
 *
 * `__dirname`, NOT `fileURLToPath(import.meta.url)`: this app builds to
 * CommonJS (`module: NodeNext` + no `"type": "module"` in package.json), where
 * `import.meta` is a TS1470 compile error, and `tsconfig.json` includes
 * `src/**\/*` so this file IS typechecked under those flags. `vitest` defines
 * `__dirname` in its CJS-interop module scope. The dashboard is ESM and uses
 * `fileURLToPath(import.meta.url)` for the same purpose; both anchor to the
 * owning file, which is the invariant — the module system picks the spelling.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

/** `<repo>/apps/orchestrator/src/__tests__/helpers` → `<repo>/apps/orchestrator`. */
export const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The monorepo root that owns `docs/`, `scripts/`, `packages/` and `services/`. */
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
  (pkg) => (pkg as { name?: string }).name === "@droplet/orchestrator",
  "orchestrator package root",
);
assertAnchor(
  REPO_ROOT,
  (pkg) => Array.isArray((pkg as { workspaces?: unknown }).workspaces),
  "monorepo root (a package.json declaring `workspaces`)",
);

/** An absolute path inside `apps/orchestrator`, e.g. `"src/routes/llm.ts"`. */
export function packagePath(...relative: string[]): string {
  return path.resolve(PACKAGE_ROOT, ...relative);
}

/** An absolute path inside the monorepo, e.g. `"docs/compliance-progress.md"`. */
export function repoPath(...relative: string[]): string {
  return path.resolve(REPO_ROOT, ...relative);
}

/**
 * Read a file from `apps/orchestrator` as UTF-8. Throws ENOENT naming the
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

/**
 * `apps/orchestrator/prisma`, and the two paths under it that ~15 schema
 * suites each used to rediscover with their own `findPrismaDir()` copy. They
 * are exported as constants rather than re-derived per suite because the
 * duplication is what let the copies disagree about which trees were
 * acceptable.
 */
export const PRISMA_DIR = packagePath("prisma");
export const SCHEMA_PATH = path.join(PRISMA_DIR, "schema.prisma");
export const MIGRATIONS_DIR = path.join(PRISMA_DIR, "migrations");

/** `prisma/schema.prisma` as UTF-8. */
export function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}
