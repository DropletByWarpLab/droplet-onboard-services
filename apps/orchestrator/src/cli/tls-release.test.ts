import { describe, it, expect, vi } from "vitest";

import { runTlsReleaseCli } from "./tls-release.js";
import {
  RELEASE_RESULT_OK,
  type ReleaseDeps,
} from "../services/tls-issuance.service.js";

// ---------------------------------------------------------------------------
// WARP-980 — the tls-release CLI (the DEFAULT factory-reset HQ path).
//
// factory-reset.sh Phase 0b runs `npm run -s tls-release` inside the (still up)
// orchestrator container so HQ gets a SIGNED release: the box frees its NAME +
// revokes the cert but STAYS registered/trusted (self-heals). Mirrors the
// tls-deregister CLI exactly, so the tests mirror it too:
//   - no-op (skipped) when HQ_ISSUANCE_URL is unset (dev/CI box),
//   - otherwise drive releaseFromHq via the real-adapter deps,
//   - NEVER let a failure escape — factory-reset is non-fatal here.
// ---------------------------------------------------------------------------

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDeps(): ReleaseDeps {
  return {
    deviceId: "droplet-test-01",
    hq: { challenge: vi.fn(), release: vi.fn() } as never,
    identity: {
      signWithDeviceKey: vi.fn(),
      getDeviceIdentityStatus: vi.fn(),
    } as never,
    logger,
  };
}

describe("runTlsReleaseCli", () => {
  it("no-ops (skipped) when HQ is not configured — never calls release", async () => {
    const release = vi.fn();
    const result = await runTlsReleaseCli({
      hqConfigured: false,
      deps: makeDeps(),
      release,
      logger,
    });

    expect(result).toBe("skipped");
    expect(release).not.toHaveBeenCalled();
  });

  it("drives releaseFromHq when HQ IS configured", async () => {
    const release = vi.fn(async () => RELEASE_RESULT_OK);
    const deps = makeDeps();
    const result = await runTlsReleaseCli({
      hqConfigured: true,
      deps,
      release,
      logger,
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(deps);
    expect(result).toBe(RELEASE_RESULT_OK);
  });

  it("swallows a thrown release (defence-in-depth — factory-reset is non-fatal)", async () => {
    const release = vi.fn(async () => {
      throw new Error("unexpected");
    });

    const result = await runTlsReleaseCli({
      hqConfigured: true,
      deps: makeDeps(),
      release,
      logger,
    });

    expect(result).toBe("failed");
    expect(logger.warn).toHaveBeenCalled();
  });
});
