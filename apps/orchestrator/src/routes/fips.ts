import { Router } from "express";
import crypto from "node:crypto";

// WARP-229: operator-facing FIPS status endpoint. Mounted under `/_/fips`
// so it sits in the orchestrator's internal namespace alongside /health.
// Mounted BEFORE auth middleware so a stuck-auth incident doesn't hide
// the FIPS state from the operator.
//
// Returns the same shape as the boot self-test's structured log line:
//   { event: "fips_self_test", service: "orchestrator", fips: true,
//     provider: "OpenSSL 3 FIPS" }
//
// Used by:
//   - per-service integration tests (positive + negative path)
//   - scripts/verify-fips.sh (operator runtime check, lands in a future ticket)
//   - the dashboard's Trust Center page (WARP-272, eventual)
//
// We re-probe both `getFips()` and the MD5-rejects invariant on every
// request rather than caching: the cost is negligible and the auditor
// expectation is that the answer is live, not a startup snapshot.

interface FipsStatus {
  event: "fips_self_test";
  service: string;
  fips: boolean;
  provider: string;
}

function probe(service: string): FipsStatus {
  let fipsOn = false;
  try {
    fipsOn = crypto.getFips() === 1;
  } catch {
    fipsOn = false;
  }

  if (!fipsOn) {
    return {
      event: "fips_self_test",
      service,
      fips: false,
      provider: "none",
    };
  }

  // Negative-probe: MD5 must throw under FIPS enforcement.
  try {
    // fips:allowed: fips-selftest-negative-probe
    crypto.createHash("md5").update("fips-status-probe").digest("hex");
    // MD5 succeeded → not enforcing.
    return {
      event: "fips_self_test",
      service,
      fips: false,
      provider: "OpenSSL (FIPS reported but not enforcing)",
    };
  } catch {
    return {
      event: "fips_self_test",
      service,
      fips: true,
      provider: "OpenSSL 3 FIPS",
    };
  }
}

export function createFipsRouter(serviceName = "orchestrator"): Router {
  const router = Router();
  router.get("/_/fips", (_req, res) => {
    const status = probe(serviceName);
    res.status(status.fips ? 200 : 503).json(status);
  });
  return router;
}
