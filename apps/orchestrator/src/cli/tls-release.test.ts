import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";

import { runTlsReleaseCli, releaseSentinelLine } from "./tls-release.js";
import {
  RELEASE_RESULT_OK,
  RELEASE_RESULT_FAILED,
  RELEASE_RESULT_SKIPPED,
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
      emit: vi.fn(),
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
      emit: vi.fn(),
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
      emit: vi.fn(),
    });

    expect(result).toBe("failed");
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WARP-1040 — machine-readable stdout sentinel.
//
// The CLI ALWAYS exits 0 (reset-must-complete contract), so factory-reset.sh
// Phase 0b can't learn the real outcome from the exit code. The CLI therefore
// prints a single greppable line — `tls-release: result=ok|skipped|failed` —
// and the script branches its operator log on that instead.
// ---------------------------------------------------------------------------

describe("tls-release stdout sentinel (WARP-1040)", () => {
  it("formats the sentinel line as 'tls-release: result=<result>'", () => {
    expect(releaseSentinelLine(RELEASE_RESULT_OK)).toBe("tls-release: result=ok");
    expect(releaseSentinelLine(RELEASE_RESULT_SKIPPED)).toBe(
      "tls-release: result=skipped",
    );
    expect(releaseSentinelLine(RELEASE_RESULT_FAILED)).toBe(
      "tls-release: result=failed",
    );
  });

  it("emits 'result=skipped' when HQ is not configured", async () => {
    const emit = vi.fn();
    await runTlsReleaseCli({
      hqConfigured: false,
      deps: makeDeps(),
      release: vi.fn(),
      logger,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("tls-release: result=skipped");
  });

  it("emits 'result=ok' when the release succeeded against HQ", async () => {
    const emit = vi.fn();
    await runTlsReleaseCli({
      hqConfigured: true,
      deps: makeDeps(),
      release: vi.fn(async () => RELEASE_RESULT_OK),
      logger,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("tls-release: result=ok");
  });

  it("emits 'result=failed' when the release failed (sentinel result)", async () => {
    const emit = vi.fn();
    await runTlsReleaseCli({
      hqConfigured: true,
      deps: makeDeps(),
      release: vi.fn(async () => RELEASE_RESULT_FAILED),
      logger,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("tls-release: result=failed");
  });

  it("emits 'result=failed' when the release THREW (defence-in-depth path)", async () => {
    const emit = vi.fn();
    await runTlsReleaseCli({
      hqConfigured: true,
      deps: makeDeps(),
      release: vi.fn(async () => {
        throw new Error("unexpected");
      }),
      logger,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("tls-release: result=failed");
  });

  it("writes the sentinel to STDOUT synchronously by default (fs.writeSync — the composition root process.exit(0) must never truncate a buffered async write on the compose-exec pipe)", async () => {
    const write = vi
      .spyOn(fs, "writeSync")
      .mockImplementation(() => 0 as never);
    try {
      await runTlsReleaseCli({
        hqConfigured: true,
        deps: makeDeps(),
        release: vi.fn(async () => RELEASE_RESULT_OK),
        logger,
      });
      expect(write).toHaveBeenCalledWith(1, "tls-release: result=ok\n");
    } finally {
      write.mockRestore();
    }
  });

  it("a throwing emit is swallowed and the result still returns (non-fatal contract)", async () => {
    const emit = vi.fn(() => {
      throw new Error("broken pipe");
    });
    const result = await runTlsReleaseCli({
      hqConfigured: true,
      deps: makeDeps(),
      release: vi.fn(async () => RELEASE_RESULT_OK),
      logger,
      emit,
    });
    expect(result).toBe(RELEASE_RESULT_OK);
  });
});
