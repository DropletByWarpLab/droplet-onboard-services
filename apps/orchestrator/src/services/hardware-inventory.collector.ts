/**
 * WARP-263 — hardware inventory collection, abstracted behind
 * `HardwareInventoryCollector` so `hardware-bom.service.ts` never cares
 * whether the components came from real Linux hardware-introspection
 * tools or a test fixture.
 *
 * `createLinuxHardwareInventoryCollector()` is the production backend: it
 * shells out to `dmidecode`/`lsblk`/`lsusb`/`lspci` (all read-only,
 * already-present on the appliance image) and parses their output into
 * the canonical `HardwareComponent` shape. Each category is collected
 * independently and best-effort — a missing/failing tool (not installed,
 * no `/dev/mem` permission, container without the device passthrough)
 * degrades that ONE category to an empty list with a logged warning
 * rather than failing the whole collection, mirroring the "appliance
 * keeps running" posture used elsewhere (e.g. `activity.service.ts`'s
 * `recordSafely`).
 *
 * ⚠ HARDWARE-VERIFY DEFERRED: this module was written and unit-tested
 * (see `hardware-inventory.collector.test.ts`) against captured
 * `dmidecode`/`lsblk`/`lsusb`/`lspci` output fixtures on a non-Linux dev
 * box — it has NOT been exercised against a real appliance's hardware
 * yet. Verify the parsers against real command output on-box before
 * relying on this for a compliance audit trail. Track under the
 * `hardware-verify` label.
 */
import { execFile } from "node:child_process";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("hardware-inventory");

export type HardwareComponentCategory = "som" | "ram" | "disk" | "usb" | "pci";

export interface HardwareComponent {
  category: HardwareComponentCategory;
  /** Stable identifier within its category (serial, DIMM locator, PCI slot
   * address, or USB vendor:product id — see per-parser docs for caveats). */
  id: string;
  /** Human-readable model/SKU string. */
  model: string;
}

export interface HardwareInventorySnapshot {
  collectedAt: string;
  components: HardwareComponent[];
}

export interface HardwareInventoryCollector {
  collect(): Promise<HardwareInventorySnapshot>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Parse `dmidecode -t baseboard` output into a single "som" component
 * (the appliance's carrier board — see docs/FOUNDATION.md; "SoM" per the
 * WARP-263 ticket wording covers this same role). Returns `null` when the
 * expected fields aren't present (unexpected dmidecode version/output).
 */
export function parseBaseboardComponent(
  dmidecodeOutput: string,
): HardwareComponent | null {
  const productMatch = dmidecodeOutput.match(/^\s*Product Name:\s*(.+)$/m);
  const serialMatch = dmidecodeOutput.match(/^\s*Serial Number:\s*(.+)$/m);
  const manufacturerMatch = dmidecodeOutput.match(/^\s*Manufacturer:\s*(.+)$/m);
  const product = productMatch?.[1]?.trim();
  if (!product || product === "Not Specified" || product === "To Be Filled By O.E.M.") {
    return null;
  }
  const serial = serialMatch?.[1]?.trim();
  const manufacturer = manufacturerMatch?.[1]?.trim();
  return {
    category: "som",
    id: serial && serial !== "Not Specified" ? serial : product,
    model: manufacturer ? `${manufacturer} ${product}` : product,
  };
}

/**
 * Parse `dmidecode -t memory` output (type 17, "Memory Device" records)
 * into one "ram" component per populated slot. Empty slots ("Size: No
 * Module Installed") are skipped. `id` is the DIMM locator (e.g.
 * "DIMM_A1") — stable across boots for the same physical slot; `model`
 * is "<manufacturer> <part number>" (the SKU).
 */
export function parseMemoryComponents(
  dmidecodeOutput: string,
): HardwareComponent[] {
  const blocks = dmidecodeOutput.split(/\n(?=Handle )/);
  const components: HardwareComponent[] = [];
  for (const block of blocks) {
    if (!/DMI type 17/.test(block)) continue;
    const sizeMatch = block.match(/^\s*Size:\s*(.+)$/m);
    const size = sizeMatch?.[1]?.trim();
    if (!size || /No Module Installed/i.test(size)) continue;
    const locatorMatch = block.match(/^\s*Locator:\s*(?!Bank)(.+)$/m);
    const partMatch = block.match(/^\s*Part Number:\s*(.+)$/m);
    const manufacturerMatch = block.match(/^\s*Manufacturer:\s*(.+)$/m);
    const serialMatch = block.match(/^\s*Serial Number:\s*(.+)$/m);
    const locator = locatorMatch?.[1]?.trim();
    const partNumber = partMatch?.[1]?.trim();
    if (!locator) continue;
    const manufacturer = manufacturerMatch?.[1]?.trim();
    const serial = serialMatch?.[1]?.trim();
    const modelParts = [manufacturer, partNumber].filter(
      (v) => v && v !== "Not Specified" && v !== "Unknown",
    );
    components.push({
      category: "ram",
      id: locator,
      model: `${size}${modelParts.length ? ` ${modelParts.join(" ")}` : ""}${
        serial && serial !== "Not Specified" ? ` (sn:${serial})` : ""
      }`,
    });
  }
  return components;
}

interface LsblkDevice {
  name?: string;
  model?: string | null;
  serial?: string | null;
  type?: string;
}

/**
 * Parse `lsblk -J -d -o NAME,MODEL,SERIAL,TYPE` JSON output into one
 * "disk" component per block device of type "disk" (partitions/loop
 * devices excluded by `-d` + the type filter). `id` is the drive serial
 * when reported, else the kernel device name (`sda`, `nvme0n1`, ...) —
 * disks without a serial can't be told apart across a physical swap, a
 * known limitation documented for `hardware-verify`.
 */
export function parseDiskComponents(lsblkJson: string): HardwareComponent[] {
  let parsed: { blockdevices?: LsblkDevice[] };
  try {
    parsed = JSON.parse(lsblkJson);
  } catch {
    return [];
  }
  const devices = parsed.blockdevices ?? [];
  const components: HardwareComponent[] = [];
  for (const dev of devices) {
    if (dev.type !== "disk") continue;
    const name = dev.name;
    if (!name) continue;
    const serial = dev.serial?.trim();
    const model = dev.model?.trim();
    components.push({
      category: "disk",
      id: serial && serial.length > 0 ? serial : name,
      model: `${model && model.length > 0 ? model : "unknown model"}${
        serial && serial.length > 0 ? ` (sn:${serial})` : ""
      }`,
    });
  }
  return components;
}

/**
 * Parse `lsusb` line-oriented output
 * (`Bus 001 Device 002: ID 1d6b:0002 Linux Foundation 2.0 root hub`) into
 * one "usb" component per line. `id` is the `vendor:product` hex pair —
 * STABLE for a given peripheral model but NOT unique if two identical
 * peripherals are plugged in simultaneously (bus/device numbers churn
 * across replugs so aren't usable as the stable id either); acceptable
 * for a BOM-drift signal, documented limitation for `hardware-verify`.
 */
export function parseUsbComponents(lsusbOutput: string): HardwareComponent[] {
  const components: HardwareComponent[] = [];
  const lineRe = /^Bus\s+\d+\s+Device\s+\d+:\s+ID\s+([0-9a-fA-F]{4}:[0-9a-fA-F]{4})\s*(.*)$/;
  for (const line of lsusbOutput.split("\n")) {
    const m = line.trim().match(lineRe);
    if (!m) continue;
    const [, vendorProduct, description] = m;
    // Linux's root-hub entries are virtual, not physical peripherals.
    if (/root hub/i.test(description ?? "")) continue;
    components.push({
      category: "usb",
      id: vendorProduct!,
      model: description && description.length > 0 ? description : vendorProduct!,
    });
  }
  return components;
}

/**
 * Parse `lspci` line-oriented output
 * (`00:1f.2 SATA controller: Intel Corporation ...`) into one "pci"
 * component per line. `id` is the PCI slot/bus address (e.g. "00:1f.2")
 * — stable across boots for the same physical slot on the same board.
 */
export function parsePciComponents(lspciOutput: string): HardwareComponent[] {
  const components: HardwareComponent[] = [];
  const lineRe = /^(\S+)\s+(.+)$/;
  for (const line of lspciOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(lineRe);
    if (!m) continue;
    const [, slot, description] = m;
    components.push({
      category: "pci",
      id: slot!,
      model: description!.trim(),
    });
  }
  return components;
}

export interface LinuxCollectorOptions {
  /** Per-command exec timeout. Defaults to 10s. */
  commandTimeoutMs?: number;
}

/**
 * Production collector. Every category degrades independently — see the
 * module doc comment for the "appliance keeps running" rationale.
 */
export function createLinuxHardwareInventoryCollector(
  opts: LinuxCollectorOptions = {},
): HardwareInventoryCollector {
  const timeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  async function collectCategory(
    label: string,
    run: () => Promise<HardwareComponent[]>,
  ): Promise<HardwareComponent[]> {
    try {
      return await run();
    } catch (err) {
      logger.warn(
        { err, category: label },
        "hardware inventory: category unavailable, skipping (best-effort)",
      );
      return [];
    }
  }

  return {
    async collect() {
      const [som, ram, disk, usb, pci] = await Promise.all([
        collectCategory("som", async () => {
          const out = await runCommand("dmidecode", ["-t", "baseboard"], timeoutMs);
          const component = parseBaseboardComponent(out);
          return component ? [component] : [];
        }),
        collectCategory("ram", async () => {
          const out = await runCommand("dmidecode", ["-t", "memory"], timeoutMs);
          return parseMemoryComponents(out);
        }),
        collectCategory("disk", async () => {
          const out = await runCommand(
            "lsblk",
            ["-J", "-d", "-o", "NAME,MODEL,SERIAL,TYPE"],
            timeoutMs,
          );
          return parseDiskComponents(out);
        }),
        collectCategory("usb", async () => {
          const out = await runCommand("lsusb", [], timeoutMs);
          return parseUsbComponents(out);
        }),
        collectCategory("pci", async () => {
          const out = await runCommand("lspci", [], timeoutMs);
          return parsePciComponents(out);
        }),
      ]);

      return {
        collectedAt: new Date().toISOString(),
        components: [...som, ...ram, ...disk, ...usb, ...pci],
      };
    },
  };
}

/**
 * Test/dev helper — returns a fixed snapshot. Production wiring never
 * uses this; it exists so callers outside this module's own test file
 * (e.g. a future route handler test) don't have to hand-roll the trivial
 * `{ collect: async () => ... }` object.
 */
export function createFixtureHardwareInventoryCollector(
  components: HardwareComponent[],
  collectedAt: string = new Date().toISOString(),
): HardwareInventoryCollector {
  return {
    async collect() {
      return { collectedAt, components };
    },
  };
}
