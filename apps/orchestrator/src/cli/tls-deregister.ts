/**
 * ADR-023 PR-3 — `npm run tls-deregister` (signed factory-reset HQ unbind).
 *
 * factory-reset.sh Phase 0b runs this INSIDE the orchestrator container while
 * the stack is still UP (Phase 0b precedes the Phase 1 `down -v`), so the box
 * can reach the device-identity sidecar to sign a fresh HQ challenge and DELETE
 * its HQ registration with the required TPM-PoP body. That replaces the old
 * bodyless `curl -X DELETE` that the deployed HQ Worker 422'd (so HQ never
 * unbound the device).
 *
 * Contract with factory-reset.sh:
 *   - ALWAYS exits 0 — a reset MUST complete even if HQ / the sidecar is down.
 *     Every failure is logged and swallowed; the script treats this as
 *     best-effort and non-fatal (HQ also reaps stale registrations server-side).
 *   - No-ops when HQ_ISSUANCE_URL is unset (dev/CI box, or a never-registered
 *     appliance) — nothing to unbind.
 *
 * Composition mirrors index.ts: the same real adapters (HQ HTTP client +
 * device-identity gRPC client). The testable decision lives in
 * `runTlsDeregisterCli`; `main()` is the thin always-exit-0 composition root.
 */
import { config } from "../config.js";
import {
  deregisterFromHq,
  type DeregisterDeps,
  type DeregisterResult,
  type TlsLogger,
} from "../services/tls-issuance.service.js";
import { createHqIssuanceClient } from "../services/tls-issuance.adapters.js";
import { createDeviceIdentityClient } from "../services/device-identity.client.js";
import { createLogger } from "../lib/logger.js";

export interface RunTlsDeregisterCliArgs {
  /** `!!config.HQ_ISSUANCE_URL` — whether this box is wired to a live HQ. */
  hqConfigured: boolean;
  deps: DeregisterDeps;
  /** Injected for tests; defaults to the real `deregisterFromHq`. */
  deregister?: (deps: DeregisterDeps) => Promise<DeregisterResult>;
  logger: TlsLogger;
}

/**
 * Pure decision: no-op when HQ is unconfigured, otherwise drive the signed
 * deregister. Defence-in-depth: even though `deregisterFromHq` is itself
 * non-throwing, a thrown collaborator here is still swallowed so the CLI can
 * NEVER bubble a failure into factory-reset.
 */
export async function runTlsDeregisterCli(
  args: RunTlsDeregisterCliArgs,
): Promise<DeregisterResult> {
  const { hqConfigured, deps, logger } = args;
  const deregister = args.deregister ?? deregisterFromHq;

  if (!hqConfigured) {
    logger.info(
      {},
      "tls-deregister: HQ_ISSUANCE_URL not configured — nothing to deregister (no-op)",
    );
    return "skipped";
  }

  try {
    return await deregister(deps);
  } catch (err) {
    logger.warn(
      { err },
      "tls-deregister: unexpected error driving HQ deregistration — non-fatal, factory-reset continues",
    );
    return "failed";
  }
}

async function main(): Promise<void> {
  const logger = createLogger("tls-deregister-cli");
  try {
    const deps: DeregisterDeps = {
      deviceId: config.DROPLET_DEVICE_ID,
      hq: createHqIssuanceClient(),
      identity: createDeviceIdentityClient(),
      logger,
    };
    await runTlsDeregisterCli({
      hqConfigured: !!config.HQ_ISSUANCE_URL,
      deps,
      logger,
    });
  } catch (err) {
    // The composition itself failed (e.g. config load) — still non-fatal.
    logger.warn(
      { err },
      "tls-deregister: failed to compose deregistration — non-fatal, factory-reset continues",
    );
  }
}

// Only run when invoked directly (node dist/cli/tls-deregister.js), not on
// import from the test. ALWAYS exit 0 — factory-reset must complete regardless.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.includes("tls-deregister")) {
  void main().finally(() => process.exit(0));
}
