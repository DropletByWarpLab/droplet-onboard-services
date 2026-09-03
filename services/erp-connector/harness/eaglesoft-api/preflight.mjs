/**
 * Preflight for the live-box suites (WARP-2611).
 *
 * The three suites that drive the dummy Eaglesoft REST box
 * (`api-connector.live.test.ts`, `erp-api-live.test.ts`, `erp-api-e2e.pg.test.ts`)
 * need two things from the machine they run on. Neither is a product concern,
 * both are invisible until the whole suite goes red, and a permanently-red
 * suite on a clean checkout trains everyone to ignore red — so each is probed
 * here and turned into an explicit skip with a reason that says what is missing.
 *
 *   1. The `openssl` CLI, because the harness mints its throwaway private CA
 *      with it (Node has no X.509 signing API). See `certs.mjs`.
 *
 *   2. A Node whose BUILT-IN `fetch` accepts a dispatcher from the `undici`
 *      package this repo installs. The connector trusts the box's private CA by
 *      passing `dispatcher: new Agent({ connect: { ca } })` (built in
 *      `erp-provider.ts:dispatcherForCa`) to `globalThis.fetch`
 *      (`api-auth.ts:resolveFetch`) — certificate verification stays ON, which
 *      is the entire point. That only works while the built-in undici and the
 *      installed one agree on the dispatcher handler interface. They do on Node
 *      20 — the version this repo pins in `.nvmrc`, in `engines.node`, and in
 *      every workflow's `setup-node` — and they do NOT on Node >= 22, where the
 *      built-in moved to undici v7's handler API and rejects an undici@6
 *      `Agent` outright with `UND_ERR_INVALID_ARG: invalid onError method`.
 *      Every request then fails as a bare "fetch failed", which reads exactly
 *      like an unreachable box.
 *
 * The second probe is a real request, not a version comparison: it asks the
 * running runtime the actual question, so it stays correct when Node 20 goes
 * away, when undici is bumped, or when a future Node re-aligns the interface.
 * It runs in a child process (`preflight-probe.mjs`) only because the answer
 * has to be synchronous — see that file.
 *
 * CI runs Node 20 and has openssl, so both gates are open there and nothing is
 * hidden — each suite additionally ASSERTS that, so losing the coverage on a
 * runner is a red test rather than a silent skip.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { opensslAvailable } from "./certs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Node major this repo is pinned to (`.nvmrc`, `engines.node`, CI setup-node). */
const PINNED_NODE_MAJOR = "20";

function installedUndiciVersion() {
  try {
    return createRequire(import.meta.url)("undici/package.json").version;
  } catch {
    return "unknown";
  }
}

/**
 * Will `globalThis.fetch` accept a dispatcher from the installed `undici`?
 *
 * A probe that cannot run at all is reported as SUPPORTED on purpose: this gate
 * exists to replace a confusing red with an explained skip, never to hide one.
 * If the probe is what broke, the suite runs and fails loudly.
 *
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function undiciDispatcherSupported() {
  let probed;
  try {
    const out = execFileSync(process.execPath, [join(HERE, "preflight-probe.mjs")], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    probed = JSON.parse(out);
  } catch {
    return { ok: true, reason: null };
  }
  if (probed?.ok) return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      `Node ${process.version}'s built-in fetch rejects the installed undici@${installedUndiciVersion()} ` +
      `dispatcher (${probed?.detail ?? "unknown error"}) — the CA-trusting one this suite needs. ` +
      `Run on Node ${PINNED_NODE_MAJOR}, which is what .nvmrc, engines.node and CI pin.`,
  };
}

/**
 * Why the live-box suites cannot run here, or `null` when they can.
 *
 * @returns {string | null}
 */
export function liveBoxSkipReason() {
  if (!opensslAvailable()) {
    return (
      "the `openssl` CLI is not on PATH, and the harness mints its throwaway private CA with it " +
      "(harness/eaglesoft-api/certs.mjs — Node has no X.509 signing API)"
    );
  }
  return undiciDispatcherSupported().reason;
}

/**
 * Say WHY a live-box suite is being skipped, once, where the default vitest
 * reporter shows it (as a `stderr | <file>` line above the skipped suite) —
 * so the reason is in the run output rather than only in this file. No-op when
 * the suite runs.
 *
 * Suite titles stay stable on purpose: they are what a `-t` filter and a
 * reporter's history match on.
 *
 * @param {string} suite
 * @param {string | null} reason
 */
export function announceLiveBoxSkip(suite, reason) {
  if (!reason) return;
  console.warn(`[live-box] skipping "${suite}": ${reason}`);
}
