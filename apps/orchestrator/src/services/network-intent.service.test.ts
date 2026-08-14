/**
 * WARP-1761 — `NetworkIntent` store for `wifi.primary` (ADR-035 §1/§7).
 *
 * The intent layer answers "what SHOULD the household Wi-Fi be called",
 * separately from the observed answer ("what IS it"), which keeps coming
 * live off the AP. These tests pin the three properties the rest of the
 * ticket leans on:
 *
 *   1. a write RECORDS intent and BUMPS `generation` — monotonic, so the
 *      converger can tell "already applied" from "newer than the device";
 *   2. the recorder is BEST-EFFORT: it can never throw into a request that
 *      is otherwise about to succeed (the whole point of the layer is that
 *      it is additive — the direct push and its HTTP contract are
 *      unchanged); and
 *   3. the passphrase is NOT stored. `wifi.primary` intent carries the SSID
 *      and nothing else — see the module header for why.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  WIFI_PRIMARY_INTENT_KEY,
  recordWifiPrimaryIntent,
  readWifiPrimaryIntent,
  type WifiPrimaryIntentValue,
} from "./network-intent.service.js";

/** In-memory stand-in for the `NetworkIntent` table. */
function createPrismaMock() {
  const rows = new Map<string, any>();
  const networkIntent = {
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.key) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = rows.get(where.key);
      if (existing) {
        const merged = {
          ...existing,
          ...update,
          // Emulate Prisma's `{ increment: n }` atomic update operator.
          generation:
            update.generation && typeof update.generation === "object"
              ? existing.generation + update.generation.increment
              : (update.generation ?? existing.generation),
          updatedAt: new Date(),
        };
        rows.set(where.key, merged);
        return merged;
      }
      const row = { updatedAt: new Date(), ...create };
      rows.set(where.key, row);
      return row;
    }),
    // Present ONLY so the never-delete invariant is assertable (ADR-035 §6).
    delete: vi.fn(async () => {
      throw new Error("intent rows are never deleted");
    }),
    deleteMany: vi.fn(async () => {
      throw new Error("intent rows are never deleted");
    }),
  };
  return { rows, networkIntent };
}

describe("network-intent service — wifi.primary (WARP-1761)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the SSID under the canonical key on first write", async () => {
    const prisma = createPrismaMock();

    await recordWifiPrimaryIntent(prisma as any, { ssid: "Droplet" }, "user-1");

    expect(prisma.networkIntent.upsert).toHaveBeenCalledTimes(1);
    const row = prisma.rows.get(WIFI_PRIMARY_INTENT_KEY);
    expect(WIFI_PRIMARY_INTENT_KEY).toBe("wifi.primary");
    expect(row).toMatchObject({
      key: "wifi.primary",
      value: { ssid: "Droplet" },
      generation: 1,
      writtenBy: "user-1",
    });
  });

  it("BUMPS the generation on every subsequent write", async () => {
    const prisma = createPrismaMock();

    await recordWifiPrimaryIntent(prisma as any, { ssid: "Droplet" }, "user-1");
    await recordWifiPrimaryIntent(prisma as any, { ssid: "Upstairs" }, "user-2");
    await recordWifiPrimaryIntent(prisma as any, { ssid: "Attic" }, undefined);

    const row = prisma.rows.get(WIFI_PRIMARY_INTENT_KEY);
    expect(row.generation).toBe(3);
    expect(row.value).toEqual({ ssid: "Attic" });
    // writtenBy tracks the LAST writer; an unauthenticated/service write
    // records null rather than inheriting the previous human.
    expect(row.writtenBy).toBeNull();
  });

  it("bumps atomically — the generation update is an increment, not a read-then-write", async () => {
    const prisma = createPrismaMock();
    await recordWifiPrimaryIntent(prisma as any, { ssid: "Droplet" });
    await recordWifiPrimaryIntent(prisma as any, { ssid: "Droplet-2" });

    const update = prisma.networkIntent.upsert.mock.calls.at(-1)![0].update;
    // Two concurrent saves must not both compute "generation = 1 + 1".
    expect(update.generation).toEqual({ increment: 1 });
  });

  // The passphrase question, pinned as a test so it cannot regress silently.
  it("NEVER stores the passphrase — a key-only save records no intent at all", async () => {
    const prisma = createPrismaMock();

    await recordWifiPrimaryIntent(prisma as any, { key: "super-secret-psk" });

    // Nothing to converge: `wifi.primary` intent is the SSID, and inventing
    // an SSID from a passphrase-only save would be a fabricated fact.
    expect(prisma.networkIntent.upsert).not.toHaveBeenCalled();
    expect(prisma.rows.size).toBe(0);
  });

  it("stores the SSID and drops the passphrase when a save carries both", async () => {
    const prisma = createPrismaMock();

    await recordWifiPrimaryIntent(prisma as any, {
      ssid: "Droplet",
      key: "super-secret-psk",
    });

    const row = prisma.rows.get(WIFI_PRIMARY_INTENT_KEY);
    expect(row.value).toEqual({ ssid: "Droplet" });
    // Belt and braces: the secret must not survive anywhere in the row.
    expect(JSON.stringify(row)).not.toContain("super-secret-psk");
  });

  it("is best-effort: a DB failure is swallowed, never thrown at the caller", async () => {
    const prisma = createPrismaMock();
    prisma.networkIntent.upsert.mockRejectedValueOnce(new Error("deadlock detected"));

    // The direct push and its HTTP contract must be unaffected by anything
    // that goes wrong in this additive layer.
    await expect(
      recordWifiPrimaryIntent(prisma as any, { ssid: "Droplet" }),
    ).resolves.toBeUndefined();
  });

  it("survives a client with no NetworkIntent delegate at all", async () => {
    // Older generated client / a narrow test double — still must not throw.
    await expect(
      recordWifiPrimaryIntent({} as any, { ssid: "Droplet" }),
    ).resolves.toBeUndefined();
  });

  describe("readWifiPrimaryIntent", () => {
    it("returns null when nothing has ever been written", async () => {
      const prisma = createPrismaMock();
      await expect(readWifiPrimaryIntent(prisma as any)).resolves.toBeNull();
    });

    it("returns the SSID + generation for the converger", async () => {
      const prisma = createPrismaMock();
      await recordWifiPrimaryIntent(prisma as any, { ssid: "Droplet" }, "user-1");

      await expect(readWifiPrimaryIntent(prisma as any)).resolves.toEqual({
        ssid: "Droplet",
        generation: 1,
      });
    });

    it("returns null for a row whose value has no usable ssid", async () => {
      const prisma = createPrismaMock();
      prisma.rows.set(WIFI_PRIMARY_INTENT_KEY, {
        key: WIFI_PRIMARY_INTENT_KEY,
        value: { ssid: "" } as WifiPrimaryIntentValue,
        generation: 4,
      });

      // An empty name is not something to converge a household onto.
      await expect(readWifiPrimaryIntent(prisma as any)).resolves.toBeNull();
    });

    it("degrades to null — never throws — when the read fails", async () => {
      const prisma = createPrismaMock();
      prisma.networkIntent.findUnique.mockRejectedValueOnce(new Error("db down"));
      await expect(readWifiPrimaryIntent(prisma as any)).resolves.toBeNull();
    });
  });
});
