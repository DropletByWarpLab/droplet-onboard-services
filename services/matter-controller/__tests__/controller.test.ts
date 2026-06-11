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
import { NodeStates } from "@project-chip/matter.js/device";
import {
  createMatterControllerCore,
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
