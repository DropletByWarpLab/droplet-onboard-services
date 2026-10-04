/**
 * WARP-3193 ARCH-1 — import-cycle guard for the orchestrator's `src/`.
 *
 * A RUNTIME cycle is a boot-order hazard: whichever module of the ring loads
 * first sees the others' bindings as `undefined` until they finish, so the
 * first top-level use of one of them throws at boot. The ERP credential chain
 * (erp-provider → saas-credential → integrations → erp-provider) was one; it
 * was broken by moving `credentialsPurgedFor` into the leaf module
 * `services/integration-status.ts`.
 *
 * Two checks, both with dpdm and dynamic `import()` excluded (a lazy import
 * is the sanctioned way to break a cycle):
 *   - runtime graph (type-only imports stripped): exactly RUNTIME_ALLOWLIST.
 *   - full graph (type imports included): exactly TYPE_ALLOWLIST ∪ runtime.
 * "Exactly" in both directions: a new cycle fails, and so does an allowlisted
 * one that no longer exists, so the list can only shrink.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCircular, parseDependencyTree, shortenTree } from "dpdm";

const ROOT = path.resolve(__dirname, "..", "..");

/** Cycles that exist at runtime today. Do not add to this list — fix the cycle. */
const RUNTIME_ALLOWLIST: string[] = [];

/** Cycles made only of `import type` edges (harmless at runtime). Do not add to this list. */
const TYPE_ALLOWLIST = [
  "src/middleware/auth.ts -> src/services/extension-principal.ts",
  "src/services/erp-sync/land-money.ts -> src/services/erp-sync/land.ts",
  "src/services/cloud-connection-state.ts -> src/services/integrations.service.ts",
];

/** Rotate a ring so it starts at its smallest member: one spelling per cycle. */
function canonical(cycle: string[]): string {
  const start = cycle.indexOf([...cycle].sort()[0]);
  return [...cycle.slice(start), ...cycle.slice(0, start)].join(" -> ");
}

async function cycles(transform: boolean): Promise<string[]> {
  const tree = await parseDependencyTree("src/**/*.ts", {
    cwd: ROOT,
    context: ROOT,
    transform,
    skipDynamicImports: true,
    exclude: /node_modules|\.test\.ts$/,
    tsconfig: path.join(ROOT, "tsconfig.json"),
  });
  return [...new Set(parseCircular(shortenTree(ROOT, tree), true).map(canonical))].sort();
}

describe("orchestrator import cycles (WARP-3193 ARCH-1)", () => {
  it("has no runtime import cycle beyond the allowlist", async () => {
    expect(await cycles(true)).toEqual([...RUNTIME_ALLOWLIST].sort());
  }, 180_000);

  it("has no type-level import cycle beyond the allowlist", async () => {
    expect(await cycles(false)).toEqual(
      [...new Set([...RUNTIME_ALLOWLIST, ...TYPE_ALLOWLIST])].sort(),
    );
  }, 180_000);
});
