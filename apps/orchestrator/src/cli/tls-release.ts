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

export interface RunTlsReleaseCliArgs {
  /** `!!config.HQ_ISSUANCE_URL` — whether this box is wired to a live HQ. */
  hqConfigured: boolean;
  deps: ReleaseDeps;
  /** Injected for tests; defaults to the real `releaseFromHq`. */
  release?: (deps: ReleaseDeps) => Promise<ReleaseResult>;
  logger: TlsLogger;
}

/**
 * Pure decision: no-op when HQ is unconfigured, otherwise drive the signed
 * release. Defence-in-depth: even though `releaseFromHq` is itself non-throwing,
 * a thrown collaborator here is still swallowed so the CLI can NEVER bubble a
 * failure into factory-reset.
 */
export async function runTlsReleaseCli(
  args: RunTlsReleaseCliArgs,
): Promise<ReleaseResult> {
  const { hqConfigured, deps, logger } = args;
  const release = args.release ?? releaseFromHq;

  if (!hqConfigured) {
    logger.info(
      {},
      "tls-release: HQ_ISSUANCE_URL not configured — nothing to release (no-op)",
    );
    return "skipped";
  }

  try {
    return await release(deps);
  } catch (err) {
    logger.warn(
      { err },
      "tls-release: unexpected error driving HQ release — non-fatal, factory-reset continues",
    );
    return "failed";
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
    // The composition itself failed (e.g. config load) — still non-fatal.
    logger.warn(
      { err },
      "tls-release: failed to compose release — non-fatal, factory-reset continues",
    );
  }
}

// Only run when invoked directly (node dist/cli/tls-release.js), not on import
// from the test. ALWAYS exit 0 — factory-reset must complete regardless.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.includes("tls-release")) {
  void main().finally(() => process.exit(0));
}
