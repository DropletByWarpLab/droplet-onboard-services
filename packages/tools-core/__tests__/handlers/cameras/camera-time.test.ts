/**
 * WARP-3747 / WARP-3927 — wall-clock <-> epoch conversion for the camera tools.
 *
 * The orchestrator's camera routes take epoch seconds; people give wall time.
 * These pin the conversion across zones, offsets and DST edges, and the strict
 * rejection of garbage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatIsoInZone,
  humanDuration,
  parseTimeInput,
  resolveWindow,
  resolveWorkspaceTimezone,
  withLocalTimes,
} from "../../../src/handlers/cameras/_time.js";
import { parseEventFilters } from "../../../src/handlers/cameras/_event-filters.js";
import { cameraCtx, NOW_EPOCH, NOW_ISO } from "../../helpers/camera-ctx.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const ok = (r: ReturnType<typeof parseTimeInput>): number => {
  if (!r.ok) throw new Error(r.message);
  return r.epoch;
};

describe("parseTimeInput", () => {
  it("reads a natural time as wall time in the workspace zone", () => {
    // PDT is UTC-7 on 2026-10-07.
    expect(ok(parseTimeInput("2026-10-07 18:30", "America/Los_Angeles", "after"))).toBe(epoch("2026-10-08T01:30:00Z"));
    expect(ok(parseTimeInput("2026-10-07T18:30", "America/Los_Angeles", "after"))).toBe(epoch("2026-10-08T01:30:00Z"));
    expect(ok(parseTimeInput("2026-10-07 18:30:15", "Europe/Paris", "after"))).toBe(epoch("2026-10-07T16:30:15Z"));
  });

  it("reads a bare date as local midnight", () => {
    expect(ok(parseTimeInput("2026-10-07", "America/Los_Angeles", "after"))).toBe(epoch("2026-10-07T07:00:00Z"));
  });

  it("an explicit offset or Z wins over the workspace zone", () => {
    expect(ok(parseTimeInput("2026-10-07T18:30:00Z", "America/Los_Angeles", "after"))).toBe(epoch("2026-10-07T18:30:00Z"));
    expect(ok(parseTimeInput("2026-10-07T18:30:00+02:00", "America/Los_Angeles", "after"))).toBe(epoch("2026-10-07T16:30:00Z"));
    expect(ok(parseTimeInput("2026-10-07 18:30-0700", "Asia/Tokyo", "after"))).toBe(epoch("2026-10-08T01:30:00Z"));
    expect(ok(parseTimeInput("2026-10-07T18:30:00+05:30", "UTC", "after"))).toBe(epoch("2026-10-07T13:00:00Z"));
  });

  it("handles half-hour and +13 zones", () => {
    expect(ok(parseTimeInput("2026-10-07 12:00", "Asia/Kolkata", "after"))).toBe(epoch("2026-10-07T06:30:00Z"));
    expect(ok(parseTimeInput("2026-01-10 12:00", "Pacific/Auckland", "after"))).toBe(epoch("2026-01-09T23:00:00Z"));
  });

  describe("DST", () => {
    it("a wall time the spring-forward gap skips is refused, with the zone named", () => {
      const r = parseTimeInput("2026-03-08 02:30", "America/New_York", "at");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/does not exist in America\/New_York/);
    });

    it("times either side of the gap resolve with the right offset", () => {
      expect(ok(parseTimeInput("2026-03-08 01:59", "America/New_York", "at"))).toBe(epoch("2026-03-08T06:59:00Z")); // EST -5
      expect(ok(parseTimeInput("2026-03-08 03:00", "America/New_York", "at"))).toBe(epoch("2026-03-08T07:00:00Z")); // EDT -4
    });

    it("a repeated fall-back wall time resolves to its FIRST occurrence", () => {
      // 2026-11-01 01:30 happens twice in New York: 05:30Z (EDT) then 06:30Z (EST).
      expect(ok(parseTimeInput("2026-11-01 01:30", "America/New_York", "at"))).toBe(epoch("2026-11-01T05:30:00Z"));
      // Europe: 2026-10-25 02:30 happens at 00:30Z (CEST) and 01:30Z (CET).
      expect(ok(parseTimeInput("2026-10-25 02:30", "Europe/Paris", "at"))).toBe(epoch("2026-10-25T00:30:00Z"));
      // An explicit offset reaches the second occurrence.
      expect(ok(parseTimeInput("2026-11-01T01:30:00-05:00", "America/New_York", "at"))).toBe(epoch("2026-11-01T06:30:00Z"));
    });

    it("a day containing a transition keeps both ends right", () => {
      expect(ok(parseTimeInput("2026-11-01 00:00", "America/New_York", "after"))).toBe(epoch("2026-11-01T04:00:00Z"));
      expect(ok(parseTimeInput("2026-11-02 00:00", "America/New_York", "before"))).toBe(epoch("2026-11-02T05:00:00Z"));
    });
  });

  it("accepts epoch seconds, refuses milliseconds and nonsense numbers", () => {
    expect(ok(parseTimeInput(1_791_460_800, "UTC", "after"))).toBe(1_791_460_800);
    for (const bad of [1_791_460_800_000, 5, -1, Number.NaN, Infinity]) {
      expect(parseTimeInput(bad, "UTC", "after").ok, String(bad)).toBe(false);
    }
  });

  it.each([
    "yesterday",
    "last night",
    "2026-13-01",
    "2026-02-30 10:00",
    "2026-10-07 25:00",
    "2026-10-07 18:61",
    "2026-10-07 18:30:61",
    "10/07/2026 18:30",
    "2026-10-07 18:30 PM",
    "2026-10-07T18:30:00+25:00",
    "1999-01-01 10:00",
    "",
    "   ",
  ])("rejects %j", (bad) => {
    expect(parseTimeInput(bad, "UTC", "after").ok).toBe(false);
  });

  it.each([null, undefined, {}, [], true])("rejects non-string %j", (bad) => {
    expect(parseTimeInput(bad, "UTC", "after").ok).toBe(false);
  });

  it("names the field in the error", () => {
    const r = parseTimeInput("nope", "UTC", "starts_at");
    expect(!r.ok && r.message).toContain("starts_at");
  });
});

describe("formatIsoInZone", () => {
  it("renders local wall time with a numeric offset", () => {
    expect(formatIsoInZone(epoch("2026-10-08T01:30:00Z"), "America/Los_Angeles")).toBe("2026-10-07T18:30:00-07:00");
    expect(formatIsoInZone(epoch("2026-01-08T01:30:00Z"), "America/Los_Angeles")).toBe("2026-01-07T17:30:00-08:00");
    expect(formatIsoInZone(epoch("2026-10-07T06:30:00Z"), "Asia/Kolkata")).toBe("2026-10-07T12:00:00+05:30");
    expect(formatIsoInZone(epoch("2026-10-07T06:30:00Z"), "UTC")).toBe("2026-10-07T06:30:00+00:00");
  });

  it("shows the offset change across a DST boundary", () => {
    expect(formatIsoInZone(epoch("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01T01:30:00-04:00");
    expect(formatIsoInZone(epoch("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-11-01T01:30:00-05:00");
  });

  it("round-trips with parseTimeInput", () => {
    for (const tz of ["America/Los_Angeles", "Europe/Paris", "Asia/Kolkata", "Australia/Lord_Howe"]) {
      const t = epoch("2026-07-15T09:41:00Z");
      const local = formatIsoInZone(t, tz).slice(0, 16);
      expect(ok(parseTimeInput(local, tz, "at")), tz).toBe(t);
    }
  });

  it("truncates fractional epoch seconds", () => {
    expect(formatIsoInZone(epoch("2026-10-07T06:30:00Z") + 0.9, "UTC")).toBe("2026-10-07T06:30:00+00:00");
  });
});

describe("withLocalTimes", () => {
  it("adds ISO times beside the epoch fields and keeps every other field", () => {
    const out = withLocalTimes(
      { id: "e1", startTime: epoch("2026-10-08T01:30:00Z") + 0.4, endTime: epoch("2026-10-08T01:31:00Z"), label: "person" },
      "America/Los_Angeles",
    );
    expect(out).toMatchObject({
      id: "e1",
      label: "person",
      startTime: epoch("2026-10-08T01:30:00Z") + 0.4,
      startTimeIso: "2026-10-07T18:30:00-07:00",
      endTimeIso: "2026-10-07T18:31:00-07:00",
    });
  });

  it("endTimeIso is null while the event is still running", () => {
    expect(withLocalTimes({ startTime: NOW_EPOCH, endTime: null }, "UTC")).toMatchObject({ endTimeIso: null });
  });

  it("is null-safe when a row has no times", () => {
    expect(withLocalTimes({ id: "x" }, "UTC")).toMatchObject({ startTimeIso: null, endTimeIso: null });
  });
});

describe("humanDuration", () => {
  it.each([
    [0, "0s"],
    [45, "45s"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h 00m"],
    [5400, "1h 30m"],
    [93600, "26h 00m"],
  ])("%d s -> %s", (s, text) => expect(humanDuration(s)).toBe(text));
});

describe("resolveWorkspaceTimezone", () => {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;

  it("uses the zone saved with the camera business hours", async () => {
    const { ctx } = cameraCtx({}, "Europe/Paris");
    expect(await resolveWorkspaceTimezone(ctx)).toBe("Europe/Paris");
  });

  it("falls back to the box zone when the schedule was never saved", async () => {
    const { ctx } = cameraCtx({}, null);
    expect(await resolveWorkspaceTimezone(ctx)).toBe(system);
  });

  it("ignores the stored placeholder zone while unconfigured", async () => {
    const { ctx, findUnique } = cameraCtx({}, "Asia/Tokyo");
    findUnique.mockResolvedValue({ key: "cameras.business_hours", valueJson: { configured: false, timezone: "UTC" } } as never);
    expect(await resolveWorkspaceTimezone(ctx)).toBe(system);
  });

  it("falls back (never throws) when there is no database handle or the zone is garbage", async () => {
    const { ctx, findUnique } = cameraCtx({}, "Not/AZone");
    expect(await resolveWorkspaceTimezone(ctx)).toBe(system);
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await resolveWorkspaceTimezone(ctx)).toBe(system);
    expect(await resolveWorkspaceTimezone({ prisma: {} } as never)).toBe(system);
  });
});

describe("resolveWindow", () => {
  const H = 3600;
  it("requires after, defaults before to now", () => {
    const missing = resolveWindow({}, "UTC", NOW_EPOCH, 26 * H, "26 hours");
    expect(missing.ok).toBe(false);
    const w = resolveWindow({ after: "2026-10-08 06:00" }, "UTC", NOW_EPOCH, 26 * H, "26 hours");
    expect(w).toMatchObject({ ok: true, window: { after: epoch("2026-10-08T06:00:00Z"), before: NOW_EPOCH, clampedToNow: true } });
  });

  it("clamps a before in the future to now and says so", () => {
    const w = resolveWindow({ after: "2026-10-08 06:00", before: "2026-10-08 18:00" }, "UTC", NOW_EPOCH, 26 * H, "26 hours");
    expect(w).toMatchObject({ ok: true, window: { before: NOW_EPOCH, clampedToNow: true } });
  });

  it("rejects before <= after, a future start, and an over-long window", () => {
    expect(resolveWindow({ after: "2026-10-08 10:00", before: "2026-10-08 09:00" }, "UTC", NOW_EPOCH, 26 * H, "26 hours").ok).toBe(false);
    expect(resolveWindow({ after: "2026-10-08 10:00", before: "2026-10-08 10:00" }, "UTC", NOW_EPOCH, 26 * H, "26 hours").ok).toBe(false);
    const future = resolveWindow({ after: "2026-10-09 10:00" }, "UTC", NOW_EPOCH, 26 * H, "26 hours");
    expect(!future.ok && future.message).toMatch(/future/);
    const long = resolveWindow({ after: "2026-10-06 10:00", before: "2026-10-08 10:00" }, "UTC", NOW_EPOCH, 26 * H, "26 hours");
    expect(!long.ok && long.message).toMatch(/longer than 26 hours/);
  });

  it("a DST day (25 h) fits the 26 h cap", () => {
    const w = resolveWindow(
      { after: "2026-11-01 00:00", before: "2026-11-02 00:00" },
      "America/New_York",
      epoch("2026-11-05T00:00:00Z"),
      26 * H,
      "26 hours",
    );
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.window.before - w.window.after).toBe(25 * H);
  });

  it("surfaces a parse error naming the field", () => {
    const w = resolveWindow({ after: "2026-10-08 10:00", before: "later" }, "UTC", NOW_EPOCH, 26 * H, "26 hours");
    expect(!w.ok && w.message).toContain("before");
  });
});

describe("parseEventFilters (WARP-3747)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => vi.useRealTimers());

  it("converts after/before to epoch seconds in the workspace zone and reports the zone", async () => {
    const { ctx } = cameraCtx({}, "America/Los_Angeles");
    const r = await parseEventFilters({ after: "2026-10-07 18:00", before: "2026-10-07 20:00" }, ctx, true);
    expect(r).toMatchObject({
      ok: true,
      filters: {
        timezone: "America/Los_Angeles",
        active: true,
        params: { after: epoch("2026-10-08T01:00:00Z"), before: epoch("2026-10-08T03:00:00Z") },
      },
    });
  });

  it("labels: csv or array, lower-cased, de-duplicated; min_score 0..1", async () => {
    const { ctx } = cameraCtx({});
    const a = await parseEventFilters({ labels: "Person, car,person", min_score: 0.6 }, ctx, true);
    expect(a).toMatchObject({ ok: true, filters: { params: { labels: "person,car", min_score: 0.6 } } });
    const b = await parseEventFilters({ labels: ["dog", "cat"], min_score: "0.5" }, ctx, true);
    expect(b).toMatchObject({ ok: true, filters: { params: { labels: "dog,cat", min_score: 0.5 } } });
  });

  it("is inactive with no filters, and ignores labels/min_score when the tool does not take them", async () => {
    const { ctx } = cameraCtx({});
    expect(await parseEventFilters({}, ctx, true)).toMatchObject({ ok: true, filters: { active: false, params: {} } });
    expect(await parseEventFilters({ labels: "person", min_score: 5 }, ctx, false)).toMatchObject({ ok: true, filters: { active: false } });
  });

  it.each([
    [{ after: "2026-10-07 20:00", before: "2026-10-07 18:00" }, /later than after/],
    [{ after: "2026-08-01", before: "2026-10-01" }, /31 days/],
    [{ after: "2026-10-09 09:00" }, /future/],
    [{ after: "garbage" }, /after/],
    [{ labels: "per son" }, /not a valid label/],
    [{ labels: "a,b,c,d,e,f,g,h,i,j,k" }, /at most 10/],
    [{ labels: 7 }, /labels must be/],
    [{ labels: [1] }, /labels must be/],
    [{ min_score: 1.5 }, /min_score/],
    [{ min_score: -0.1 }, /min_score/],
    [{ min_score: "high" }, /min_score/],
  ])("rejects %j", async (args, message) => {
    const { ctx } = cameraCtx({});
    const r = await parseEventFilters(args as Record<string, unknown>, ctx, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(message);
  });

  it("allows after alone or before alone", async () => {
    const { ctx } = cameraCtx({}, "UTC");
    expect(await parseEventFilters({ after: "2026-10-07 18:00" }, ctx, true)).toMatchObject({
      ok: true,
      filters: { params: { after: epoch("2026-10-07T18:00:00Z") } },
    });
    expect(await parseEventFilters({ before: "2026-10-07 18:00" }, ctx, true)).toMatchObject({
      ok: true,
      filters: { params: { before: epoch("2026-10-07T18:00:00Z") } },
    });
  });
});
