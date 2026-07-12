import { describe, it, expect } from "vitest";
import {
  levelLabel,
  levelBlurb,
  poolStatusBadge,
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
