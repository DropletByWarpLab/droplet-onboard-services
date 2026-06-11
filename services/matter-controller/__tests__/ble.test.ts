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
 * Registration is EXPLICIT — construct NodeJsBle, env.set(Ble, ...) —
 * never via the package's install hook. The first deployed image
 * proved the hook can land in a parallel ESM module universe (CJS dist
 * + dynamic import() → ESM @matter/general → different
 * ServiceBundle/Environment singletons) and silently no-op. These
 * fakes therefore model a PLAIN key/value environment with NO hook
 * behavior: if the production code ever regresses to relying on a
 * side effect, every registration assertion here goes red.
 */
import { describe, it, expect, vi } from "vitest";
import { registerBleAtProcessStart, type BleEnvLike } from "../src/ble.js";

class FakeNodeJsBle {
  readonly options: { environment: unknown };
  private readonly scannerThrows: boolean;
  constructor(options: { environment: unknown }, scannerThrows = false) {
    this.options = options;
    this.scannerThrows = scannerThrows;
  }
  get scanner(): unknown {
    if (this.scannerThrows) {
      throw new Error("ENOENT: bluetooth-hci-socket bindings not found");
    }
    return {};
  }
}

function fakeEnv(): BleEnvLike & {
  varCalls: Record<string, unknown>;
  registrations: Map<unknown, unknown>;
  deleteCalls: Array<{ type: unknown; instance: unknown }>;
} {
  const varCalls: Record<string, unknown> = {};
  const registrations = new Map<unknown, unknown>();
  const deleteCalls: Array<{ type: unknown; instance: unknown }> = [];
  return {
    varCalls,
    registrations,
    deleteCalls,
    vars: {
      set: vi.fn((name: string, value: unknown) => {
        varCalls[name] = value;
      }),
    },
    set: (type, instance) => {
      registrations.set(type, instance);
    },
    delete: (type, instance) => {
      deleteCalls.push({ type, instance });
      registrations.delete(type);
    },
    has: (type) => registrations.has(type),
    get: (type) => registrations.get(type),
  };
}

function moduleWith(scannerThrows = false) {
  return {
    NodeJsBle: class extends FakeNodeJsBle {
      constructor(options: { environment: unknown }) {
        super(options, scannerThrows);
      }
    },
  };
}

describe("registerBleAtProcessStart", () => {
  it("constructs NodeJsBle against the given environment, registers it explicitly, and reports true", async () => {
    const env = fakeEnv();
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      loadModule: () => moduleWith(),
    });
    expect(result.bleCommissioning).toBe(true);
    expect(env.varCalls["ble.hci.id"]).toBe(0);
    // Exactly one explicit registration, and the instance was built
    // against OUR environment (not some ambient singleton).
    expect(env.registrations.size).toBe(1);
    const instance = [...env.registrations.values()][0] as FakeNodeJsBle;
    expect(instance.options.environment).toBe(env);
  });

  it("passes a non-default HCI id through before construction", async () => {
    const env = fakeEnv();
    await registerBleAtProcessStart({
      hciId: 1,
      environment: env,
      adapterPresent: () => true,
      loadModule: () => moduleWith(),
    });
    expect(env.varCalls["ble.hci.id"]).toBe(1);
  });

  it("degrades to IP-only without touching matter.js when no adapter is present", async () => {
    const env = fakeEnv();
    const loadModule = vi.fn();
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => false,
      loadModule,
    });
    expect(result.bleCommissioning).toBe(false);
    expect(result.reason).toMatch(/adapter/i);
    expect(loadModule).not.toHaveBeenCalled();
    expect(env.vars.set).not.toHaveBeenCalled();
    expect(env.registrations.size).toBe(0);
  });

  it("degrades to IP-only when @matter/nodejs-ble cannot be loaded", async () => {
    const env = fakeEnv();
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      loadModule: () => {
        throw new Error("Cannot find module");
      },
    });
    expect(result.bleCommissioning).toBe(false);
    expect(result.reason).toMatch(/load|module/i);
    expect(env.registrations.size).toBe(0);
  });

  it("degrades to IP-only when NodeJsBle construction throws, registering nothing", async () => {
    const env = fakeEnv();
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      loadModule: () => ({
        NodeJsBle: class {
          constructor() {
            throw new Error("incompatible environment");
          }
        },
      }),
    });
    expect(result.bleCommissioning).toBe(false);
    expect(result.reason).toMatch(/construction/i);
    expect(env.registrations.size).toBe(0);
  });

  it("rolls the registration back and degrades when the native HCI stack fails to load", async () => {
    const env = fakeEnv();
    const result = await registerBleAtProcessStart({
      hciId: 0,
      environment: env,
      adapterPresent: () => true,
      loadModule: () => moduleWith(true),
    });
    expect(result.bleCommissioning).toBe(false);
    expect(result.reason).toMatch(/native|hci|load/i);
    // The failed registration must be rolled back so matter.js never
    // advertises a BLE transport it can't actually drive — and the
    // delete must hand back the SAME instance that was registered.
    expect(env.registrations.size).toBe(0);
    expect(env.deleteCalls).toHaveLength(1);
    expect(env.deleteCalls[0].instance).toBeInstanceOf(FakeNodeJsBle);
  });
});
