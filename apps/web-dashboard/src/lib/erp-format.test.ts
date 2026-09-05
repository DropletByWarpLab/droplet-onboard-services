import { afterAll, beforeAll, describe, it, expect } from "vitest";
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

/**
 * WARP-2581 — a ledger date must render the day the vendor meant.
 *
 * A calendar date has no time zone. Both shapes a connector produces for one
 * — the bare `2026-09-10` a vendor sends, and the `2026-09-10T00:00:00.000Z`
 * that becomes once Prisma has stored and re-serialised it — parse to UTC
 * midnight, which is the PREVIOUS EVENING everywhere behind UTC. That is all
 * of the US, so an invoice due the 10th read "Sep 9" on the box it shipped to.
 *
 * The timezone is forced, because the assertion is only meaningful in a zone
 * behind UTC: on a UTC runner the buggy and the fixed code agree, and a test
 * that cannot fail is worse than no test.
 */
describe("formatDate — a calendar date is not an instant", () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    process.env.TZ = original;
  });

  it("is really running behind UTC", () => {
    // Guards the guard: if the runtime ignored TZ, every case below would pass
    // for the wrong reason.
    expect(new Date("2026-09-10T00:00:00.000Z").getTimezoneOffset()).toBeGreaterThan(0);
  });

  it("renders a bare date-only string on its own day", () => {
    expect(formatDate("2026-09-10")).toBe("Sep 10, 2026");
  });

  it("renders a UTC-midnight instant on its own day too", () => {
    // The shape /api/money serves: `dueAt`/`issuedAt` are Prisma DateTimes,
    // landed from a vendor's date-only field, so they arrive as UTC midnight.
    expect(formatDate("2026-09-10T00:00:00.000Z")).toBe("Sep 10, 2026");
    expect(formatDate("2026-01-01T00:00:00Z")).toBe("Jan 1, 2026");
  });

  it("leaves a real instant alone", () => {
    // 08:30 UTC is 01:30 the SAME morning in Los Angeles — nothing to correct.
    expect(formatDate("2026-09-10T08:30:00.000Z")).toBe("Sep 10, 2026");
    // ...and 03:00 UTC is the evening BEFORE, which is genuinely what happened.
    expect(formatDate("2026-09-10T03:00:00.000Z")).toBe("Sep 9, 2026");
  });

  it("still refuses what it cannot read", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("last tuesday")).toBe("—");
  });
});

describe("writeModeOf", () => {
  it("maps the write flags to a mode", () => {
    expect(writeModeOf({ writeEnabled: false })).toBe("read-only");
    expect(writeModeOf({ writeEnabled: true })).toBe("writes-enabled");
    expect(writeModeOf({ writeEnabled: true, writesPaused: true })).toBe("writes-paused");
  });
});
