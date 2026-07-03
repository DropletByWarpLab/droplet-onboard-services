/**
 * WARP-980 — `npm run tls-release` (signed factory-reset HQ RELEASE).
 *
 * This is the DEFAULT factory-reset HQ path (the full `tls-deregister` is now
 * gated behind `--decommission`). factory-reset.sh Phase 0b runs this INSIDE the
 * orchestrator container while the stack is still UP (Phase 0b precedes the
 * Phase 1 `down -v`), so the box can reach the device-identity sidecar to sign a
 * fresh HQ challenge and POST /api/issuance/release with the TPM-PoP body.
 *
 * Unlike deregister (which DELETES the device from the registry), release FREES
 * the NAME + revokes the cert but KEEPS the device REGISTERED + trusted — so the
 * box self-heals: the durable TPM key stays authoritative and the next rename
 * re-claims a name via device-auth PoP with no token. This AMENDS ADR-023 reset
 * behavior: reset ≠ deregister.
 *
 * Contract with factory-reset.sh (identical to tls-deregister):
 *   - ALWAYS exits 0 — a reset MUST complete even if HQ / the sidecar is down.
 *     Every failure is logged and swallowed; the script treats this as
 *     best-effort and non-fatal (HQ also reaps stale names server-side).
 *   - No-ops when HQ_ISSUANCE_URL is unset (dev/CI box, or a never-registered
 *     appliance) — nothing to release.
 *
 * Composition mirrors tls-deregister.ts: the same real adapters (HQ HTTP client +
 * device-identity gRPC client). The testable decision lives in
 * `runTlsReleaseCli`; `main()` is the thin always-exit-0 composition root.
 */
import fs from "node:fs";
import pino from "pino";
import { config } from "../config.js";
import {
  releaseFromHq,
  type ReleaseDeps,
  type ReleaseResult,
  type TlsLogger,
} from "../services/tls-issuance.service.js";
import { createHqIssuanceClient } from "../services/tls-issuance.adapters.js";
import { createDeviceIdentityClient } from "../services/device-identity.client.js";

/**
 * WARP-1040 — the machine-readable line factory-reset.sh Phase 0b greps.
 * The CLI ALWAYS exits 0 (reset-must-complete contract), so the exit code says
 * nothing about whether HQ actually freed the name; the script branches its
 * operator log (success vs "name may still be reserved at HQ") on this line
 * instead.
 */
export function releaseSentinelLine(result: ReleaseResult): string {
  return `tls-release: result=${result}`;
}

/**
 * Default sentinel emitter — a single stdout line the shell can capture.
 * SYNCHRONOUS on purpose: under `docker compose exec -T` stdout is a pipe, and
 * the composition root hard-exits with `process.exit(0)` (which per Node docs
 * can truncate a still-buffered async stdout write). The sentinel is now
 * load-bearing telemetry for factory-reset.sh Phase 0b, so it must be fully on
 * the pipe before exit — `fs.writeSync(1, …)` guarantees that.
 */
function emitToStdout(line: string): void {
  fs.writeSync(1, `${line}\n`);
}

export interface RunTlsReleaseCliArgs {
  /** `!!config.HQ_ISSUANCE_URL` — whether this box is wired to a live HQ. */
  hqConfigured: boolean;
  deps: ReleaseDeps;
  /** Injected for tests; defaults to the real `releaseFromHq`. */
  release?: (deps: ReleaseDeps) => Promise<ReleaseResult>;
  logger: TlsLogger;
  /** WARP-1040 — where the sentinel line goes; defaults to stdout. */
  emit?: (line: string) => void;
}

/**
 * Pure decision: no-op when HQ is unconfigured, otherwise drive the signed
 * release. Defence-in-depth: even though `releaseFromHq` is itself non-throwing,
 * a thrown collaborator here is still swallowed so the CLI can NEVER bubble a
 * failure into factory-reset. Every path emits the WARP-1040 stdout sentinel
 * (`tls-release: result=…`) before returning; a throwing emitter is swallowed
 * too — telemetry must never break the reset.
 */
export async function runTlsReleaseCli(
  args: RunTlsReleaseCliArgs,
): Promise<ReleaseResult> {
  const { hqConfigured, deps, logger } = args;
  const release = args.release ?? releaseFromHq;
  const emit = args.emit ?? emitToStdout;

  const finish = (result: ReleaseResult): ReleaseResult => {
    try {
      emit(releaseSentinelLine(result));
    } catch {
      // A broken stdout pipe must never turn telemetry into a reset failure.
    }
    return result;
  };

  if (!hqConfigured) {
    logger.info(
      {},
      "tls-release: HQ_ISSUANCE_URL not configured — nothing to release (no-op)",
    );
    return finish("skipped");
  }

  try {
    return finish(await release(deps));
  } catch (err) {
    logger.warn(
      { err },
      "tls-release: unexpected error driving HQ release — non-fatal, factory-reset continues",
    );
    return finish("failed");
  }
}

async function main(): Promise<void> {
  const logger = pino({ name: "tls-release-cli" });
  try {
    const deps: ReleaseDeps = {
      deviceId: config.DROPLET_DEVICE_ID,
      hq: createHqIssuanceClient(),
      identity: createDeviceIdentityClient(),
      logger,
    };
    await runTlsReleaseCli({
      hqConfigured: !!config.HQ_ISSUANCE_URL,
      deps,
      logger,
    });
  } catch (err) {
    // The composition itself failed (e.g. config load) — still non-fatal, but
    // factory-reset.sh must still see a truthful sentinel (WARP-1040).
    logger.warn(
      { err },
      "tls-release: failed to compose release — non-fatal, factory-reset continues",
    );
    try {
      emitToStdout(releaseSentinelLine("failed"));
    } catch {
      // Telemetry must never break the reset.
    }
  }
}

// Only run when invoked directly (node dist/cli/tls-release.js), not on import
// from the test. ALWAYS exit 0 — factory-reset must complete regardless.
// `process.exit(0)` (not `process.exitCode = 0`) is deliberate: the real deps
// include a grpc-js channel to the device-identity sidecar, which can keep the
// event loop alive and would otherwise stall the CLI until factory-reset.sh's
// 90s `timeout` fires on EVERY reset. Truncation of the sentinel is prevented
// by emitting it via fs.writeSync (see emitToStdout), not by deferring exit.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.includes("tls-release")) {
  void main().finally(() => process.exit(0));
}
