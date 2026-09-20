/**
 * WARP-1872 — run-level environment warning.
 *
 * globalSetup runs ONCE in the main vitest process, which is the only
 * place a run-level notice belongs. The same check in setupFiles printed
 * once per test file (12 copies for update-agent alone, ~200 for a full
 * run) and buried the thing it was meant to surface.
 *
 * Warns LOCALLY — never throws there. `engines.node` is 20.x and CI runs
 * 20, but Node 24 is not what breaks the signature tests: with cosign
 * installed the suite is green on Node 24 (99/99). Failing a developer's
 * run would block a working setup and misname the cause, and this repo
 * has machines with no `nvm`/`fnm` to switch with. See env-preflight.ts.
 *
 * WARP-2626 — but it DOES throw in CI. Every workflow pins the major via
 * `setup-node`, so a mismatch on a runner is not somebody's laptop: it is
 * `.nvmrc` / `engines.node` and a workflow having silently drifted apart.
 * That drift is how a Node-major-sensitive defect reaches the field (the
 * Eaglesoft REST track degraded to "not connected" against a healthy box
 * on Node >= 22), and nothing else in a green run would report it.
 */
import { nodePinVerdict } from "./env-preflight.js";

export default function setup(): void {
  const verdict = nodePinVerdict();
  if (!verdict) return;
  if (verdict.fatal) throw new Error(verdict.message);
  console.warn(verdict.message);
}
