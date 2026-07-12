/**
 * WARP-263 — hardware bill-of-materials (BOM) tracking.
 *
 * NIST SSDF supply-chain transparency: capture a per-device hardware
 * inventory (SoM/baseboard, RAM SKU, disk model+serial, USB/PCI
 * peripherals — see `hardware-inventory.collector.ts`) at first boot,
 * sign it with the existing WARP-230 device-identity key
 * (`signWithDeviceKey`), and persist it as the recorded baseline. Every
 * later check re-collects, re-signs, and compares against that baseline;
 * a divergence overwrites the baseline AND emits a `hardware_changed`
 * row through the existing WARP-456 activity/audit emitter
 * (`recordActivity` / `ActivityRowRecorder.record`) — no new signing or
 * audit primitive, both are reused as-is.
 *
 * Single-appliance assumption: `HardwareBaseline` is a singleton row
 * (`id = "singleton"`), same pattern as `ApplianceSetup`.
 *
 * Mirrors `audit-daily-root.service.ts`'s shape: a structural
 * `HardwareSigner` interface (not the full `DeviceIdentityClient`) keeps
 * unit tests stub-friendly, and canonicalization + hashing are pure
 * functions exported for direct testing.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import type {
  HardwareComponent,
  HardwareInventoryCollector,
} from "./hardware-inventory.collector.js";
import type { RecordedActivityRow, RecordParams } from "./activity.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("hardware-bom");

/** Fixed singleton primary key — mirrors `ApplianceSetup.id`. */
export const HARDWARE_BASELINE_ID = "singleton";

/** Structural subset of `DeviceIdentityClient` — keeps tests stub-friendly
 * without pulling in the gRPC client (mirrors `DailyRootSigner` in
 * `audit-daily-root.service.ts`). */
export interface HardwareSigner {
  signWithDeviceKey(
    payload: Uint8Array,
  ): Promise<{ signature: Uint8Array; algorithm: string }>;
}

/** Structural subset of `recordActivity` — the existing WARP-456 audit
 * emitter singleton (`activity.singleton.ts`). Injected so tests don't
 * need a real Prisma-backed recorder. */
export type RecordActivityFn = (
  params: RecordParams,
) => Promise<RecordedActivityRow | null>;

export interface HardwareBomDeps {
  prisma: PrismaClient;
  identity: HardwareSigner;
  collector: HardwareInventoryCollector;
  recordActivity: RecordActivityFn;
  /** Injection seam for deterministic tests; defaults to `new Date()`. */
  now?: Date;
}

export interface HardwareComponentChange {
  category: string;
  id: string;
  from: string;
  to: string;
}

export interface HardwareComponentDiff {
  added: HardwareComponent[];
  removed: HardwareComponent[];
  changed: HardwareComponentChange[];
}

export type HardwareBomCheckResult =
  | { status: "captured"; componentCount: number }
  | { status: "unchanged" }
  | { status: "changed"; diff: HardwareComponentDiff };

/**
 * Canonical form: components sorted by (category, id) then JSON-stringified
 * with a fixed key order. Stable regardless of the collector's OS-dependent
 * enumeration order — the same physical hardware always canonicalizes to the
 * same bytes, which is what both the signature and the cheap hash-compare
 * depend on.
 */
export function canonicalizeComponents(
  components: readonly HardwareComponent[],
): string {
  const sorted = [...components].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
  return JSON.stringify(
    sorted.map((c) => ({ category: c.category, id: c.id, model: c.model })),
  );
}

/** Base64-url SHA-256 of the canonical component bytes — used for the
 * cheap "did anything change" compare against the stored baseline. */
export function hashComponents(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/**
 * Diff two component lists keyed on `category:id`. A component present in
 * both but with a different `model` string is reported as `changed`
 * (covers SKU/serial swaps without a slot/category move).
 */
export function diffComponents(
  baseline: readonly HardwareComponent[],
  current: readonly HardwareComponent[],
): HardwareComponentDiff {
  const key = (c: HardwareComponent) => `${c.category}:${c.id}`;
  const baselineMap = new Map(baseline.map((c) => [key(c), c]));
  const currentMap = new Map(current.map((c) => [key(c), c]));

  const added: HardwareComponent[] = [];
  const changed: HardwareComponentChange[] = [];
  for (const [k, c] of currentMap) {
    const prev = baselineMap.get(k);
    if (!prev) {
      added.push(c);
      continue;
    }
    if (prev.model !== c.model) {
      changed.push({ category: c.category, id: c.id, from: prev.model, to: c.model });
    }
  }

  const removed: HardwareComponent[] = [];
  for (const [k, c] of baselineMap) {
    if (!currentMap.has(k)) removed.push(c);
  }

  return { added, removed, changed };
}

function summarizeDiff(diff: HardwareComponentDiff): string {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`${diff.added.length} added`);
  if (diff.removed.length) parts.push(`${diff.removed.length} removed`);
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
  return parts.length > 0 ? parts.join(", ") : "no differences";
}

/**
 * Collect the current hardware inventory, compare it to the recorded
 * baseline, and reconcile:
 *
 *   - no baseline yet (first boot) → sign + persist the snapshot as the
 *     new baseline. No audit row — establishing the first baseline is
 *     not a "change".
 *   - baseline matches → no-op.
 *   - baseline diverges → sign + persist the new snapshot as the baseline
 *     (this becomes the reference for the NEXT check) and emit one
 *     `hardware_changed` ActivityRow (kind `system`, severity `warn`)
 *     via the injected `recordActivity`, carrying the diff in `refs`.
 *
 * Never throws away hardware-signal errors — a `collector.collect()` or
 * `identity.signWithDeviceKey()` failure propagates so the caller's
 * best-effort wrapper (boot sequence) logs it; this function itself does
 * not swallow errors, matching `audit-daily-root.service.ts`'s posture.
 */
export async function checkHardwareInventory(
  deps: HardwareBomDeps,
): Promise<HardwareBomCheckResult> {
  const { prisma, identity, collector, recordActivity } = deps;
  const now = deps.now ?? new Date();

  const snapshot = await collector.collect();
  const canonical = canonicalizeComponents(snapshot.components);
  const componentsHash = hashComponents(canonical);

  const baseline = await prisma.hardwareBaseline.findUnique({
    where: { id: HARDWARE_BASELINE_ID },
  });

  if (!baseline) {
    const signed = await identity.signWithDeviceKey(Buffer.from(canonical, "utf8"));
    await prisma.hardwareBaseline.create({
      data: {
        id: HARDWARE_BASELINE_ID,
        components: snapshot.components as unknown as Prisma.InputJsonValue,
        componentsHash,
        signature: Buffer.from(signed.signature).toString("base64"),
        algorithm: signed.algorithm,
        capturedAt: now,
      },
    });
    logger.info(
      { componentCount: snapshot.components.length },
      "hardware inventory baseline captured",
    );
    return { status: "captured", componentCount: snapshot.components.length };
  }

  if (baseline.componentsHash === componentsHash) {
    return { status: "unchanged" };
  }

  const baselineComponents = baseline.components as unknown as HardwareComponent[];
  const diff = diffComponents(baselineComponents, snapshot.components);

  const signed = await identity.signWithDeviceKey(Buffer.from(canonical, "utf8"));
  await prisma.hardwareBaseline.update({
    where: { id: HARDWARE_BASELINE_ID },
    data: {
      components: snapshot.components as unknown as Prisma.InputJsonValue,
      componentsHash,
      signature: Buffer.from(signed.signature).toString("base64"),
      algorithm: signed.algorithm,
      capturedAt: now,
    },
  });

  await recordActivity({
    kind: "system",
    severity: "warn",
    sourceIcon: "cpu",
    what: "hardware_changed",
    sub: summarizeDiff(diff),
    refs: {
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    },
    actor: { type: "system" },
    at: now,
  });

  logger.warn({ diff }, "hardware inventory changed vs recorded baseline");
  return { status: "changed", diff };
}
