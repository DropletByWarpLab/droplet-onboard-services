import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { emptyCameraBusinessHours } from "./camera-business-hours.service.js";
const fetchRecordings = vi.hoisted(() => vi.fn());
vi.mock("./frigate.client.js", () => ({ fetchRecordings }));
vi.mock("../lib/logger.js", () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { getMotionActivity } from "./camera-motion.service.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const after = epoch("2026-10-05T15:00:00Z"), before = epoch("2026-10-05T19:00:00Z");
const hours = { ...emptyCameraBusinessHours(), configured: true };
hours.days.monday = { open: "09:00", close: "17:00" };
const prisma = { systemFlag: { findUnique: async () => ({ valueJson: hours }) } } as unknown as PrismaClient;
const segment = (start: string, end: string, motion: number) => ({ start_time: epoch(start), end_time: epoch(end), motion });
beforeEach(() => fetchRecordings.mockReset());

describe("motion in retained recordings", () => {
  it("keeps constant positive raw counts, merges contiguous motion and classifies the whole span", async () => {
    fetchRecordings.mockResolvedValue([
      segment("2026-10-05T16:59:00Z", "2026-10-05T17:00:00Z", 1500),
      segment("2026-10-05T17:00:00Z", "2026-10-05T17:01:00Z", 1500),
      segment("2026-10-05T17:01:00Z", "2026-10-05T17:02:00Z", 0),
      segment("2026-10-05T17:02:00Z", "2026-10-05T17:03:00Z", 1500),
      segment("2026-10-05T16:00:00Z", "2026-10-05T16:01:00Z", 1),
    ]);
    const result = await getMotionActivity(prisma, ["office"], { after, before, limit: 50, businessHours: "outside" });
    expect(result.activity).toHaveLength(2);
    expect(result.activity[1]).toMatchObject({ startTime: epoch("2026-10-05T16:59:00Z"),
      endTime: epoch("2026-10-05T17:01:00Z"), motion: 3000, outsideBusinessHours: true });
    expect(result.activity[1].playbackUrl).toContain("/api/cameras/office/playback.m3u8?after=");
    expect(result.coverage.cameras[0]).toEqual({ camera: "office", recordedSeconds: 300, hasGaps: true, available: true });
    expect(result.scanLimitReached).toBe(false);
  });
  it("paginates filtered windows against a fixed range without repeating timestamp ties", async () => {
    const late = segment("2026-10-05T18:00:00Z", "2026-10-05T18:01:00Z", 2);
    const older = segment("2026-10-05T17:30:00Z", "2026-10-05T17:31:00Z", 4);
    fetchRecordings.mockResolvedValue([late, older]);
    const filter = { after, before, limit: 1, businessHours: "outside" as const };
    const first = await getMotionActivity(prisma, ["office", "door"], filter);
    expect(first.activity).toHaveLength(2);
    expect(first.nextCursor).toBe(late.start_time);
    const second = await getMotionActivity(prisma, ["office", "door"], { ...filter, cursor: first.nextCursor! });
    expect(second.activity).toHaveLength(2);
    expect(second.activity.every((item) => item.startTime === older.start_time)).toBe(true);
    expect(second.nextCursor).toBeNull();
    expect(fetchRecordings.mock.calls.every((call) => call[1] === after && call[2] === before)).toBe(true);
  });
  it("distinguishes unavailable and missing recordings from a covered quiet window", async () => {
    fetchRecordings.mockImplementation(async (camera: string) => {
      if (camera === "offline") throw new Error("frigate unavailable");
      return camera === "quiet" ? [{ start_time: after, end_time: before, motion: 0 }] : [];
    });
    const result = await getMotionActivity(prisma, ["quiet", "empty", "offline"], { after, before, limit: 50 });
    expect(result.activity).toEqual([]);
    expect(result.coverage.partial).toBe(true);
    expect(result.coverage.cameras).toEqual([
      { camera: "quiet", recordedSeconds: before - after, hasGaps: false, available: true },
      { camera: "empty", recordedSeconds: 0, hasGaps: true, available: true },
      { camera: "offline", recordedSeconds: null, hasGaps: true, available: false },
    ]);
  });
  it("counts overlapping retained intervals once and clips to the requested range", async () => {
    fetchRecordings.mockResolvedValue([
      { start_time: after - 5, end_time: after + 10, motion: 1 },
      { start_time: after + 5, end_time: after + 20, motion: 2 },
      { start_time: before - 5, end_time: before + 10, motion: 0 },
    ]);
    const result = await getMotionActivity(prisma, ["office"], { after, before, limit: 50 });
    expect(result.coverage.cameras[0].recordedSeconds).toBe(25);
    expect(result.activity[0]).toMatchObject({ startTime: after, endTime: after + 20, motion: 3 });
  });
  it.each([undefined, null, "1", "invalid", NaN, Infinity, -1])("treats invalid motion metadata as unavailable, not zero: %s", async (motion) => {
    fetchRecordings.mockResolvedValue([{ start_time: after, end_time: before, motion }]);
    const result = await getMotionActivity(prisma, ["office"], { after, before, limit: 50 });
    expect(result.activity).toEqual([]);
    expect(result.coverage.partial).toBe(true);
    expect(result.coverage.cameras[0]).toEqual({ camera: "office", available: false, recordedSeconds: null, hasGaps: true });
  });
});
