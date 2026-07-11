/**
 * WARP-901 — `timestamp_convert` (epoch <-> ISO-8601). Tier-1 read, pure
 * computation, no ToolContext dependencies.
 */
import { describe, it, expect } from "vitest";
import timestampConvert from "../../../src/handlers/data/timestamp-convert.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

describe("timestamp_convert — epoch -> ISO", () => {
  it("converts epoch seconds (default unit) to ISO", async () => {
    const res = await timestampConvert.handler({ value: "1700000000" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { iso: string; epochSeconds: number; epochMillis: number };
      expect(data.iso).toBe("2023-11-14T22:13:20.000Z");
      expect(data.epochSeconds).toBe(1700000000);
      expect(data.epochMillis).toBe(1700000000000);
    }
  });

  it("converts epoch milliseconds when unit: 'milliseconds'", async () => {
    const res = await timestampConvert.handler({ value: "1700000000000", unit: "milliseconds" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { iso: string; epochMillis: number };
      expect(data.iso).toBe("2023-11-14T22:13:20.000Z");
      expect(data.epochMillis).toBe(1700000000000);
    }
  });

  it("handles a negative epoch (pre-1970)", async () => {
    const res = await timestampConvert.handler({ value: "-3600" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { iso: string };
      expect(data.iso).toBe("1969-12-31T23:00:00.000Z");
    }
  });
});

describe("timestamp_convert — unit auto-detection when omitted", () => {
  it("treats a 10-digit epoch with no unit as seconds", async () => {
    const res = await timestampConvert.handler({ value: "1700000000" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { iso: string; epochMillis: number };
      expect(data.iso).toBe("2023-11-14T22:13:20.000Z");
      expect(data.epochMillis).toBe(1700000000000);
    }
  });

  it("treats a 13-digit epoch with no unit as milliseconds (no ×1000 blow-up)", async () => {
    const res = await timestampConvert.handler({ value: "1700000000000" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { iso: string; epochSeconds: number; epochMillis: number };
      // Without the magnitude guard this ×1000s to a year +55840 date.
      expect(data.iso).toBe("2023-11-14T22:13:20.000Z");
      expect(data.epochSeconds).toBe(1700000000);
      expect(data.epochMillis).toBe(1700000000000);
    }
  });

  it("still honors an explicit unit over the magnitude heuristic", async () => {
    // 13 digits but caller explicitly says seconds → respect it.
    const res = await timestampConvert.handler(
      { value: "1000000000000", unit: "seconds" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { epochMillis: number };
      expect(data.epochMillis).toBe(1000000000000 * 1000);
    }
  });
});

describe("timestamp_convert — ISO -> epoch", () => {
  it("converts an ISO-8601 string to both epoch forms", async () => {
    const res = await timestampConvert.handler({ value: "2023-11-14T22:13:20.000Z" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { epochSeconds: number; epochMillis: number; iso: string };
      expect(data.epochSeconds).toBe(1700000000);
      expect(data.epochMillis).toBe(1700000000000);
      expect(data.iso).toBe("2023-11-14T22:13:20.000Z");
    }
  });
});

describe("timestamp_convert — error handling", () => {
  it("rejects a missing value", async () => {
    const res = await timestampConvert.handler({}, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects an unparseable string", async () => {
    const res = await timestampConvert.handler({ value: "not-a-timestamp" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNPARSEABLE_TIMESTAMP");
  });

  it("rejects an epoch outside the safe integer range", async () => {
    const res = await timestampConvert.handler({ value: "99999999999999999999" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects an unrecognized unit instead of silently coercing to seconds", async () => {
    // "ms" is a plausible-but-wrong unit; the old code fell through to
    // seconds and ×1000'd the value. It must be an explicit error.
    const res = await timestampConvert.handler({ value: "1700000000000", unit: "ms" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });
});

describe("timestamp_convert — tool metadata", () => {
  it("is named timestamp_convert and is Tier-1 (no write, no confirm)", () => {
    expect(timestampConvert.name).toBe("timestamp_convert");
    expect(timestampConvert.requiresWrite).toBe(false);
    expect(timestampConvert.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((timestampConvert.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
