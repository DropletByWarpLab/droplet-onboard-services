/**
 * WARP-850 — controller core unit tests.
 *
 * The core is the matter.js ownership layer extracted from the
 * orchestrator's matter.service.ts. matter.js itself is injected via
 * `createController` so these tests drive the full
 * commission/decommission/command/listing surface against a fake
 * CommissioningController — no network, no BLE, no storage daemon.
 *
 * The pairing-code paths use the Matter spec test vectors (QR
 * `MT:Y.K9042C00KA0648G00` / manual `34970112332`, both passcode
 * 20202021) so the codec integration is real, not mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeStates } from "@project-chip/matter.js/device";
import {
  createMatterControllerCore,
  resolveWifiNetwork,
  resolveWifiSsid,
  MATTER_ENV_ID,
  type ControllerLike,
  type MatterControllerCore,
} from "../src/controller.js";

const QR_PAIRING_CODE = "MT:Y.K9042C00KA0648G00";
const MANUAL_PAIRING_CODE = "34970112332";
const SPEC_TEST_PASSCODE = 20202021;

function fakeEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      descriptor: {
        deviceTypeList: [{ deviceType: 0x0100, revision: 1 }],
        serverList: [0x0006],
      },
      onOff: { onOff: true },
    },
    commands: {
      onOff: { on: vi.fn(), off: vi.fn(), toggle: vi.fn() },
      colorControl: {
        moveToHueAndSaturation: vi.fn(),
        moveToColorTemperature: vi.fn(),
      },
      windowCovering: {
        upOrOpen: vi.fn(),
        downOrClose: vi.fn(),
        stopMotion: vi.fn(),
        goToLiftPercentage: vi.fn(),
      },
      mediaPlayback: { play: vi.fn(), pause: vi.fn(), stop: vi.fn() },
    },
    ...overrides,
  };
}

function fakeNode(overrides: Record<string, unknown> = {}) {
  const attributeChanged = { on: vi.fn() };
  const stateChanged = { on: vi.fn() };
  return {
    parts: new Map<number, unknown>([
      [0, fakeEndpoint({ state: { descriptor: { deviceTypeList: [], serverList: [] } } })],
      [1, fakeEndpoint()],
    ]),
    basicInformation: {
      nodeLabel: "Test Lamp",
      productName: "Lamp",
      vendorName: "Acme",
      vendorId: 0xfff1,
      productId: 0x8000,
      serialNumber: "SN-1",
    },
    connectionState: NodeStates.Connected,
    events: { attributeChanged, stateChanged },
    decommission: vi.fn().mockResolvedValue(undefined),
    triggerReconnect: vi.fn(),
    ...overrides,
  };
}

function fakeController(overrides: Partial<ControllerLike> = {}): ControllerLike {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getCommissionedNodes: vi.fn().mockReturnValue([]),
    isNodeCommissioned: vi.fn().mockReturnValue(true),
    commissionNode: vi.fn().mockResolvedValue(1n),
    getNode: vi.fn().mockResolvedValue(fakeNode()),
    removeNode: vi.fn().mockResolvedValue(undefined),
    discoverCommissionableDevices: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function buildCore(controller: ControllerLike): MatterControllerCore {
  return createMatterControllerCore({
    storagePath: ".data/matter-controller-test",
    adminFabricLabel: "Droplet Test",
    createController: () => controller,
  });
}

describe("createMatterControllerCore", () => {
  let controller: ControllerLike;
  let core: MatterControllerCore;

  beforeEach(async () => {
    controller = fakeController();
    core = buildCore(controller);
    await core.init();
  });

  it("starts the injected controller and reports initialized", () => {
    expect(controller.start).toHaveBeenCalledOnce();
    expect(core.isInitialized()).toBe(true);
  });

  it("throws on every data call before init", async () => {
    const cold = buildCore(fakeController());
    await expect(cold.commission(MANUAL_PAIRING_CODE)).rejects.toThrow(
      /not initialized/i,
    );
    await expect(cold.listDevices()).rejects.toThrow(/not initialized/i);
    await expect(cold.discover(5000)).rejects.toThrow(/not initialized/i);
  });

  describe("commission", () => {
    it("decodes a QR pairing code and passes the spec passcode to matter.js", async () => {
      const result = await core.commission(QR_PAIRING_CODE);
      expect(result).toEqual({ nodeId: "1" });
      const options = (controller.commissionNode as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(options.passcode).toBe(SPEC_TEST_PASSCODE);
      expect(options.discovery.identifierData.longDiscriminator).toBeDefined();
    });

    it("decodes a manual pairing code with a short discriminator", async () => {
      await core.commission(MANUAL_PAIRING_CODE);
      const options = (controller.commissionNode as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(options.passcode).toBe(SPEC_TEST_PASSCODE);
      expect(options.discovery.identifierData.shortDiscriminator).toBeDefined();
    });

    it("rethrows matter.js errors UNTRANSLATED — class name and message intact", async () => {
      class CommissionableDeviceDiscoveryFailedError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CommissionableDeviceDiscoveryFailedError";
        }
      }
      const raw = new CommissionableDeviceDiscoveryFailedError(
        'No device discovered using identifier {"shortDiscriminator":7}! Please check that the relevant device is online.',
      );
      (controller.commissionNode as ReturnType<typeof vi.fn>).mockRejectedValue(raw);
      await expect(core.commission(MANUAL_PAIRING_CODE)).rejects.toBe(raw);
    });

    it("wires node listeners so attribute changes fan out as state_changed", async () => {
      const node = fakeNode();
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await core.commission(QR_PAIRING_CODE);

      const events: unknown[] = [];
      core.events.on("state_changed", (e) => events.push(e));

      const attributeListener = (
        node.events as { attributeChanged: { on: ReturnType<typeof vi.fn> } }
      ).attributeChanged.on.mock.calls[0][0];
      attributeListener({ path: "1/onOff/onOff", value: false });

      expect(events).toEqual([
        { nodeId: "1", path: "1/onOff/onOff", value: false },
      ]);
    });
  });

  describe("Wi-Fi provisioning for BLE-first devices (WARP-895)", () => {
    function coreWithWifi(
      wifi: {
        wifiSsid?: string;
        wifiSsidFile?: string;
        wifiPsk?: string;
        wifiPskFile?: string;
        regulatoryCountryCode?: string;
      },
      ctl: ControllerLike,
    ): MatterControllerCore {
      return createMatterControllerCore({
        storagePath: ".data/matter-controller-test",
        adminFabricLabel: "Droplet Test",
        createController: () => ctl,
        ...wifi,
      });
    }

    function optionsOf(ctl: ControllerLike) {
      return (ctl.commissionNode as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }

    it("omits wifiNetwork when no SSID is configured (on-network-only, unchanged)", async () => {
      // `core`/`controller` from the outer beforeEach carry no wifi opts.
      await core.commission(QR_PAIRING_CODE);
      expect(optionsOf(controller).commissioning.wifiNetwork).toBeUndefined();
    });

    it("hands the env-supplied SSID + PSK to matter.js as wifiNetwork", async () => {
      const ctl = fakeController();
      const c = coreWithWifi({ wifiSsid: "Droplet", wifiPsk: "s3cret-psk" }, ctl);
      await c.init();
      await c.commission(MANUAL_PAIRING_CODE);
      expect(optionsOf(ctl).commissioning.wifiNetwork).toEqual({
        wifiSsid: "Droplet",
        wifiCredentials: "s3cret-psk",
      });
    });

    it("prefers the PSK file (per-box AP PSK) over the env PSK and trims it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "matter-psk-"));
      const pskFile = join(dir, "ap-psk");
      writeFileSync(pskFile, "file-psk-value\n");
      try {
        const ctl = fakeController();
        const c = coreWithWifi(
          { wifiSsid: "Droplet", wifiPsk: "env-psk", wifiPskFile: pskFile },
          ctl,
        );
        await c.init();
        await c.commission(QR_PAIRING_CODE);
        expect(optionsOf(ctl).commissioning.wifiNetwork).toEqual({
          wifiSsid: "Droplet",
          wifiCredentials: "file-psk-value",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back to the env PSK when the file is absent (AP not provisioned yet)", async () => {
      const ctl = fakeController();
      const c = coreWithWifi(
        { wifiSsid: "Droplet", wifiPsk: "env-psk", wifiPskFile: "/nonexistent/ap-psk" },
        ctl,
      );
      await c.init();
      await c.commission(QR_PAIRING_CODE);
      expect(optionsOf(ctl).commissioning.wifiNetwork).toEqual({
        wifiSsid: "Droplet",
        wifiCredentials: "env-psk",
      });
    });

    it("omits wifiNetwork when an SSID is set but no PSK resolves", async () => {
      const ctl = fakeController();
      const c = coreWithWifi({ wifiSsid: "Droplet" }, ctl);
      await c.init();
      await c.commission(QR_PAIRING_CODE);
      expect(optionsOf(ctl).commissioning.wifiNetwork).toBeUndefined();
    });

    // WARP-1035: resolveWifiNetwork is exported so the /capabilities route
    // can answer `wifiProvisioning` from the SAME resolution the commission
    // path uses — one truth, no drift between the wizard's answer and what
    // commissioning actually does.
    it("resolveWifiNetwork resolves a network when SSID + PSK are available (capabilities: wifiProvisioning=true)", async () => {
      await expect(
        resolveWifiNetwork({ wifiSsid: "Droplet", wifiPsk: "s3cret-psk" }),
      ).resolves.toEqual({ wifiSsid: "Droplet", wifiCredentials: "s3cret-psk" });
    });

    it("resolveWifiNetwork is undefined when nothing is configured (capabilities: wifiProvisioning=false)", async () => {
      await expect(resolveWifiNetwork({})).resolves.toBeUndefined();
      await expect(
        resolveWifiNetwork({ wifiSsid: "Droplet" }),
      ).resolves.toBeUndefined();
      await expect(
        resolveWifiNetwork({ wifiPsk: "s3cret-psk" }),
      ).resolves.toBeUndefined();
    });

    it("passes the configured regulatory country through", async () => {
      const ctl = fakeController();
      const c = coreWithWifi({ regulatoryCountryCode: "US" }, ctl);
      await c.init();
      await c.commission(QR_PAIRING_CODE);
      expect(optionsOf(ctl).commissioning.regulatoryCountryCode).toBe("US");
    });

    // WARP-1363: the env SSID is written once at setup and goes stale on an
    // AP rename (claim / wizard Wi-Fi save) — the commissionee then scans
    // for a network that no longer broadcasts and answers NetworkNotFound
    // (proven live on .87: env said "Droplet", the AP broadcast "WarpLab").
    // The SSID therefore resolves file-first per commission, like the PSK.
    it("prefers the SSID file (live AP SSID) over the stale env SSID and trims it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "matter-ssid-"));
      const ssidFile = join(dir, "ap-ssid");
      writeFileSync(ssidFile, "WarpLab\n");
      try {
        const ctl = fakeController();
        const c = coreWithWifi(
          { wifiSsid: "Droplet", wifiSsidFile: ssidFile, wifiPsk: "s3cret-psk" },
          ctl,
        );
        await c.init();
        await c.commission(MANUAL_PAIRING_CODE);
        expect(optionsOf(ctl).commissioning.wifiNetwork).toEqual({
          wifiSsid: "WarpLab",
          wifiCredentials: "s3cret-psk",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back to the env SSID when the SSID file is absent (attach not yet run)", async () => {
      const ctl = fakeController();
      const c = coreWithWifi(
        {
          wifiSsid: "Droplet",
          wifiSsidFile: "/nonexistent/ap-ssid",
          wifiPsk: "s3cret-psk",
        },
        ctl,
      );
      await c.init();
      await c.commission(QR_PAIRING_CODE);
      expect(optionsOf(ctl).commissioning.wifiNetwork).toEqual({
        wifiSsid: "Droplet",
        wifiCredentials: "s3cret-psk",
      });
    });

    it("resolveWifiSsid mirrors the commission-path resolution for /capabilities apSsid", async () => {
      const dir = mkdtempSync(join(tmpdir(), "matter-ssid-"));
      const ssidFile = join(dir, "ap-ssid");
      writeFileSync(ssidFile, "WarpLab\n");
      try {
        await expect(
          resolveWifiSsid({ wifiSsid: "Droplet", wifiSsidFile: ssidFile }),
        ).resolves.toBe("WarpLab");
        await expect(
          resolveWifiSsid({ wifiSsid: "Droplet", wifiSsidFile: "/nonexistent/x" }),
        ).resolves.toBe("Droplet");
        await expect(resolveWifiSsid({})).resolves.toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("an empty SSID file falls back to the env SSID (never provisions a blank SSID)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "matter-ssid-"));
      const ssidFile = join(dir, "ap-ssid");
      writeFileSync(ssidFile, "\n");
      try {
        const ctl = fakeController();
        const c = coreWithWifi(
          { wifiSsid: "Droplet", wifiSsidFile: ssidFile, wifiPsk: "s3cret-psk" },
          ctl,
        );
        await c.init();
        await c.commission(QR_PAIRING_CODE);
        expect(optionsOf(ctl).commissioning.wifiNetwork).toEqual({
          wifiSsid: "Droplet",
          wifiCredentials: "s3cret-psk",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // WARP-1362: without discoveryCapabilities matter.js runs the mDNS scanner
  // ONLY — the BLE scanner never starts even with the transport registered,
  // so a freshly-reset BLE-first device is undiscoverable by pairing code
  // (proven live on .87: "1 scanners" vs "2 scanners" in PeerCommissioner).
  describe("discovery capabilities (WARP-1362)", () => {
    function coreWithBle(ctl: ControllerLike): MatterControllerCore {
      return createMatterControllerCore({
        storagePath: ".data/matter-controller-test",
        adminFabricLabel: "Droplet Test",
        createController: () => ctl,
        bleCommissioning: true,
      });
    }

    function optionsOf(ctl: ControllerLike) {
      return (ctl.commissionNode as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }

    it("always scans the IP network, and NOT BLE when the transport is absent", async () => {
      await core.commission(MANUAL_PAIRING_CODE);
      expect(optionsOf(controller).discovery.discoveryCapabilities).toEqual({
        onIpNetwork: true,
      });
    });

    it("adds the BLE scanner for a manual pairing code when BLE is registered", async () => {
      const ctl = fakeController();
      const c = coreWithBle(ctl);
      await c.init();
      await c.commission(MANUAL_PAIRING_CODE);
      expect(optionsOf(ctl).discovery.discoveryCapabilities).toEqual({
        onIpNetwork: true,
        ble: true,
      });
    });

    it("adds the BLE scanner for a QR pairing code too (the QR bits are deliberately superseded)", async () => {
      const ctl = fakeController();
      const c = coreWithBle(ctl);
      await c.init();
      await c.commission(QR_PAIRING_CODE);
      expect(optionsOf(ctl).discovery.discoveryCapabilities).toEqual({
        onIpNetwork: true,
        ble: true,
      });
    });

    // Sibling of the commission() fix above: discover() backs GET /discover
    // (the "scan for nearby devices" list), and hit the identical bug — an
    // omitted discoveryCapabilities defaults matter.js's collectScanners()
    // to mDNS-only, so a freshly-reset BLE-first device never appears.
    it("discover() always scans the IP network, and NOT BLE when the transport is absent", async () => {
      await core.discover(5000);
      expect(controller.discoverCommissionableDevices).toHaveBeenCalledWith(
        expect.anything(),
        { onIpNetwork: true },
        undefined,
        5000,
      );
    });

    it("discover() adds the BLE scanner when BLE is registered", async () => {
      const ctl = fakeController();
      const c = coreWithBle(ctl);
      await c.init();
      await c.discover(5000);
      expect(ctl.discoverCommissionableDevices).toHaveBeenCalledWith(
        expect.anything(),
        { onIpNetwork: true, ble: true },
        undefined,
        5000,
      );
    });
  });

  describe("decommission", () => {
    it("prefers the graceful node.decommission()", async () => {
      const node = fakeNode();
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await core.decommission("1");
      expect(node.decommission).toHaveBeenCalledOnce();
      expect(controller.removeNode).not.toHaveBeenCalled();
    });

    it("falls back to removeNode(nodeId, false) when graceful decommission throws", async () => {
      const node = fakeNode({
        decommission: vi.fn().mockRejectedValue(new Error("unreachable")),
      });
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await core.decommission("1");
      expect(controller.removeNode).toHaveBeenCalledWith(expect.anything(), false);
    });

    it("returns false without touching getNode when the node isn't commissioned", async () => {
      // Mirror of getDevice's guard: getNode throws an untyped matter.js
      // error for unknown nodeIds, which the HTTP layer could only
      // report as a 500 — the boolean lets the route 404 instead
      // (pr-reviewer finding 4, 2026-06-11).
      (controller.isNodeCommissioned as ReturnType<typeof vi.fn>).mockReturnValue(
        false,
      );
      await expect(core.decommission("1")).resolves.toBe(false);
      expect(controller.getNode).not.toHaveBeenCalled();
      expect(controller.removeNode).not.toHaveBeenCalled();
    });

    it("returns true after a successful decommission", async () => {
      const node = fakeNode();
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await expect(core.decommission("1")).resolves.toBe(true);
    });
  });

  describe("reconnect (WARP-1469)", () => {
    it("triggers a non-blocking reconnect on the paired node", async () => {
      const node = fakeNode({ connectionState: NodeStates.Disconnected });
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await expect(core.reconnect("1")).resolves.toBe(true);
      expect(node.triggerReconnect).toHaveBeenCalledOnce();
    });

    it("returns false without touching getNode when the node isn't commissioned", async () => {
      // Same guard as decommission: an uncommissioned nodeId is the
      // route's 404, not a matter.js getNode throw surfaced as a 500.
      (controller.isNodeCommissioned as ReturnType<typeof vi.fn>).mockReturnValue(
        false,
      );
      await expect(core.reconnect("1")).resolves.toBe(false);
      expect(controller.getNode).not.toHaveBeenCalled();
    });

    it("does not decommission or remove the node — reconnect keeps the pairing", async () => {
      const node = fakeNode({ connectionState: NodeStates.Disconnected });
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await core.reconnect("1");
      expect(node.decommission).not.toHaveBeenCalled();
      expect(controller.removeNode).not.toHaveBeenCalled();
    });
  });

  describe("set_hvac_mode (KAN-7)", () => {
    // A thermostat endpoint: present `state.thermostat` (the guard the
    // sidecar uses to know the cluster exists) + a cluster client whose
    // setAttribute the write lands on.
    function thermostatEndpoint(setAttribute = vi.fn().mockResolvedValue(undefined)) {
      return {
        state: {
          descriptor: {
            deviceTypeList: [{ deviceType: 0x0301, revision: 1 }],
            serverList: [0x0201],
          },
          thermostat: { systemMode: 4 },
        },
        commands: {},
        getClusterClient: vi.fn((name: string) =>
          name === "thermostat" ? { setAttribute } : undefined,
        ),
      };
    }

    function thermostatNode(endpoint: ReturnType<typeof thermostatEndpoint>) {
      return fakeNode({
        parts: new Map<number, unknown>([
          [0, fakeEndpoint({ state: { descriptor: { deviceTypeList: [], serverList: [] } } })],
          [1, endpoint],
        ]),
      });
    }

    it.each([
      ["off", 0],
      ["auto", 1],
      ["cool", 3],
      ["heat", 4],
    ])("writes systemMode=%i for mode %s", async (mode, expectedEnum) => {
      const setAttribute = vi.fn().mockResolvedValue(undefined);
      const node = thermostatNode(thermostatEndpoint(setAttribute));
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);

      const result = await core.sendCommand("1", "set_hvac_mode", { mode });

      expect(result).toEqual({ status: "ok" });
      expect(setAttribute).toHaveBeenCalledWith("systemMode", expectedEnum);
    });

    it("throws honestly when the thermostat cluster is absent (not a thermostat)", async () => {
      // A plain on/off node — no `state.thermostat`.
      const node = fakeNode();
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await expect(
        core.sendCommand("1", "set_hvac_mode", { mode: "heat" }),
      ).rejects.toThrow(/thermostat cluster/i);
    });

    it("rejects an unsupported mode without writing", async () => {
      const setAttribute = vi.fn().mockResolvedValue(undefined);
      const node = thermostatNode(thermostatEndpoint(setAttribute));
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await expect(
        core.sendCommand("1", "set_hvac_mode", { mode: "turbo" }),
      ).rejects.toThrow(/unsupported.*mode|invalid.*mode/i);
      expect(setAttribute).not.toHaveBeenCalled();
    });

    it("propagates the sidecar write error HONESTLY when the device rejects the mode", async () => {
      // Not every thermostat accepts every systemMode write — a device that
      // rejects `off` must surface the raw matter.js error, not a fabricated ok.
      const rejected = new Error("Matter status 0x87 (ConstraintError): systemMode not writable");
      const setAttribute = vi.fn().mockRejectedValue(rejected);
      const node = thermostatNode(thermostatEndpoint(setAttribute));
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await expect(
        core.sendCommand("1", "set_hvac_mode", { mode: "off" }),
      ).rejects.toBe(rejected);
    });
  });

  describe("sendCommand", () => {
    it("dispatches turn_on to the first functional endpoint's onOff cluster", async () => {
      const node = fakeNode();
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      const result = await core.sendCommand("1", "turn_on");
      expect(result).toEqual({ status: "ok" });
      const ep = node.parts.get(1) as ReturnType<typeof fakeEndpoint>;
      expect(ep.commands.onOff.on).toHaveBeenCalledOnce();
    });

    // WARP-1366: onOff.on/off/toggle take a VOID request. matter.js validates
    // the payload against the cluster schema and rejects a substituted {}
    // (ValidationDatatypeMismatchError) — which made every commissioned
    // on/off device uncontrollable on the real box. The invocation must pass
    // NO payload for no-arg commands.
    it("invokes void commands (on/off/toggle) with no payload, not {}", async () => {
      const node = fakeNode();
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      const ep = node.parts.get(1) as ReturnType<typeof fakeEndpoint>;
      await core.sendCommand("1", "turn_on");
      await core.sendCommand("1", "turn_off");
      await core.sendCommand("1", "toggle");
      expect(ep.commands.onOff.on).toHaveBeenCalledWith(undefined);
      expect(ep.commands.onOff.off).toHaveBeenCalledWith(undefined);
      expect(ep.commands.onOff.toggle).toHaveBeenCalledWith(undefined);
    });

    it("refuses commands to a disconnected node", async () => {
      const node = fakeNode({ connectionState: NodeStates.Disconnected });
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await expect(core.sendCommand("1", "turn_on")).rejects.toThrow(
        /not connected/i,
      );
    });

    it("rejects unknown commands", async () => {
      const node = fakeNode();
      (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
      await expect(core.sendCommand("1", "warp_drive")).rejects.toThrow(
        /unknown command/i,
      );
    });

    // WARP-1371: the market-common device command surface. Each case pins the
    // cluster routing AND the UX->Matter unit conversion.
    describe("device command surface (WARP-1371)", () => {
      async function ep(command: string, data?: Record<string, unknown>) {
        const node = fakeNode();
        (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
        await core.sendCommand("1", command, data);
        return node.parts.get(1) as ReturnType<typeof fakeEndpoint>;
      }

      it("set_color converts degrees/percent to Matter 0-254 hue/sat", async () => {
        const e = await ep("set_color", { hue: 300, saturation: 100 });
        expect(e.commands.colorControl.moveToHueAndSaturation).toHaveBeenCalledWith({
          hue: 212,
          saturation: 254,
          transitionTime: 10,
          optionsMask: 0,
          optionsOverride: 0,
        });
      });

      it("set_color_temperature converts kelvin to clamped mireds", async () => {
        const e = await ep("set_color_temperature", { kelvin: 2700 });
        expect(e.commands.colorControl.moveToColorTemperature).toHaveBeenCalledWith(
          expect.objectContaining({ colorTemperatureMireds: 370 }),
        );
      });

      it("set_color_temperature clamps out-of-band mireds", async () => {
        const e = await ep("set_color_temperature", { mireds: 9000 });
        expect(e.commands.colorControl.moveToColorTemperature).toHaveBeenCalledWith(
          expect.objectContaining({ colorTemperatureMireds: 500 }),
        );
      });

      it("cover motion commands invoke the WindowCovering cluster as void", async () => {
        const e1 = await ep("open_cover");
        expect(e1.commands.windowCovering.upOrOpen).toHaveBeenCalledWith(undefined);
        const e2 = await ep("close_cover");
        expect(e2.commands.windowCovering.downOrClose).toHaveBeenCalledWith(undefined);
        const e3 = await ep("stop_cover");
        expect(e3.commands.windowCovering.stopMotion).toHaveBeenCalledWith(undefined);
      });

      it("set_cover_position inverts percent-open into lift hundredths-closed", async () => {
        const e = await ep("set_cover_position", { position: 25 });
        expect(e.commands.windowCovering.goToLiftPercentage).toHaveBeenCalledWith({
          liftPercent100thsValue: 7500,
        });
      });

      it("set_fan_speed writes percentSetting; set_fan_mode maps the enum", async () => {
        // Fan speed/mode are attribute WRITES — mock the cluster client the
        // same way the set_hvac_mode tests do.
        const setAttribute = vi.fn().mockResolvedValue(undefined);
        const fanEndpoint = fakeEndpoint({
          getClusterClient: () => ({ setAttribute }),
        });
        const node = fakeNode({ parts: new Map([[1, fanEndpoint]]) });
        (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);

        await core.sendCommand("1", "set_fan_speed", { percent: 60 });
        expect(setAttribute).toHaveBeenCalledWith("percentSetting", 60);
        await core.sendCommand("1", "set_fan_mode", { mode: "auto" });
        expect(setAttribute).toHaveBeenCalledWith("fanMode", 5);
        await expect(
          core.sendCommand("1", "set_fan_mode", { mode: "turbo" }),
        ).rejects.toThrow(/unsupported fan mode/i);
      });

      // WARP-897: state derivation for the categories the widgets render.
      it("derives lock state from DoorLock lockState, never onOff", async () => {
        const lockEndpoint = fakeEndpoint({
          state: {
            descriptor: { deviceTypeList: [{ deviceType: 0x000a, revision: 1 }], serverList: [0x0101] },
            doorLock: { lockState: 1 },
          },
        });
        const node = fakeNode({ parts: new Map([[1, lockEndpoint]]) });
        (controller.getCommissionedNodes as ReturnType<typeof vi.fn>).mockReturnValue([1n]);
        (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
        const device = await core.getDevice("1");
        expect(device?.category).toBe("lock");
        expect(device?.state).toBe("locked");
        expect(device?.attributes.lockState).toBe(1);
      });

      it("derives cover open/closed from lift hundredths and exposes the position", async () => {
        const coverEndpoint = fakeEndpoint({
          state: {
            descriptor: { deviceTypeList: [{ deviceType: 0x0202, revision: 1 }], serverList: [0x0102] },
            windowCovering: { currentPositionLiftPercent100ths: 10000 },
          },
        });
        const node = fakeNode({ parts: new Map([[1, coverEndpoint]]) });
        (controller.getCommissionedNodes as ReturnType<typeof vi.fn>).mockReturnValue([1n]);
        (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
        const device = await core.getDevice("1");
        expect(device?.category).toBe("cover");
        expect(device?.state).toBe("closed");
        expect(device?.attributes.liftPercent100ths).toBe(10000);
      });

      it("classifies the 0x002b device type as fan and derives speed state", async () => {
        const fanEndpoint = fakeEndpoint({
          state: {
            descriptor: { deviceTypeList: [{ deviceType: 0x002b, revision: 1 }], serverList: [0x0202] },
            fanControl: { percentCurrent: 40, fanMode: 2 },
          },
          commands: {},
        });
        const node = fakeNode({ parts: new Map([[1, fanEndpoint]]) });
        (controller.getCommissionedNodes as ReturnType<typeof vi.fn>).mockReturnValue([1n]);
        (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
        const device = await core.getDevice("1");
        expect(device?.category).toBe("fan");
        expect(device?.state).toBe("on");
        expect(device?.attributes.fanPercent).toBe(40);
        expect(device?.attributes.fanMode).toBe(2);
      });

      it("exposes color attributes for color-capable lights", async () => {
        const colorEndpoint = fakeEndpoint({
          state: {
            descriptor: { deviceTypeList: [{ deviceType: 0x010d, revision: 1 }], serverList: [0x0006, 0x0300] },
            onOff: { onOff: true },
            colorControl: { currentHue: 212, currentSaturation: 254, colorTemperatureMireds: 370 },
          },
        });
        const node = fakeNode({ parts: new Map([[1, colorEndpoint]]) });
        (controller.getCommissionedNodes as ReturnType<typeof vi.fn>).mockReturnValue([1n]);
        (controller.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(node);
        const device = await core.getDevice("1");
        expect(device?.attributes.currentHue).toBe(212);
        expect(device?.attributes.currentSaturation).toBe(254);
        expect(device?.attributes.colorTemperatureMireds).toBe(370);
      });

      it("media verbs invoke MediaPlayback as void", async () => {
        const e1 = await ep("play_media");
        expect(e1.commands.mediaPlayback.play).toHaveBeenCalledWith(undefined);
        const e2 = await ep("pause_media");
        expect(e2.commands.mediaPlayback.pause).toHaveBeenCalledWith(undefined);
        const e3 = await ep("stop_media");
        expect(e3.commands.mediaPlayback.stop).toHaveBeenCalledWith(undefined);
      });
    });
  });

  describe("device listing", () => {
    it("groups a 0x0100 On/Off Light under lights", async () => {
      (controller.getCommissionedNodes as ReturnType<typeof vi.fn>).mockReturnValue([1n]);
      const grouped = await core.listDevices();
      expect(grouped.lights).toHaveLength(1);
      expect(grouped.lights[0]).toMatchObject({
        nodeId: "1",
        name: "Test Lamp",
        category: "light",
        state: "on",
        connectionState: "connected",
        vendorName: "Acme",
      });
      expect(grouped.switches).toHaveLength(0);
    });

    it("getDevice returns null for an uncommissioned node", async () => {
      (controller.isNodeCommissioned as ReturnType<typeof vi.fn>).mockReturnValue(false);
      expect(await core.getDevice("42")).toBeNull();
    });
  });

  describe("discover", () => {
    it("maps matter.js CommissionableDevice records to the wire shape", async () => {
      (
        controller.discoverCommissionableDevices as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          deviceIdentifier: "ABCD",
          D: 3840,
          VP: "65521+32768",
          DN: "Test Lamp",
          DT: 0x0100,
          CM: 1,
          addresses: [{ ip: "192.168.20.50", port: 5540, type: "udp" }],
        },
      ]);
      const devices = await core.discover(5000);
      expect(devices).toEqual([
        {
          deviceIdentifier: "ABCD",
          discriminator: 3840,
          vendorId: 65521,
          productId: 32768,
          deviceName: "Test Lamp",
          deviceType: 0x0100,
          commissioningMode: 1,
          addresses: [{ ip: "192.168.20.50", port: 5540, type: "udp" }],
        },
      ]);
    });

    // --- matter.js 0.17 ServerAddress migration (WARP-850 failure class) ---
    //
    // 0.17 dropped the literal `type` discriminant from the IP variant:
    // `ServerAddress` gained a BARE `ServerAddressIp` member carrying only
    // `{ ip, port }`. Reading `a.type` off it yields `undefined`, which would
    // have silently blanked the BLE-vs-IP transport signal on the wire — the
    // exact class of regression WARP-850 shipped to a box. The replacement is
    // `ServerAddress.protocolOf()`, which is total: "udp" | "tcp" | "ble" |
    // "ip". These cases pin each arm of that union.
    const discoverOne = async (addresses: unknown[]) => {
      (
        controller.discoverCommissionableDevices as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { deviceIdentifier: "ABCD", D: 3840, CM: 1, addresses },
      ]);
      const [device] = await core.discover(5000);
      return device.addresses;
    };

    it("maps a bare 0.17 ServerAddressIp (no `type` field) to type 'ip', never undefined", async () => {
      // The new 0.17 variant. Pre-migration this produced `type: undefined`.
      expect(await discoverOne([{ ip: "192.168.20.51", port: 5540 }])).toEqual([
        { ip: "192.168.20.51", port: 5540, type: "ip" },
      ]);
    });

    it("preserves the explicit udp/tcp transport labels", async () => {
      expect(
        await discoverOne([
          { ip: "192.168.20.52", port: 5540, type: "udp" },
          { ip: "192.168.20.53", port: 5541, type: "tcp" },
        ]),
      ).toEqual([
        { ip: "192.168.20.52", port: 5540, type: "udp" },
        { ip: "192.168.20.53", port: 5541, type: "tcp" },
      ]);
    });

    it("keeps a BLE address distinguishable and surfaces its peripheralAddress", async () => {
      // A BLE address has NO ip/port — it carries `peripheralAddress`. The
      // ip/port stay at their empty sentinels so the wire shape is stable for
      // the orchestrator, but the peripheral identity is no longer dropped on
      // the floor: BLE-first commissioning is the one path WARP-850 broke.
      expect(
        await discoverOne([
          { type: "ble", peripheralAddress: "AA:BB:CC:DD:EE:FF" },
        ]),
      ).toEqual([
        {
          ip: "",
          port: 0,
          type: "ble",
          peripheralAddress: "AA:BB:CC:DD:EE:FF",
        },
      ]);
    });

    it("keeps ip/port at their sentinels for an address matter.js may add later", async () => {
      // Neither isIp() nor isBle() — a shape the 0.17 union does not have.
      // The wire contract (`ip: string`, `port: number`) must still hold
      // rather than leaking undefined into the orchestrator.
      expect(await discoverOne([{ type: "future-transport" }])).toEqual([
        { ip: "", port: 0, type: "future-transport" },
      ]);
    });

    it("never emits an address whose transport label is empty or undefined", async () => {
      // Guards the whole union at once: whatever matter.js hands us, the
      // orchestrator-facing `type` is always a non-empty string.
      const addresses = await discoverOne([
        { ip: "192.168.20.54", port: 5540 },
        { ip: "192.168.20.55", port: 5540, type: "udp" },
        { type: "ble", peripheralAddress: "11:22:33:44:55:66" },
      ]);
      for (const a of addresses) {
        expect(typeof a.type).toBe("string");
        expect(a.type.length).toBeGreaterThan(0);
      }
    });

    it("passes the timeout to matter.js as milliseconds, not seconds", async () => {
      const discover = controller.discoverCommissionableDevices as ReturnType<
        typeof vi.fn
      >;
      await core.discover(5000);
      // matter.js Duration is millisecond-valued; the timeout must be the
      // raw 5000, not 5 (which would expire the scan in ~5ms).
      expect(discover).toHaveBeenCalledWith(
        expect.anything(),
        { onIpNetwork: true },
        undefined,
        5000,
      );
    });
  });

  describe("shutdown", () => {
    it("closes the controller and flips initialized off", async () => {
      await core.shutdown();
      expect(controller.close).toHaveBeenCalledOnce();
      expect(core.isInitialized()).toBe(false);
    });
  });
});

describe("fabric-continuity invariant (WARP-850 requirement #2)", () => {
  it("pins the matter.js environment id to the pre-extraction value", () => {
    // The id keys the on-disk storage layout under MATTER_STORAGE_PATH.
    // The orchestrator created its CommissioningController with
    // `id: "droplet-controller"` before WARP-850; the sidecar must
    // present the identical environment or every commissioned device
    // orphans on upgrade. If this assertion ever needs to change, a
    // storage migration must ship with it.
    expect(MATTER_ENV_ID).toBe("droplet-controller");
  });
});
