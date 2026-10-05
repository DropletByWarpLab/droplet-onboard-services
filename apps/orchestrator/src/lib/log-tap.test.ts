/**
 * WARP-3504 (ADR-068) — the pino stream hook behind log telemetry: only warn+
 * records, reduced to level / logger / stable code / msg; nothing else of the
 * record survives; the sender's own logger is never tapped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { TappedLog } from "./log-tap.js";

type Tap = typeof import("./log-tap.js");

let tap: Tap;
let seen: TappedLog[];

const line = (o: Record<string, unknown>) => `${JSON.stringify({ level: 40, time: 1_790_000_000_000, name: "svc", ...o })}\n`;

beforeEach(async () => {
  vi.resetModules();
  tap = await import("./log-tap.js");
  seen = [];
  tap.setLogTapSink((r) => seen.push(r));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("logTapStream", () => {
  it("keeps level, logger, time, code and msg of a warn+ record, and nothing else", () => {
    tap.logTapStream.write(
      line({
        level: 50,
        event: "update.health_gate_failed",
        msg: "health gate failed",
        // Structured fields carry values; none of them may travel.
        user: "jane@acme.example",
        path: "/srv/files/x.pdf",
        requestId: "r-1",
      }),
    );
    expect(seen).toEqual([
      {
        at: 1_790_000_000_000,
        level: "error",
        logger: "svc",
        code: "update.health_gate_failed",
        msg: "health gate failed",
      },
    ]);
  });

  it("maps 40, 50 and 60 to warn, error and fatal and ignores everything below", () => {
    for (const level of [10, 20, 30]) tap.logTapStream.write(line({ level, msg: "x" }));
    for (const level of [40, 50, 60]) tap.logTapStream.write(line({ level, msg: "x" }));
    expect(seen.map((r: any) => r.level)).toEqual(["warn", "error", "fatal"]);
  });

  it("derives the code: event, then err.code, then the error class, then the logger", () => {
    tap.logTapStream.write(line({ event: "a.b", err: { code: "ECONNREFUSED", type: "Error" } }));
    tap.logTapStream.write(line({ err: { code: "ECONNREFUSED", type: "Error" } }));
    tap.logTapStream.write(line({ err: { type: "TypeError", message: "x is not a function" } }));
    tap.logTapStream.write(line({ err: { name: "RouterError" } }));
    tap.logTapStream.write(line({ name: "cron-runtime", level: 50 }));
    expect(seen.map((r: any) => r.code)).toEqual([
      "a.b",
      "ECONNREFUSED",
      "TypeError",
      "RouterError",
      "cron-runtime.error",
    ]);
  });

  it("never uses err.message or the stack, only pino's own msg", () => {
    tap.logTapStream.write(
      line({ msg: "lookup failed", err: { type: "Error", message: "user jane@acme.example not found", stack: "at /srv/x.js" } }),
    );
    expect(JSON.stringify(seen)).not.toMatch(/jane|acme|srv/);
    expect((seen[0] as any).msg).toBe("lookup failed");
  });

  it("does not let free text become a code: a non-code event or err.code falls through", () => {
    tap.logTapStream.write(line({ event: "File Q3 budget.xlsx missing", err: { code: "has spaces" }, name: "files" }));
    expect((seen[0] as any).code).toBe("files.warn");
  });

  it("ignores the sender's own logger, so a failing send cannot become a log record that is sent", () => {
    tap.logTapStream.write(line({ name: tap.TELEMETRY_LOGGER_NAME, msg: "telemetry delivery is failing" }));
    expect(seen).toEqual([]);
  });

  it("never throws into the logger: garbage, a throwing sink and a missing msg", () => {
    expect(() => tap.logTapStream.write("not json\n")).not.toThrow();
    expect(() => tap.logTapStream.write("")).not.toThrow();
    tap.setLogTapSink(() => {
      throw new Error("consumer bug");
    });
    expect(() => tap.logTapStream.write(line({ msg: "x" }))).not.toThrow();
    tap.setLogTapSink((r) => seen.push(r));
    tap.logTapStream.write(line({}));
    expect((seen.at(-1) as any).msg).toBe("");
  });
});

describe("before a consumer attaches", () => {
  it("holds records in a ring of 200 and hands them over on attach, oldest dropped first", async () => {
    vi.resetModules();
    const fresh = await import("./log-tap.js");
    for (let i = 0; i < 250; i++) fresh.logTapStream.write(line({ msg: `m${i}` }));
    const got: string[] = [];
    fresh.setLogTapSink((r) => got.push(r.msg));
    expect(got).toHaveLength(200);
    expect(got[0]).toBe("m50");
    expect(got.at(-1)).toBe("m249");
    // Drained: a second consumer does not see them again.
    const again: string[] = [];
    fresh.setLogTapSink((r) => again.push(r.msg));
    expect(again).toEqual([]);
  });
});

describe("stdoutWithLogTap (what createLogger hands pino)", () => {
  it("writes every line to stdout unchanged, and taps only warn+ lines", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const info = line({ level: 30, msg: "fine" });
    const warn = line({ level: 40, msg: "careful" });
    tap.stdoutWithLogTap.write(info);
    tap.stdoutWithLogTap.write(warn);
    expect(out.mock.calls.map((c) => c[0])).toEqual([info, warn]);
    expect(seen.map((r: any) => r.msg)).toEqual(["careful"]);
  });

  it("is what createLogger uses: a warn through a real logger reaches the tap, an info does not", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("LOG_LEVEL", "info");
    const { createLogger } = await import("./logger.js");
    const log = createLogger("orders");
    log.info({ event: "x.info" }, "not tapped");
    log.warn({ event: "x.warn" }, "tapped");
    log.error({ err: Object.assign(new Error("boom"), { code: "E_BOOM" }) }, "failed");
    expect(seen.map((r: any) => [r.level, r.logger, r.code, r.msg])).toEqual([
      ["warn", "orders", "x.warn", "tapped"],
      ["error", "orders", "E_BOOM", "failed"],
    ]);
  });
});
