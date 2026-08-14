import { describe, it, expect } from "vitest";
import {
  levelLabel,
  levelBlurb,
  poolStatusBadge,
  reclaimPoolImpact,
  worstPoolAlarm,
} from "@/components/FileManager/pool-display";
import type { PoolInfo } from "@/lib/types";

describe("pool-display helpers (BUG-3)", () => {
  it("labels every RAID level", () => {
    expect(levelLabel("raid0")).toBe("RAID 0");
    expect(levelLabel("raid1")).toBe("RAID 1");
    expect(levelLabel("raid5")).toBe("RAID 5");
    expect(levelLabel("raid6")).toBe("RAID 6");
    expect(levelLabel("raid10")).toBe("RAID 10");
    expect(levelLabel("jbod")).toBe("JBOD");
  });

  it("gives a redundancy blurb that matches the level's protection", () => {
    expect(levelBlurb("raid1")).toMatch(/survives one drive/i);
    expect(levelBlurb("raid6")).toMatch(/two drives/i);
    expect(levelBlurb("raid0")).toMatch(/no redundancy/i);
  });

  it("maps status to a label + alarm flag", () => {
    expect(poolStatusBadge("active").alarm).toBe("none");
    expect(poolStatusBadge("degraded").alarm).toBe("degraded");
    expect(poolStatusBadge("resyncing").alarm).toBe("resyncing");
    expect(poolStatusBadge("failed").alarm).toBe("failed");
  });

  // WARP-1915 — the reclaim confirm dialog spells out what removing a member
  // does to the pool. Mirrored levels get the explicit lost-redundancy
  // warning; parity levels the softer degraded-protection line; levels with
  // no redundancy (and an unknown pool — degraded pools fetch) the plain
  // member loss.
  it("reclaimPoolImpact names the lost mirror redundancy for mirrored levels", () => {
    expect(reclaimPoolImpact("raid1")).toMatch(/mirror/i);
    expect(reclaimPoolImpact("raid1")).toMatch(/protected against a drive failure/i);
    expect(reclaimPoolImpact("raid10")).toMatch(/mirror/i);
  });

  it("reclaimPoolImpact warns about reduced protection for parity levels", () => {
    expect(reclaimPoolImpact("raid5")).toMatch(/less protection/i);
    expect(reclaimPoolImpact("raid6")).toMatch(/less protection/i);
    expect(reclaimPoolImpact("raid5")).not.toMatch(/mirror/i);
  });

  it("reclaimPoolImpact states the plain member loss for non-redundant or unknown pools", () => {
    for (const level of ["raid0", "jbod", undefined] as const) {
      expect(reclaimPoolImpact(level)).toMatch(/one less drive/i);
      expect(reclaimPoolImpact(level)).not.toMatch(/mirror/i);
    }
  });

  it("worstPoolAlarm picks the most severe state across pools", () => {
    const p = (status: PoolInfo["status"]): PoolInfo => ({
      device: "md0",
      level: "raid5",
      status,
      members: [],
    });
    expect(worstPoolAlarm([])).toBeNull();
    expect(worstPoolAlarm([p("active")])).toBeNull();
    expect(worstPoolAlarm([p("resyncing"), p("active")])).toBe("resyncing");
    expect(worstPoolAlarm([p("resyncing"), p("degraded")])).toBe("degraded");
    expect(worstPoolAlarm([p("degraded"), p("failed")])).toBe("failed");
  });
});
