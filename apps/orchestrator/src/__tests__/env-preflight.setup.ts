/**
 * WARP-1872 — cosign preflight. Turns a missing binary into a named
 * failure instead of a fake trust-chain break.
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * The update-agent trust tests exec the REAL `cosign verify-blob` binary
 * — that is the point; see verify.test.ts's header: a skipped trust test
 * is a hole. When cosign is not installed, all 14 of them fail as
 * `cosign_unavailable`, including the one named "verifies the golden
 * valid manifest against the test trust anchor".
 *
 * That reads exactly like a broken OTA trust chain. It is not. It is a
 * missing binary: `cosign_unavailable` is reachable from exactly one
 * place, an ENOENT/EACCES spawn failure in verify.ts. CI is green on the
 * same tree because CI installs cosign (sigstore/cosign-installer@v3 in
 * .github/workflows/ci.yml) right before this suite runs.
 *
 * A gate that lies in this direction is expensive twice over: a
 * developer burns hours on a nonexistent crypto regression, and — worse
 * — learns an excuse ("that's just my environment") that will one day
 * wave through a REAL signature regression.
 *
 * WHY IT IS SCOPED, NOT GLOBAL
 * ----------------------------
 * This setup file loads for every orchestrator test. Failing all of them
 * on a missing cosign would be worse than the bug: ~200 other suites
 * (and the other three files in update-agent/) neither need nor exec the
 * binary and pass without it today. So the check runs only for the
 * suites that genuinely exec cosign — COSIGN_DEPENDENT_SUITES, pinned by
 * env-preflight.guard.test.ts. It also keeps the spawn cost off every
 * other file.
 *
 * WHY IT THROWS AT MODULE SCOPE, NOT IN beforeAll
 * -----------------------------------------------
 * Throwing from a `beforeAll` lets the test file load first, so the
 * file's OWN hooks still register — and poller.test.ts's `afterAll` then
 * dies with "Cannot read properties of undefined (reading 'close')"
 * because the server its beforeAll never created is gone. That is a
 * second confusing error stapled to the one we are trying to clarify.
 * Throwing while the setup module is evaluating aborts the file before
 * any of its hooks exist, so the cause is the only thing reported.
 *
 * The Node-major warning lives in env-preflight.globalSetup.ts (once per
 * run, warn-only) — Node version does not cause these failures.
 */
import {
  cosignSpawnFailure,
  cosignUnavailableMessage,
  isCosignDependent,
  resolveCosignBin,
} from "./env-preflight.js";

/**
 * Absolute path of the test file this setup module is being evaluated
 * for. `__vitest_worker__` is a vitest internal; the public
 * `expect.getState().testPath` is undefined in setup files on vitest
 * 1.6, and the `beforeAll(suite => suite.filepath)` argument arrives too
 * late to abort cleanly (see above). Pinned by env-preflight.guard.test.ts
 * so a vitest upgrade that renames this surfaces as a failing guard test
 * rather than a guard that silently protects nothing.
 */
function currentTestFile(): string | undefined {
  return (globalThis as { __vitest_worker__?: { filepath?: string } })
    .__vitest_worker__?.filepath;
}

const filepath = currentTestFile();
if (filepath && isCosignDependent(filepath)) {
  const bin = resolveCosignBin();
  const code = cosignSpawnFailure(bin);
  if (code) throw new Error(cosignUnavailableMessage(bin, code));
}
