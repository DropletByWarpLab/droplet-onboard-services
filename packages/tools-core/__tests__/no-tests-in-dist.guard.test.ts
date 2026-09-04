/**
 * WARP-2515 — no test file may be compiled into the shipped `dist/`.
 *
 * `tsconfig.json` emits `include: ["src/**\/*"]`, and that glob does not care
 * whether a file is named `*.test.ts`. `src/handlers/pm/pm-orch.test.ts` sat
 * there for months and shipped as `dist/handlers/pm/pm-orch.test.js`, carrying
 * a top-level `require("vitest")` into the orchestrator image — `vitest` is a
 * devDependency, so anything that loaded it in production would have thrown
 * MODULE_NOT_FOUND. Nothing imported it, so it was dead weight rather than a
 * live break, but a devDependency require has no business in a release
 * artefact.
 *
 * The fix was to move that file under `__tests__/`. This guard is what stops
 * the next one: tests belong in `__tests__/`, which `tsconfig.json` excludes
 * from the emit and `tsconfig.test.json` type-checks.
 *
 * Mutation this is written to catch:
 *   - put any `*.test.ts` back under `src/`, rebuild → `dist/` grows a
 *     `*.test.js` and this reds.
 *   - drop a `*.test.js` into `dist/` with no `*.test.ts` beside it in `src/`
 *     → this reds too, and says STALE dist rather than blaming `src/`
 *     (WARP-2620).
 *
 * Asserted against the SOURCE tree, not `dist/`, so the guard is meaningful in
 * a checkout that has never run `npm run build` (a stale or absent `dist/`
 * would otherwise make it vacuously green). The emit rule is mechanical:
 * a `*.test.ts` under `src/` becomes a `*.test.js` under `dist/`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

// `__dirname`, not `import.meta.url`: this package builds to CommonJS, where
// `import.meta` is a TS1470 error (WARP-2502).
const PKG_ROOT = path.resolve(__dirname, "..");

/** Every file under `dir` whose name matches `pred`, relative to `dir`. */
function walk(dir: string, pred: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, pred).map((p) => path.join(entry, p)));
    } else if (pred(entry)) {
      found.push(entry);
    }
  }
  return found;
}

describe("no test file is compiled into dist/ (WARP-2515)", () => {
  it("src/ contains no *.test.ts — those would be emitted into dist/", () => {
    const strays = walk(path.join(PKG_ROOT, "src"), (n) => /\.test\.tsx?$/.test(n));
    expect(
      strays,
      `test files under src/ are emitted into dist/ by tsconfig.json's ` +
        `include: ["src/**/*"], shipping a vitest require into the image. ` +
        `Move them to __tests__/: ${strays.join(", ")}`,
    ).toEqual([]);
  });

  it("dist/ carries no *.test.js, when a build is present", () => {
    const dist = path.join(PKG_ROOT, "dist");
    if (!existsSync(dist)) {
      // Nothing built in this checkout — the src/ assertion above is the
      // load-bearing one and already covers the defect.
      return;
    }
    const emitted = walk(dist, (n) => /\.test\.jsx?$/.test(n));

    // Name the cause, not just the symptom. `tsc` EMITS but never PRUNES, so
    // a `dist/` built before `src/handlers/pm/pm-orch.test.ts` moved under
    // `__tests__/` keeps `dist/handlers/pm/pm-orch.test.js` forever — the
    // guard then reds on a checkout whose `src/` is clean, and the reader has
    // no way to tell that from a real regression. WARP-2620: four implementers
    // hit exactly that on 2026-09-02 and read it as a broken `stage`.
    // Distinguish by asking whether a matching source file still exists.
    const orphaned = emitted.filter(
      (rel) =>
        !existsSync(path.join(PKG_ROOT, "src", rel.replace(/\.jsx?$/, ".ts"))) &&
        !existsSync(path.join(PKG_ROOT, "src", rel.replace(/\.jsx?$/, ".tsx"))),
    );
    const cause =
      orphaned.length === emitted.length
        ? `STALE dist/ — no matching *.test.ts exists under src/ for any of them, ` +
          `so this build predates their move to __tests__/. Your tree is fine; the ` +
          `build output is not. Fix: npm run bootstrap  (or, for this package alone, ` +
          `rm -rf packages/tools-core/dist && npm run build -w packages/tools-core)`
        : `a *.test.ts under src/ is being emitted by tsconfig.json's ` +
          `include: ["src/**/*"], shipping a vitest require into the image. ` +
          `Move it to __tests__/`;

    expect(emitted, `compiled test files found in dist/: ${emitted.join(", ")} — ${cause}`).toEqual(
      [],
    );
  });
});
