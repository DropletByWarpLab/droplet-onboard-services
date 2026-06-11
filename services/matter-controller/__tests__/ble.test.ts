/**
 * WARP-850 — BLE transport registration.
 *
 * Requirement #3: @matter/nodejs-ble is registered into the matter.js
 * environment at PROCESS START (never inside init — the capabilities
 * answer must not flip mid-boot), the HCI id comes from
 * DROPLET_MATTER_BLE_HCI_ID, and the service degrades gracefully to
 * IP-only commissioning when there is no adapter or the native HCI
 * module can't load (Windows dev installs, CI without Bluetooth).
 *
 * The native module is consumed via dynamic import behind an injected
 * `importModule` seam, and the adapter probe + matter.js environment
 * are injected too — so these tests run on any host, with no Bluetooth
 * and no real @matter/nodejs-ble side effects.
 */
import { describe, it, expect, vi } from "vitest";
import { registerBleAtProcessStart, type BleEnvLike } from "../src/ble.js";

function fakeEnv(opts: {
  registersOnEnable?: boolean;
  scannerThrows?: boolean;
} = {}): BleEnvLike & { vars: { set: ReturnType<typeof vi.fn> }; setCalls: Record<string, unknown> } {
  const { registersOnEnable = true, scannerThrows = false } = opts;
  const setCalls: Record<string, unknown> = {};
  let bleRegistered = false;
  return {
    setCalls,
    vars: {
      set: vi.fn((name: string, value: unknown) => {
        setCalls[name] = value;
        // Emulate @matter/nodejs-ble's install.js ServiceBundle hook:
        // flipping `ble.enable` (de)registers the Ble implementation.
        if (name === "ble.enable") {
          bleRegistered = registersOnEnable && value === true;
        }
      }),
    },
    has: () => bleRegistered,
    get: () => ({
      get scanner() {
        if (scannerThrows) {
          throw new Error("ENOENT: bluetooth-hci-socket bindings not found");
        }
        return {};
      },
    }),
  };
}

describe("registerBleAtProcessStart", () => {
  it("registers BLE and reports bleCommissioning=true on the happy path", async () => {
    const env = fakeEnv();
    const importModule = vi.fn().mockResolvedValue({});
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      importModule,
    });
    expect(result.bleCommissioning).toBe(true);
    expect(importModule).toHaveBeenCalledOnce();
    expect(env.setCalls["ble.hci.id"]).toBe(0);
    expect(env.setCalls["ble.enable"]).toBe(true);
  });

  it("passes a non-default HCI id through to the matter.js environment", async () => {
    const env = fakeEnv();
    await registerBleAtProcessStart({
      hciId: 1,
      environment: env,
      adapterPresent: () => true,
      importModule: vi.fn().mockResolvedValue({}),
    });
    expect(env.setCalls["ble.hci.id"]).toBe(1);
  });

  it("degrades to IP-only without touching matter.js when no adapter is present", async () => {
    const env = fakeEnv();
    const importModule = vi.fn();
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => false,
      importModule,
    });
    expect(result.bleCommissioning).toBe(false);
    expect(result.reason).toMatch(/adapter/i);
    expect(importModule).not.toHaveBeenCalled();
    expect(env.vars.set).not.toHaveBeenCalled();
  });

  it("degrades to IP-only when @matter/nodejs-ble cannot be imported", async () => {
    const env = fakeEnv();
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      importModule: vi.fn().mockRejectedValue(new Error("Cannot find module")),
    });
    expect(result.bleCommissioning).toBe(false);
    expect(result.reason).toMatch(/import|module/i);
    expect(env.setCalls["ble.enable"]).toBeUndefined();
  });

  it("degrades to IP-only when the env never registers a Ble implementation", async () => {
    const env = fakeEnv({ registersOnEnable: false });
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      importModule: vi.fn().mockResolvedValue({}),
    });
    expect(result.bleCommissioning).toBe(false);
  });

  it("unregisters and degrades when the native HCI stack fails to load", async () => {
    const env = fakeEnv({ scannerThrows: true });
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      importModule: vi.fn().mockResolvedValue({}),
    });
    expect(result.bleCommissioning).toBe(false);
    expect(result.reason).toMatch(/native|hci|load/i);
    // The failed registration must be rolled back so matter.js never
    // advertises a BLE transport it can't actually drive.
    expect(env.setCalls["ble.enable"]).toBe(false);
  });
});
