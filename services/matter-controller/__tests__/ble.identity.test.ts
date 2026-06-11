/**
 * BLE package-identity pin (WARP-850 on-box regression).
 *
 * The first deployed sidecar image shipped with @matter/main@0.16.10
 * but @matter/nodejs-ble@0.16.11 (caret ranges + lockfile drift).
 * matter.js pins exact versions across its workspace, so npm nested
 * 0.16.11 copies of @matter/general + @matter/protocol under
 * nodejs-ble — TWO Environment.default singletons and TWO Ble symbols.
 * The install hook registered Ble into ITS environment while ble.ts
 * set `ble.enable` on OURS: registration silently no-oped and the box
 * came up IP-only ("ble.enable was set but no Ble implementation
 * registered").
 *
 * This test uses the REAL modules end-to-end — no seams — so any
 * future version skew that splits the package identity fails CI
 * before it ships. It is hardware-free: the install hook constructs
 * NodeJsBle on `ble.enable=true` without touching HCI (the noble
 * native load is lazy, deferred to first scanner access, which this
 * test deliberately never triggers).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Environment } from "@matter/main";
import { Ble } from "@matter/main/protocol";

describe("BLE registration package identity (real modules, no seams)", () => {
  beforeEach(() => {
    // Assert no stale Ble state from a previous broken test — catches
    // singleton-split scenarios early with a clear error rather than a
    // confusing failure inside the test body.
    expect(
      Environment.default.has(Ble),
      "Ble was already registered before test started — check for cross-suite singleton leak"
    ).toBe(false);
  });

  afterEach(() => {
    // Best-effort deregistration: sets ble.enable=false on OUR
    // Environment.default, which unregisters the hook IFF the install
    // hook from @matter/nodejs-ble was bound to the same singleton.
    // In a version-skewed tree the nested copy of @matter/general owns
    // a different Environment.default, so this call is a no-op for that
    // copy — cleanup is silently incomplete, but the beforeEach guard
    // in the next test will catch any residual state.
    Environment.default.vars.set("ble.enable", false);
  });

  it("the nodejs-ble install hook registers into OUR Environment.default under OUR Ble symbol", async () => {
    await import("@matter/nodejs-ble");

    const env = Environment.default;
    env.vars.set("ble.hci.id", 0);
    env.vars.set("ble.enable", true);

    // On a version-skewed tree this is false: the hook lives in a
    // nested @matter/general copy with its own Environment.default
    // and its own Ble key, and our vars.set never even reaches it.
    expect(env.has(Ble)).toBe(true);
  });
});
