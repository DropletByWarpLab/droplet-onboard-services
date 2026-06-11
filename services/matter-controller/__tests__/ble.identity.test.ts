/**
 * BLE package-identity pin (WARP-850 on-box regressions).
 *
 * The first deployed sidecar image hit TWO identity-class failures:
 *  1. Version skew (@matter/main 0.16.10 vs @matter/nodejs-ble 0.16.11
 *     via caret ranges) nested duplicate @matter/general+protocol —
 *     two Environment.default singletons, two Ble symbols.
 *  2. After pinning: the package's install hook registered into the
 *     ESM copy of @matter/general (dynamic import() from our CJS dist
 *     loads the ESM build) while the controller checked the CJS copy —
 *     hook fired in a parallel module universe, has(Ble) stayed false.
 *
 * ble.ts therefore registers EXPLICITLY: load the module, construct
 * NodeJsBle against our environment, env.set(Ble, instance) keyed to
 * OUR Ble symbol. This test pins that chain with the REAL modules and
 * the REAL Environment.default — no seams — so any future skew or
 * loader split that breaks construct-or-register fails CI before it
 * ships. Hardware-free: noble's native load is lazy (first scanner
 * access) and this test deliberately never touches it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Environment } from "@matter/main";
import { Ble } from "@matter/main/protocol";

let registered: unknown;

describe("BLE explicit registration against the real Environment.default", () => {
  beforeEach(() => {
    // Assert no stale Ble state from a previous broken test — catches
    // singleton-leak scenarios early with a clear error rather than a
    // confusing failure inside the test body.
    expect(
      Environment.default.has(Ble),
      "Ble was already registered before test started — check for cross-suite singleton leak",
    ).toBe(false);
  });

  afterEach(() => {
    // Deterministic cleanup: we registered explicitly, so we can
    // deregister explicitly — no hook, no best-effort vars flip.
    if (registered !== undefined) {
      (Environment.default as unknown as {
        delete(type: unknown, instance?: unknown): void;
      }).delete(Ble, registered);
      registered = undefined;
    }
  });

  it("real NodeJsBle constructs against our environment and registers under OUR Ble symbol", async () => {
    const mod = (await import("@matter/nodejs-ble")) as unknown as {
      NodeJsBle: new (options: { environment: unknown }) => unknown;
    };

    const env = Environment.default;
    env.vars.set("ble.hci.id", 0);

    // Construction must accept our environment (fails on version skew
    // where the constructor's expected Environment API drifted).
    registered = new mod.NodeJsBle({ environment: env });

    // Explicit registration keyed to OUR Ble symbol must be visible to
    // OUR env.has — the exact check the CommissioningController runs.
    (env as unknown as { set(type: unknown, instance: unknown): void }).set(
      Ble,
      registered,
    );
    expect(env.has(Ble)).toBe(true);
  });
});
