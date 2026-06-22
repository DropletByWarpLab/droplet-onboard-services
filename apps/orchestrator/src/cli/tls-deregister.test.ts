import { describe, it, expect, vi } from "vitest";

import { runTlsDeregisterCli } from "./tls-deregister.js";
import {
  DEREGISTER_RESULT_OK,
  type DeregisterDeps,
} from "../services/tls-issuance.service.js";

// ---------------------------------------------------------------------------
// ADR-023 PR-3 — the tls-deregister CLI.
//
// factory-reset.sh Phase 0b runs `npm run -s tls-deregister` inside the (still
// up) orchestrator container while the stack is alive, so HQ gets a SIGNED
// unbind. The CLI must:
//   - no-op (and report skipped) when HQ_ISSUANCE_URL is unset (dev/CI box),
//   - otherwise drive deregisterFromHq via the real-adapter deps,
//   - NEVER let a failure escape — factory-reset is non-fatal here.
// The composition root (exit-0 always) is exercised separately; this tests the
// pure decision function with an injected deregister.
// ---------------------------------------------------------------------------

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDeps(): DeregisterDeps {
  return {
    deviceId: "droplet-test-01",
    hq: { challenge: vi.fn(), deregister: vi.fn() } as never,
    identity: {
      signWithDeviceKey: vi.fn(),
      getDeviceIdentityStatus: vi.fn(),
    } as never,
    logger,
  };
}

describe("runTlsDeregisterCli", () => {
  it("no-ops (skipped) when HQ is not configured — never calls the deregister", async () => {
    const deregister = vi.fn();
    const result = await runTlsDeregisterCli({
      hqConfigured: false,
      deps: makeDeps(),
      deregister,
      logger,
    });

    expect(result).toBe("skipped");
    expect(deregister).not.toHaveBeenCalled();
  });

  it("drives deregisterFromHq when HQ IS configured", async () => {
    const deregister = vi.fn(async () => DEREGISTER_RESULT_OK);
    const deps = makeDeps();
    const result = await runTlsDeregisterCli({
      hqConfigured: true,
      deps,
      deregister,
      logger,
    });

    expect(deregister).toHaveBeenCalledTimes(1);
    expect(deregister).toHaveBeenCalledWith(deps);
    expect(result).toBe(DEREGISTER_RESULT_OK);
  });

  it("swallows a thrown deregister (defence-in-depth — factory-reset is non-fatal)", async () => {
    const deregister = vi.fn(async () => {
      throw new Error("unexpected");
    });

    const result = await runTlsDeregisterCli({
      hqConfigured: true,
      deps: makeDeps(),
      deregister,
      logger,
    });

    // Even an unexpected throw resolves — the CLI never re-raises.
    expect(result).toBe("failed");
    expect(logger.warn).toHaveBeenCalled();
  });
});
