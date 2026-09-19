/**
 * WARP-1872 — shared helpers for the test-environment preflight.
 *
 * Side-effect free and vitest-free on purpose: imported by the global
 * setup (once per run), the per-file setup (which throws), and the guard
 * test (which pins the claims).
 *
 * See env-preflight.setup.ts for the full rationale.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Test files that exec the real cosign binary, as orchestrator-relative
 * POSIX paths. Derived empirically: with cosign absent these are exactly
 * the files that fail (2 files / 14 tests). The rest of update-agent/ —
 * manifest, apply, verify.toctou — passes untouched because it never
 * reaches a cosign spawn, so failing those would be a regression, not a
 * fix.
 *
 * Pinned by env-preflight.guard.test.ts.
 */
export const COSIGN_DEPENDENT_SUITES: readonly string[] = [
  "src/services/update-agent/verify.test.ts",
  "src/services/update-agent/poller.test.ts",
];

/** apps/orchestrator — this file lives in apps/orchestrator/src/__tests__/. */
export const ORCHESTRATOR_ROOT = path.resolve(__dirname, "../..");

/** Repo root, which owns the only `engines` field in the monorepo. */
export const REPO_ROOT = path.resolve(ORCHESTRATOR_ROOT, "../..");

/** Mirrors verify.ts: DROPLET_COSIGN_BIN env → `cosign` on PATH. */
export function resolveCosignBin(): string {
  return process.env.DROPLET_COSIGN_BIN ?? "cosign";
}

/**
 * Returns the spawn-failure code when cosign cannot be exec'd, else null.
 *
 * Discriminates exactly as verify.ts does: only ENOENT/EACCES mean
 * "unavailable". A binary that exists and exits non-zero is a different
 * problem and is NOT this guard's business to report.
 */
export function cosignSpawnFailure(bin = resolveCosignBin()): string | null {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore", timeout: 30_000 });
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "EACCES" ? code : null;
  }
}

/** Normalise an absolute test path to an orchestrator-relative POSIX path. */
export function toOrchestratorRelative(filepath: string): string {
  return path.relative(ORCHESTRATOR_ROOT, filepath).split(path.sep).join("/");
}

export function isCosignDependent(filepath: string): boolean {
  return COSIGN_DEPENDENT_SUITES.includes(toOrchestratorRelative(filepath));
}

/** `engines.node` from the root package.json (e.g. "20.x"), or null. */
export function requiredNodeRange(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

/** Leading major from a simple range like "20.x" / ">=20" / "20". */
export function majorFromRange(range: string): number | null {
  const m = /(\d+)/.exec(range);
  return m ? Number(m[1]) : null;
}

export function cosignUnavailableMessage(bin: string, code: string): string {
  const via =
    process.env.DROPLET_COSIGN_BIN !== undefined
      ? `DROPLET_COSIGN_BIN=${bin}`
      : "DROPLET_COSIGN_BIN unset, not on PATH";
  return [
    "",
    `✗ cosign not found (${via}) [${code}] — THIS IS THE ENVIRONMENT, NOT A TRUST-CHAIN BUG.`,
    "",
    "  This suite execs the real cosign binary. Without it every verification",
    "  returns `cosign_unavailable`, which looks exactly like a broken OTA",
    "  trust chain (14 tests, including the golden-manifest success case).",
    "  It is not. Nothing is wrong with the signing code.",
    "",
    "  Fix one of:",
    "    winget install sigstore.cosign      (Windows)",
    "    brew install cosign                 (macOS)",
    "    set DROPLET_COSIGN_BIN=/path/to/cosign",
    "",
    "  CI installs it via sigstore/cosign-installer@v3 (.github/workflows/ci.yml),",
    "  which is why CI is green on this same tree. (WARP-1872)",
    "",
  ].join("\n");
}

export function nodeMismatchMessage(range: string, running: string): string {
  return [
    "",
    `⚠ Node ${range} expected (.nvmrc, engines.node, every workflow's setup-node); running ${running}.`,
    "  Switch with:  nvm use   (or `fnm use`) — the repo pins the major on purpose.",
    "",
    "  Known risk on Node 24: vitest worker deaths (see the WARP-1584 note in",
    "  vitest.config.ts). This does NOT cause signature-test failures — if the",
    "  update-agent tests are red, check cosign, not your Node version.",
    "",
    "  WARP-2626 — the class of bug this pin hides: an npm-undici dispatcher is",
    "  only honoured by the undici that minted it, so code pairing one with the",
    "  runtime's BUILT-IN fetch works on Node 20 and throws UND_ERR_INVALID_ARG",
    "  on Node >= 22, where every request degrades to a bare `fetch failed` that",
    "  reads as an unreachable box. Passing here on a mismatched Node is not",
    "  proof the pinned Node is fine, and vice versa.",
    "",
  ].join("\n");
}

/**
 * Is this a CI runner? `CI` is set to a truthy value by GitHub Actions.
 *
 * Treats "0"/"false"/"" as not-CI so a developer who exports CI for an
 * unrelated tool does not get a hard failure they cannot act on.
 */
export function runningInCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/**
 * The Node-pin verdict for a run (WARP-2626).
 *
 * Deliberately asymmetric, and the asymmetry is the whole design:
 *
 *   - **Locally: warn.** This repo has contributors on machines with no
 *     `nvm`/`fnm` installed at all, where the running Node is the only Node.
 *     Hard-failing there (or via `engine-strict=true` in `.npmrc`, which would
 *     break `npm ci` itself) strands every worktree on the machine and buys
 *     nothing — the tests that actually depend on the pin now assert their own
 *     behaviour directly (`api-auth.dispatcher.test.ts`,
 *     `undici-fetch-pairing.guard.test.ts`) rather than relying on the runtime.
 *   - **In CI: fail.** Every workflow pins the major through `setup-node`, so a
 *     mismatch there is never a developer's machine — it is `.nvmrc` /
 *     `engines.node` and a workflow having drifted apart. That drift is exactly
 *     how a Node-major-sensitive defect like WARP-2626 reaches the field, and
 *     it is invisible in a green run otherwise. This turns it into one loud
 *     line at the top of the run.
 *
 * @returns the message to print, and whether it must abort the run.
 */
export function nodePinVerdict(
  running = process.versions.node,
  env: NodeJS.ProcessEnv = process.env,
): { message: string; fatal: boolean } | null {
  const message = nodeWarningIfMismatched(running);
  if (!message) return null;
  return { message, fatal: runningInCi(env) };
}

/** The Node warning text when the running major differs, else null. */
export function nodeWarningIfMismatched(
  running = process.versions.node,
): string | null {
  const range = requiredNodeRange();
  if (!range) return null;
  const wanted = majorFromRange(range);
  if (wanted === null) return null;
  return Number(running.split(".")[0]) === wanted
    ? null
    : nodeMismatchMessage(range, `v${running}`);
}
