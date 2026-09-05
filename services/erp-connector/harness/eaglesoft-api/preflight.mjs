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
 *   2. A runtime that can carry a request through a dispatcher from the
 *      `undici` package this repo installs. The connector trusts the box's
 *      private CA by passing `dispatcher: new Agent({ connect: { ca } })`
 *      (built in `erp-provider.ts:dispatcherForCa`) into `apiRequest` —
 *      certificate verification stays ON, which is the entire point.
 *
 *      WARP-2626 — this used to be a Node-major question, and it no longer is.
 *      The connector passed that Agent to `globalThis.fetch`, which is the
 *      runtime's OWN bundled undici: Node 20 (the repo pin) bundles undici 6
 *      and accepted it, Node >= 22 bundles undici 7 and rejected it with
 *      `UND_ERR_INVALID_ARG: invalid onError method` before a byte was sent, so
 *      every request failed as a bare "fetch failed" that read exactly like an
 *      unreachable box. `api-auth.ts:resolveFetch` now routes any
 *      dispatcher-carrying request through the npm undici's own `fetch` — the
 *      only fetch that honours an Agent that undici minted — so the live suites
 *      run on any Node major. This probe therefore drives the SAME pairing the
 *      connector does; driving the built-in fetch here would skip the suites on
 *      a runtime that can run them perfectly well.
 *
 * The second probe is a real request, not a version comparison: it asks the
 * running runtime the actual question, so it stays correct when Node 20 goes
 * away, when undici is bumped, and — the case it now exists for — if the
 * connector is ever "simplified" back onto the built-in fetch. It runs in a
 * child process (`preflight-probe.mjs`) only because the answer has to be
 * synchronous — see that file.
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
 * Can this runtime carry a request through the installed `undici`'s dispatcher,
 * using the same fetch the connector pairs it with (WARP-2626)?
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
      `on Node ${process.version}, a request through the installed undici@${installedUndiciVersion()}'s ` +
      `own fetch + dispatcher fails (${probed?.detail ?? "unknown error"}) — that is the CA-trusting ` +
      `path this suite needs (api-auth.ts:resolveFetch). This is NOT the old Node-major mismatch, ` +
      `which WARP-2626 fixed: check that the connector still pairs a dispatcher with undici's own ` +
      `fetch, then that undici itself works. Node ${PINNED_NODE_MAJOR} is what .nvmrc, engines.node and CI pin.`,
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
