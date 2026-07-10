import { describe, it, expect } from "vitest";
import { formatUsd, formatApptTime, syncedAgo, formatDate } from "./erp-format";
import { writeModeOf } from "./erp-types";

describe("erp-format", () => {
  it("formats USD whole dollars and cents", () => {
    expect(formatUsd(824000)).toBe("$8,240");
    expect(formatUsd(4291000)).toBe("$42,910");
    expect(formatUsd(4291050, { cents: true })).toBe("$42,910.50");
  });

  it("buckets relative sync time", () => {
    const now = Date.parse("2026-07-07T12:00:00Z");
    expect(syncedAgo(new Date(now - 2 * 60_000).toISOString(), now)).toBe("2 min ago");
    expect(syncedAgo(new Date(now - 10_000).toISOString(), now)).toBe("just now");
    expect(syncedAgo(new Date(now - 3 * 3600_000).toISOString(), now)).toBe("3 hr ago");
    expect(syncedAgo(undefined, now)).toBe("never");
  });

  it("formats appointment time and dates safely", () => {
    expect(formatApptTime("2026-07-07T09:00:00")).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
    expect(formatApptTime("not-a-date")).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });
});

describe("writeModeOf", () => {
  it("maps the write flags to a mode", () => {
    expect(writeModeOf({ writeEnabled: false })).toBe("read-only");
    expect(writeModeOf({ writeEnabled: true })).toBe("writes-enabled");
    expect(writeModeOf({ writeEnabled: true, writesPaused: true })).toBe("writes-paused");
  });
});
