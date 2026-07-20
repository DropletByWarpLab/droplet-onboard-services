/**
 * WARP-1424 — `get_current_datetime` (the agent's clock). Tier-1 read,
 * pure computation, no ToolContext dependencies.
 *
 * All tests freeze the clock at 2026-07-19T12:00:00Z (a Sunday) so the
 * per-zone renderings are deterministic:
 *   America/New_York → 08:00 EDT (-04:00), Asia/Tokyo → 21:00 (+09:00).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import getCurrentDatetime from "../../../src/handlers/data/get-current-datetime.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

const FROZEN_ISO_UTC = "2026-07-19T12:00:00Z";
const FROZEN_EPOCH_SECONDS = Math.floor(new Date(FROZEN_ISO_UTC).getTime() / 1000);

interface DatetimeData {
  type: string;
  iso: string;
  utcIso: string;
  epochSeconds: number;
  timezone: string;
  weekday: string;
  humanReadable: string;
}

describe("get_current_datetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_ISO_UTC));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the frozen instant as epochSeconds + utcIso", async () => {
    const res = await getCurrentDatetime.handler({}, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as DatetimeData;
      expect(data.type).toBe("get_current_datetime");
      expect(data.epochSeconds).toBe(FROZEN_EPOCH_SECONDS);
      expect(data.utcIso).toBe("2026-07-19T12:00:00Z");
    }
  });

  it("renders America/New_York with the -04:00 EDT offset and Sunday weekday", async () => {
    const res = await getCurrentDatetime.handler({ timezone: "America/New_York" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as DatetimeData;
      expect(data.timezone).toBe("America/New_York");
      expect(data.iso).toBe("2026-07-19T08:00:00-04:00");
      expect(data.weekday).toBe("Sunday");
      // Tolerate ICU variants: "…, 8:00 AM EDT" vs "… at 8:00 AM EDT".
      expect(data.humanReadable).toMatch(/^Sunday, July 19, 2026(,| at) 8:00 ? ?AM EDT$/);
    }
  });

  it("renders UTC with a +00:00 offset", async () => {
    const res = await getCurrentDatetime.handler({ timezone: "UTC" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as DatetimeData;
      expect(data.timezone).toBe("UTC");
      expect(data.iso).toBe("2026-07-19T12:00:00+00:00");
    }
  });

  it("renders Asia/Tokyo at 21:00 local on the same date with +09:00", async () => {
    const res = await getCurrentDatetime.handler({ timezone: "Asia/Tokyo" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as DatetimeData;
      expect(data.timezone).toBe("Asia/Tokyo");
      expect(data.iso).toBe("2026-07-19T21:00:00+09:00");
      expect(data.weekday).toBe("Sunday");
    }
  });

  it("defaults to the system timezone when no timezone is given", async () => {
    const res = await getCurrentDatetime.handler({}, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as DatetimeData;
      expect(data.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
  });

  it("rejects an unknown IANA zone with INVALID_TIMEZONE", async () => {
    const res = await getCurrentDatetime.handler({ timezone: "Not/AZone" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("INVALID_TIMEZONE");
      expect(res.error.message).toContain("Not/AZone");
    }
  });

  it("rejects a non-string timezone with INVALID_TIMEZONE", async () => {
    const res = await getCurrentDatetime.handler({ timezone: 42 }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_TIMEZONE");
    }
  });
});

describe("get_current_datetime — tool metadata", () => {
  it("is named get_current_datetime and is Tier-1 (no write, no confirm)", () => {
    expect(getCurrentDatetime.name).toBe("get_current_datetime");
    expect(getCurrentDatetime.requiresWrite).toBe(false);
    expect(getCurrentDatetime.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect(
      (getCurrentDatetime.inputSchema as { additionalProperties?: boolean }).additionalProperties,
    ).toBe(false);
  });
});
