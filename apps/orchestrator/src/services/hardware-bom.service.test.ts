/**
 * WARP-263 — hardware BOM tracking.
 *
 * Covers the required scenarios: first-boot capture (signed, no audit
 * row), unchanged re-check (no-op), changed re-check (signed baseline
 * overwrite + one `hardware_changed` ActivityRow via the injected
 * `recordActivity`), and that the signer receives the exact canonical
 * bytes the hash/diff logic operates on.
 */
import { describe, it, expect } from "vitest";
import type { RecordParams } from "./activity.service.js";
import {
  canonicalizeComponents,
  hashComponents,
  diffComponents,
  checkHardwareInventory,
  HARDWARE_BASELINE_ID,
  type HardwareBomDeps,
  type RecordActivityFn,
} from "./hardware-bom.service.js";
import { createFixtureHardwareInventoryCollector } from "./hardware-inventory.collector.js";
import type {
  HardwareComponent,
  HardwareComponentCategory,
} from "./hardware-inventory.collector.js";

function makeFakePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    hardwareBaseline: {
      async findUnique(args: { where: { id: string } }) {
        return rows.get(args.where.id) ?? null;
      },
      async create(args: { data: Record<string, unknown> }) {
        const row = { ...args.data };
        rows.set(row.id as string, row);
        return row;
      },
      async update(args: { where: { id: string }; data: Record<string, unknown> }) {
        const existing = rows.get(args.where.id);
        const row = { ...existing, ...args.data };
        rows.set(args.where.id, row);
        return row;
      },
    },
    _rows: rows,
  };
}

function makeFakeIdentity() {
  const signCalls: Uint8Array[] = [];
  return {
    signCalls,
    async signWithDeviceKey(payload: Uint8Array) {
      signCalls.push(payload);
      return { signature: new Uint8Array([9, 9, 9]), algorithm: "ECDSA-P256-SHA256" };
    },
  };
}

const BASELINE_COMPONENTS: HardwareComponent[] = [
  { category: "som", id: "sn-board-1", model: "ASRockRack X570D4U-2L2T" },
  { category: "ram", id: "DIMM_A1", model: "32 GB Samsung M393A4K40DB3-CWE" },
  { category: "disk", id: "sn-disk-1", model: "Samsung SSD 980 PRO 2TB" },
  { category: "usb", id: "0bda:8153", model: "Realtek RTL8153" },
  { category: "pci", id: "01:00.0", model: "NVIDIA AD104" },
];

/** Records every call into an array so tests can assert on the emitted
 * ActivityRow params without wrestling vitest's Mock return-type generics. */
function makeRecordActivity() {
  const calls: RecordParams[] = [];
  const fn: RecordActivityFn = async (params) => {
    calls.push(params);
    return null;
  };
  return { fn, calls };
}

function makeDeps(
  overrides: Partial<HardwareBomDeps> & {
    components: HardwareComponent[];
    degradedCategories?: HardwareComponentCategory[];
  },
) {
  const prisma = makeFakePrisma();
  const identity = makeFakeIdentity();
  const recordActivity = makeRecordActivity();
  const collector = createFixtureHardwareInventoryCollector(
    overrides.components,
    undefined,
    overrides.degradedCategories,
  );
  return {
    prisma,
    identity,
    recordActivity,
    deps: {
      prisma: prisma as never,
      identity,
      collector,
      recordActivity: recordActivity.fn,
      now: overrides.now ?? new Date("2026-07-11T03:00:00.000Z"),
    } satisfies HardwareBomDeps,
  };
}

describe("canonicalizeComponents", () => {
  it("is order-independent (sorts by category then id)", () => {
    const a = canonicalizeComponents([
      { category: "ram", id: "DIMM_A1", model: "32GB" },
      { category: "disk", id: "sn1", model: "SSD" },
    ]);
    const b = canonicalizeComponents([
      { category: "disk", id: "sn1", model: "SSD" },
      { category: "ram", id: "DIMM_A1", model: "32GB" },
    ]);
    expect(a).toBe(b);
    expect(hashComponents(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("diffComponents", () => {
  it("classifies added/removed/changed by category:id", () => {
    const baseline: HardwareComponent[] = [
      { category: "usb", id: "aaaa:bbbb", model: "Widget v1" },
      { category: "disk", id: "sn1", model: "SSD 1TB" },
    ];
    const current: HardwareComponent[] = [
      { category: "usb", id: "aaaa:bbbb", model: "Widget v2" }, // changed
      { category: "pci", id: "00:1f.2", model: "SATA controller" }, // added
      // disk sn1 removed
    ];
    const diff = diffComponents(baseline, current);
    expect(diff.added).toEqual([{ category: "pci", id: "00:1f.2", model: "SATA controller" }]);
    expect(diff.removed).toEqual([{ category: "disk", id: "sn1", model: "SSD 1TB" }]);
    expect(diff.changed).toEqual([
      { category: "usb", id: "aaaa:bbbb", from: "Widget v1", to: "Widget v2" },
    ]);
  });
});

describe("checkHardwareInventory", () => {
  it("first boot: signs + persists the baseline, emits no audit row", async () => {
    const { deps, prisma, identity, recordActivity } = makeDeps({
      components: BASELINE_COMPONENTS,
    });

    const result = await checkHardwareInventory(deps);

    expect(result).toEqual({ status: "captured", componentCount: 5 });
    expect(recordActivity.calls).toHaveLength(0);
    expect(identity.signCalls).toHaveLength(1);
    expect(Buffer.from(identity.signCalls[0]!).toString("utf8")).toBe(
      canonicalizeComponents(BASELINE_COMPONENTS),
    );

    const stored = prisma._rows.get(HARDWARE_BASELINE_ID)!;
    expect(stored.componentsHash).toBe(hashComponents(canonicalizeComponents(BASELINE_COMPONENTS)));
    expect(stored.signature).toBe(Buffer.from([9, 9, 9]).toString("base64"));
    expect(stored.algorithm).toBe("ECDSA-P256-SHA256");
  });

  it("unchanged: no-op, no sign call, no audit row", async () => {
    const { deps, identity, recordActivity } = makeDeps({ components: BASELINE_COMPONENTS });
    await checkHardwareInventory(deps); // captures baseline

    identity.signCalls.length = 0;
    const result = await checkHardwareInventory(deps); // same fixture again

    expect(result).toEqual({ status: "unchanged" });
    expect(recordActivity.calls).toHaveLength(0);
    expect(identity.signCalls).toHaveLength(0);
  });

  it("changed: overwrites the signed baseline and emits one hardware_changed audit row", async () => {
    const { deps, prisma, identity, recordActivity } = makeDeps({ components: BASELINE_COMPONENTS });
    await checkHardwareInventory(deps); // captures baseline

    const changedComponents: HardwareComponent[] = [
      ...BASELINE_COMPONENTS.filter((c) => c.id !== "sn-disk-1"), // disk removed
      { category: "usb", id: "046d:c52b", model: "Logitech receiver" }, // usb added
    ];
    const deps2: HardwareBomDeps = {
      ...deps,
      collector: createFixtureHardwareInventoryCollector(changedComponents),
      now: new Date("2026-07-11T04:00:00.000Z"),
    };

    const result = await checkHardwareInventory(deps2);

    expect(result.status).toBe("changed");
    if (result.status !== "changed") throw new Error("unreachable");
    expect(result.diff.removed).toEqual([
      { category: "disk", id: "sn-disk-1", model: "Samsung SSD 980 PRO 2TB" },
    ]);
    expect(result.diff.added).toEqual([
      { category: "usb", id: "046d:c52b", model: "Logitech receiver" },
    ]);
    expect(result.diff.changed).toEqual([]);

    expect(recordActivity.calls).toHaveLength(1);
    const call = recordActivity.calls[0]!;
    expect(call.kind).toBe("system");
    expect(call.severity).toBe("warn");
    expect(call.what).toBe("hardware_changed");
    expect(call.actor).toEqual({ type: "system" });
    expect(call.refs).toEqual({
      added: result.diff.added,
      removed: result.diff.removed,
      changed: result.diff.changed,
    });

    // Baseline is overwritten with the new (signed) snapshot.
    const stored = prisma._rows.get(HARDWARE_BASELINE_ID)!;
    expect(stored.componentsHash).toBe(
      hashComponents(canonicalizeComponents(changedComponents)),
    );
    expect(identity.signCalls).toHaveLength(2); // capture + this reconcile
  });

  it("signs the exact canonical bytes on divergence", async () => {
    const { deps, identity } = makeDeps({ components: BASELINE_COMPONENTS });
    await checkHardwareInventory(deps);

    const changed = BASELINE_COMPONENTS.map((c) =>
      c.id === "DIMM_A1" ? { ...c, model: "32 GB Samsung (RMA replacement)" } : c,
    );
    const deps2: HardwareBomDeps = {
      ...deps,
      collector: createFixtureHardwareInventoryCollector(changed),
    };
    await checkHardwareInventory(deps2);

    expect(Buffer.from(identity.signCalls[1]!).toString("utf8")).toBe(
      canonicalizeComponents(changed),
    );
  });

  it("inconclusive: a degraded probe does NOT overwrite the baseline nor emit hardware_changed", async () => {
    // Capture a clean baseline first.
    const { deps, prisma, identity, recordActivity } = makeDeps({ components: BASELINE_COMPONENTS });
    await checkHardwareInventory(deps);
    const baselineHash = prisma._rows.get(HARDWARE_BASELINE_ID)!.componentsHash;
    identity.signCalls.length = 0;

    // Next boot: the usb probe fails, so its component is missing AND the
    // snapshot is flagged degraded. This looks identical to "the usb device
    // was removed" if degradation is ignored — the exact false-tamper case.
    const degradedComponents = BASELINE_COMPONENTS.filter((c) => c.category !== "usb");
    const deps2: HardwareBomDeps = {
      ...deps,
      collector: createFixtureHardwareInventoryCollector(
        degradedComponents,
        undefined,
        ["usb"],
      ),
      now: new Date("2026-07-11T05:00:00.000Z"),
    };

    const result = await checkHardwareInventory(deps2);

    expect(result.status).toBe("inconclusive");
    if (result.status !== "inconclusive") throw new Error("unreachable");
    expect(result.degradedCategories).toEqual(["usb"]);

    // No hardware_changed tamper signal — only the distinct inconclusive warn.
    const changedCalls = recordActivity.calls.filter((c) => c.what === "hardware_changed");
    expect(changedCalls).toHaveLength(0);
    expect(recordActivity.calls).toHaveLength(1);
    const call = recordActivity.calls[0]!;
    expect(call.what).toBe("hardware_probe_inconclusive");
    expect(call.kind).toBe("system");
    expect(call.severity).toBe("warn");
    expect(call.actor).toEqual({ type: "system" });
    expect(call.refs).toEqual({ degradedCategories: ["usb"] });

    // The trusted signed baseline is untouched — not re-signed, not overwritten.
    expect(identity.signCalls).toHaveLength(0);
    expect(prisma._rows.get(HARDWARE_BASELINE_ID)!.componentsHash).toBe(baselineHash);
  });

  it("inconclusive on first boot: a degraded probe does not capture a partial baseline", async () => {
    const { deps, prisma, identity, recordActivity } = makeDeps({
      components: BASELINE_COMPONENTS.filter((c) => c.category !== "pci"),
      degradedCategories: ["pci"],
    });

    const result = await checkHardwareInventory(deps);

    expect(result.status).toBe("inconclusive");
    // Nothing signed, no baseline row baked from an incomplete read.
    expect(identity.signCalls).toHaveLength(0);
    expect(prisma._rows.get(HARDWARE_BASELINE_ID)).toBeUndefined();
    expect(recordActivity.calls).toHaveLength(1);
    expect(recordActivity.calls[0]!.what).toBe("hardware_probe_inconclusive");
  });
});
