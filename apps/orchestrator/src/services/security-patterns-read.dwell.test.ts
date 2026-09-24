/**
 * WARP-2980 (review #2352, finding 6) — the read side takes the dwell sample
 * floor from lib/security-baseline-math.ts, never a copy of its number: the
 * page and the explanation must say "not enough visits yet" exactly when the
 * rule could not fire. Proven by moving the floor (30 → 40) under the reader.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../lib/security-baseline-math.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/security-baseline-math.js")>()),
  DWELL_MIN_SAMPLES: 40,
}));

import { explainSecurityPattern, readPatternCells } from "./security-patterns-read.js";
import { cellsFor, newPatternsWorld, patternsPrisma } from "../__tests__/security-patterns.fake.js";

const TZ = "America/New_York";
const NOW = new Date("2026-09-22T18:10:00Z"); // Tue 2:10 PM in New York
const B = "b-ready";
const ALL = { visibleCameras: "all" as const, mayReadThreats: true, mayReadLocks: true };

function db() {
  return patternsPrisma(
    newPatternsWorld({
      hours: { state: "set", timezone: TZ },
      cameras: [{ name: "front", displayName: "Front camera" }],
      builds: [{ id: B, state: "ready", timezone: TZ, windowFrom: "2026-08-25", windowTo: "2026-09-21", finishedAt: NOW, startedAt: NOW }],
      // 35 samples: enough under a floor of 30, not under 40.
      cells: cellsFor(B, { zoneKey: "camera:front", keyKind: "camera", camera: "front", cameras: ["front"] }, "person", () => ({
        dwellSamples: 35,
        durationP99Sec: 95,
      })),
    }),
  ) as unknown as PrismaClient;
}

describe("the dwell sample floor comes from the math library", () => {
  it("route 30: below the floor there is no longest usual visit", async () => {
    const r = await readPatternCells(db(), ALL, "camera:front", "person");
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.cells.every((c) => c.longestUsualVisitSec === null)).toBe(true);
  });

  it("route 31: below the floor the explanation says the same", async () => {
    const r = await explainSecurityPattern(db(), ALL, { camera: "front" }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.cell!.dwell.longestUsualVisitSec).toBeNull();
    expect(r.view.cell!.dwell.samples).toBe(35);
  });
});
