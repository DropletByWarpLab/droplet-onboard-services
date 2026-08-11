/**
 * WARP-1872 — run-level environment warning.
 *
 * globalSetup runs ONCE in the main vitest process, which is the only
 * place a run-level notice belongs. The same check in setupFiles printed
 * once per test file (12 copies for update-agent alone, ~200 for a full
 * run) and buried the thing it was meant to surface.
 *
 * Warns only — never throws. `engines.node` is 20.x and CI runs 20, but
 * Node 24 is not what breaks the signature tests: with cosign installed
 * the suite is green on Node 24 (99/99). Failing the run here would
 * block a working setup and misname the cause. See env-preflight.ts.
 */
import { nodeWarningIfMismatched } from "./env-preflight.js";

export default function setup(): void {
  const warning = nodeWarningIfMismatched();
  if (warning) console.warn(warning);
}
