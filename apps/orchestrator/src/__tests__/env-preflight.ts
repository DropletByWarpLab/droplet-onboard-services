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
    `⚠ Node ${range} expected (engines.node); running ${running}.`,
    "  Known risk on Node 24: vitest worker deaths (see the WARP-1584 note in",
    "  vitest.config.ts). This does NOT cause signature-test failures — if the",
    "  update-agent tests are red, check cosign, not your Node version.",
    "",
  ].join("\n");
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
