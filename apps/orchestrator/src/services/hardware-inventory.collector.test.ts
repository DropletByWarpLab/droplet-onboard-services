/**
 * WARP-263 — parser unit tests against captured tool-output fixtures.
 *
 * These exercise the pure parsing functions only (no real
 * dmidecode/lsblk/lsusb/lspci execution — see the module doc comment on
 * `hardware-inventory.collector.ts` re: hardware-verify deferral). The
 * fixtures below are trimmed, representative excerpts of real command
 * output shapes.
 */
import { describe, it, expect } from "vitest";
import {
  parseBaseboardComponent,
  parseMemoryComponents,
  parseDiskComponents,
  parseUsbComponents,
  parsePciComponents,
  createFixtureHardwareInventoryCollector,
  createLinuxHardwareInventoryCollector,
} from "./hardware-inventory.collector.js";

const DMIDECODE_BASEBOARD = `# dmidecode 3.3
Getting SMBIOS data from sysfs.
SMBIOS 3.2.0 present.

Handle 0x0002, DMI type 2, 15 bytes
Base Board Information
\tManufacturer: ASRockRack
\tProduct Name: X570D4U-2L2T
\tVersion: 1.00
\tSerial Number: DR9K2200112233
\tAsset Tag: Default string
\tFeatures:
\t\tBoard is a hosting board
\tLocation In Chassis: Default string
\tType: Motherboard
`;

const DMIDECODE_MEMORY = `# dmidecode 3.3
Getting SMBIOS data from sysfs.
SMBIOS 3.2.0 present.
8 structures occupying 968 bytes.

Handle 0x0010, DMI type 17, 92 bytes
Memory Device
\tArray Handle: 0x000F
\tError Information Handle: Not Provided
\tTotal Width: 72 bits
\tData Width: 64 bits
\tSize: 32 GB
\tForm Factor: DIMM
\tSet: None
\tLocator: DIMM_A1
\tBank Locator: NODE 0
\tType: DDR4
\tType Detail: Synchronous Registered (Buffered)
\tSpeed: 3200 MT/s
\tManufacturer: Samsung
\tSerial Number: 12AB34CD
\tAsset Tag: Not Specified
\tPart Number: M393A4K40DB3-CWE
\tRank: 2
\tConfigured Memory Speed: 3200 MT/s
\tMinimum Voltage: 1.2 V
\tMaximum Voltage: 1.2 V
\tConfigured Voltage: 1.2 V

Handle 0x0011, DMI type 17, 92 bytes
Memory Device
\tArray Handle: 0x000F
\tError Information Handle: Not Provided
\tTotal Width: Unknown
\tData Width: Unknown
\tSize: No Module Installed
\tForm Factor: DIMM
\tSet: None
\tLocator: DIMM_A2
\tBank Locator: NODE 0
\tType: DDR4
\tType Detail: Synchronous
\tSpeed: Unknown
\tManufacturer: Not Specified
\tSerial Number: Not Specified
\tAsset Tag: Not Specified
\tPart Number: Not Specified
\tRank: Unknown
\tConfigured Memory Speed: Unknown
`;

const LSBLK_JSON = JSON.stringify({
  blockdevices: [
    { name: "sda", model: "Samsung SSD 980 PRO 2TB", serial: "S6B2NJ0R123456", type: "disk" },
    { name: "sda1", model: null, serial: null, type: "part" },
    { name: "sr0", model: "DVD-ROM", serial: null, type: "rom" },
    { name: "nvme0n1", model: "WD_BLACK SN850X 1000GB", serial: "22A1B2C3D4E5", type: "disk" },
  ],
});

const LSUSB_OUTPUT = `Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub
Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub
Bus 001 Device 004: ID 0bda:8153 Realtek Semiconductor Corp. RTL8153 Gigabit Ethernet Adapter
Bus 001 Device 005: ID 046d:c52b Logitech, Inc. Unifying Receiver
`;

const LSPCI_OUTPUT = `00:00.0 Host bridge: Intel Corporation Device 4660
00:01.0 PCI bridge: Intel Corporation Device 4601
01:00.0 VGA compatible controller: NVIDIA Corporation AD104 [GeForce RTX 4070]
02:00.0 Non-Volatile memory controller: Sandisk Corp WD Black SN850X NVMe SSD
`;

describe("parseBaseboardComponent", () => {
  it("extracts manufacturer + product as model and serial as id", () => {
    const c = parseBaseboardComponent(DMIDECODE_BASEBOARD);
    expect(c).toEqual({
      category: "som",
      id: "DR9K2200112233",
      model: "ASRockRack X570D4U-2L2T",
    });
  });

  it("returns null when the product field is unusable", () => {
    const c = parseBaseboardComponent("Base Board Information\n\tProduct Name: Not Specified\n");
    expect(c).toBeNull();
  });
});

describe("parseMemoryComponents", () => {
  it("returns one component per populated DIMM slot, skipping empty slots", () => {
    const components = parseMemoryComponents(DMIDECODE_MEMORY);
    expect(components).toHaveLength(1);
    expect(components[0]).toEqual({
      category: "ram",
      id: "DIMM_A1",
      model: "32 GB Samsung M393A4K40DB3-CWE (sn:12AB34CD)",
    });
  });
});

describe("parseDiskComponents", () => {
  it("returns one component per TYPE=disk device, using serial as id when present", () => {
    const components = parseDiskComponents(LSBLK_JSON);
    expect(components).toEqual([
      {
        category: "disk",
        id: "S6B2NJ0R123456",
        model: "Samsung SSD 980 PRO 2TB (sn:S6B2NJ0R123456)",
      },
      {
        category: "disk",
        id: "22A1B2C3D4E5",
        model: "WD_BLACK SN850X 1000GB (sn:22A1B2C3D4E5)",
      },
    ]);
  });

  it("degrades to an empty list on unparseable JSON", () => {
    expect(parseDiskComponents("not json")).toEqual([]);
  });
});

describe("parseUsbComponents", () => {
  it("skips root-hub entries and keeps real peripherals keyed by vendor:product", () => {
    const components = parseUsbComponents(LSUSB_OUTPUT);
    expect(components).toEqual([
      {
        category: "usb",
        id: "0bda:8153",
        model: "Realtek Semiconductor Corp. RTL8153 Gigabit Ethernet Adapter",
      },
      {
        category: "usb",
        id: "046d:c52b",
        model: "Logitech, Inc. Unifying Receiver",
      },
    ]);
  });
});

describe("parsePciComponents", () => {
  it("returns one component per PCI slot keyed by slot address", () => {
    const components = parsePciComponents(LSPCI_OUTPUT);
    expect(components).toHaveLength(4);
    expect(components[2]).toEqual({
      category: "pci",
      id: "01:00.0",
      model: "VGA compatible controller: NVIDIA Corporation AD104 [GeForce RTX 4070]",
    });
  });
});

describe("createFixtureHardwareInventoryCollector", () => {
  it("returns exactly the components it was given, undegraded by default", async () => {
    const fixture = [{ category: "som" as const, id: "x", model: "y" }];
    const collector = createFixtureHardwareInventoryCollector(fixture, "2026-07-11T00:00:00.000Z");
    const snapshot = await collector.collect();
    expect(snapshot).toEqual({
      collectedAt: "2026-07-11T00:00:00.000Z",
      components: fixture,
      degradedCategories: [],
    });
  });
});

describe("createLinuxHardwareInventoryCollector degradation", () => {
  it("marks a category degraded (not silently empty) when its probe throws", async () => {
    // Inject a runner that fails only for `lsusb` (usb category) — timeout /
    // missing tool / permission. The other categories collect normally.
    const collector = createLinuxHardwareInventoryCollector({
      runCommand: async (bin) => {
        if (bin === "lsusb") {
          throw Object.assign(new Error("spawn lsusb ETIMEDOUT"), { code: "ETIMEDOUT" });
        }
        if (bin === "lspci") return LSPCI_OUTPUT;
        if (bin === "lsblk") return LSBLK_JSON;
        if (bin === "dmidecode") return DMIDECODE_BASEBOARD;
        return "";
      },
    });

    const snapshot = await collector.collect();

    // The failed usb probe is reported as degraded, NOT as an empty/authoritative
    // reading — this is the signal the reconciler needs to avoid a false tamper.
    expect(snapshot.degradedCategories).toEqual(["usb"]);
    expect(snapshot.components.some((c) => c.category === "usb")).toBe(false);
    // Healthy categories still collected.
    expect(snapshot.components.some((c) => c.category === "pci")).toBe(true);
    expect(snapshot.components.some((c) => c.category === "disk")).toBe(true);
  });

  it("reports no degraded categories when every probe succeeds", async () => {
    const collector = createLinuxHardwareInventoryCollector({
      runCommand: async (bin, args) => {
        if (bin === "lsusb") return LSUSB_OUTPUT;
        if (bin === "lspci") return LSPCI_OUTPUT;
        if (bin === "lsblk") return LSBLK_JSON;
        // dmidecode is called for both baseboard and memory.
        if (bin === "dmidecode") {
          return args.includes("memory") ? DMIDECODE_MEMORY : DMIDECODE_BASEBOARD;
        }
        return "";
      },
    });

    const snapshot = await collector.collect();
    expect(snapshot.degradedCategories).toEqual([]);
  });
});
