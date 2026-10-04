/**
 * WARP-3504 (ADR-068) — the builders emit only allowlisted fields, fold and cap
 * the logs, and refuse a fact that breaks its field's shape.
 */
import { describe, it, expect } from "vitest";
import { LogAggregator, buildEvents, buildHeartbeat, foldErrorClasses, toCode } from "./builders.js";
import { HeartbeatSchema, LogsSchema, MAX_LOG_RECORDS } from "./contract.js";
import { sampleFacts } from "./__fixtures__/samples.js";

/** Every key path of a JSON value, arrays collapsed to `[]`. */
function keyPaths(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${prefix}[]`));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => [`${prefix}.${k}`, ...keyPaths(x, `${prefix}.${k}`)]);
  }
  return [];
}

describe("buildHeartbeat", () => {
  it("emits exactly the contract's fields and nothing else", () => {
    const paths = new Set(keyPaths(buildHeartbeat(sampleFacts())).map((p) => p.replace(/\.errorsByClass\.[^.]+$/, ".errorsByClass.*")));
    expect([...paths].sort()).toEqual(
      [
        ".schema",
        ".sentAt",
        ".release",
        ".release.tag",
        ".release.gitSha",
        ".release.channel",
        ".os",
        ".os.kernel",
        ".os.distro",
        ".uptime",
        ".uptime.bootedAt",
        ".uptime.seconds",
        ".services",
        ".services[].name",
        ".services[].state",
        ".services[].health",
        ".services[].restarts",
        ".usage",
        ".usage.cpuPct",
        ".usage.memPct",
        ".usage.diskPct",
        ".usage.netRxBytes",
        ".usage.netTxBytes",
        ".usage.gpus",
        ".usage.gpus[].utilPct",
        ".usage.gpus[].vramUsedMb",
        ".usage.gpus[].vramTotalMb",
        ".usage.gpus[].tempC",
        ".activity",
        ".activity.windowSec",
        ".activity.chatTurns",
        ".activity.agentRuns",
        ".activity.activeUsers",
        ".activity.ota",
        ".activity.ota.checks",
        ".activity.ota.downloads",
        ".activity.ota.applies",
        ".activity.ota.rollbacks",
        ".activity.ota.failures",
        ".activity.errorsByClass",
        ".activity.errorsByClass.*",
      ].sort(),
    );
  });

  it("rounds percentages and temperatures to whole numbers and sorts services by name", () => {
    const hb = buildHeartbeat(sampleFacts());
    expect(hb.usage).toMatchObject({ cpuPct: 12, memPct: 49, diskPct: 61 });
    expect(hb.usage.gpus).toEqual([{ utilPct: 33, vramUsedMb: 4096, vramTotalMb: 16384, tempC: 62 }]);
    expect(hb.services.map((s) => s.name)).toEqual(["ai-gateway", "orchestrator"]);
    expect(HeartbeatSchema.safeParse(hb).success).toBe(true);
  });

  it("clamps a percentage into 0..100", () => {
    const hb = buildHeartbeat(sampleFacts({ usage: { ...sampleFacts().usage, cpuPct: 250, memPct: -3 } }));
    expect(hb.usage.cpuPct).toBe(100);
    expect(hb.usage.memPct).toBe(0);
  });

  it("reports a box that never took an OTA release as the factory image, not a made-up sha", () => {
    const hb = buildHeartbeat(sampleFacts({ release: { tag: null, gitSha: null, channel: "stable" } }));
    expect(hb.release).toEqual({ tag: "factory-image", gitSha: "unknown", channel: "stable" });
  });

  it("refuses a non-finite fact instead of sending a zero", () => {
    expect(() => buildHeartbeat(sampleFacts({ uptimeSec: Number.NaN }))).toThrow(RangeError);
    expect(() => buildHeartbeat(sampleFacts({ usage: { ...sampleFacts().usage, diskPct: Number.POSITIVE_INFINITY } }))).toThrow(
      RangeError,
    );
  });

  it("refuses a fact that breaks its field's shape (a path as a service name)", () => {
    const facts = sampleFacts({
      services: [{ name: "/data/files/secret", state: "running", health: "none", restarts: 0 }],
    });
    expect(() => buildHeartbeat(facts)).toThrow();
  });

  it("cannot be handed extra fields: an unknown key on a fact never reaches the payload", () => {
    const facts = sampleFacts() as unknown as Record<string, unknown>;
    facts.email = "someone@example.org";
    (facts.os as Record<string, unknown>).hostname = "customer-laptop";
    (facts.services as Array<Record<string, unknown>>)[0]!.prompt = "leak";
    const wire = JSON.stringify(buildHeartbeat(facts as never));
    expect(wire).not.toMatch(/someone@|customer-laptop|leak|"email"|"hostname"|"prompt"/);
  });
});

describe("foldErrorClasses", () => {
  it("keeps the most frequent classes and sums the rest into `other`", () => {
    const counts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, i + 1]));
    const folded = foldErrorClasses(counts);
    expect(Object.keys(folded)).toHaveLength(32);
    expect(folded.c39).toBe(40);
    expect(folded.c0).toBeUndefined();
    // c0..c8 are the nine smallest (1..9): 45
    expect(folded.other).toBe(45);
  });

  it("drops zero counts and turns a non-code key into a stable class", () => {
    expect(foldErrorClasses({ ok: 0, "a b/c": 2 })).toEqual({ unclassified: 2 });
  });
});

describe("toCode", () => {
  it("passes a stable code and replaces anything else", () => {
    expect(toCode("update.registry_auth_failed")).toBe("update.registry_auth_failed");
    expect(toCode("has spaces")).toBe("unclassified");
    expect(toCode("/etc/passwd", "fallback")).toBe("fallback");
  });
});

describe("buildEvents", () => {
  it("builds a validated events.v1 payload with only type, at, code and release", () => {
    const [payload] = buildEvents([
      { type: "boot", at: new Date("2026-10-03T12:00:00Z") },
      { type: "ota.apply", at: 1_790_000_000_000, code: "committed", release: "ota-stage-12-gabc1234" },
    ]);
    expect(payload).toEqual({
      schema: "events.v1",
      events: [
        { type: "boot", at: "2026-10-03T12:00:00.000Z" },
        { type: "ota.apply", at: new Date(1_790_000_000_000).toISOString(), code: "committed", release: "ota-stage-12-gabc1234" },
      ],
    });
  });

  it("drops a code or release that is not a stable code or tag instead of passing it", () => {
    const [payload] = buildEvents([{ type: "boot", at: 0, code: "/data/x y", release: "a b" }]);
    expect(payload!.events[0]).toEqual({ type: "boot", at: "1970-01-01T00:00:00.000Z" });
  });

  it("splits into batches of at most 100", () => {
    const many = Array.from({ length: 250 }, () => ({ type: "boot" as const, at: 0 }));
    expect(buildEvents(many).map((p) => p.events.length)).toEqual([100, 100, 50]);
    expect(buildEvents([])).toEqual([]);
  });
});

describe("LogAggregator", () => {
  const fact = (over: Partial<Parameters<LogAggregator["add"]>[0]> = {}) => ({
    at: 1_790_000_000_000,
    service: "orchestrator",
    level: "error" as const,
    code: "ECONNREFUSED",
    msg: "connect failed",
    ...over,
  });

  it("folds repeats of (service, level, code) into one record with a count and the latest time", () => {
    const agg = new LogAggregator();
    agg.add(fact({ at: 1_790_000_000_000 }));
    agg.add(fact({ at: 1_790_000_005_000 }));
    agg.add(fact({ at: 1_790_000_009_000 }));
    agg.add(fact({ level: "warn" }));
    const [payload] = agg.drain();
    expect(payload!.records).toHaveLength(2);
    const err = payload!.records.find((r) => r.level === "error")!;
    expect(err).toMatchObject({ code: "ECONNREFUSED", count: 3, at: new Date(1_790_000_009_000).toISOString() });
    expect(LogsSchema.safeParse(payload).success).toBe(true);
  });

  it("redacts the message on the way in, so a caller cannot skip it", () => {
    const agg = new LogAggregator();
    agg.add(fact({ msg: "mail to jane.doe@acme-dental.example from 192.168.1.20 failed for /srv/files/Q3.xlsx" }));
    const wire = JSON.stringify(agg.drain());
    expect(wire).not.toMatch(/jane\.doe|192\.168|acme-dental|Q3\.xlsx|\/srv\/files/);
    expect(wire).toMatch(/\[email\]/);
  });

  it("falls back to the code when the message redacts to nothing", () => {
    const agg = new LogAggregator();
    agg.add(fact({ msg: "" }));
    expect(agg.drain()[0]!.records[0]!.msg).toBe("ECONNREFUSED");
  });

  it("replaces a code that is not a stable code, so free text never becomes one", () => {
    const agg = new LogAggregator();
    agg.add(fact({ code: "File 'Q3 budget.xlsx' missing" }));
    expect(agg.drain()[0]!.records[0]!.code).toBe("unclassified");
  });

  it("caps a drain at 500 records, keeping the most severe then the most frequent, with a log_overflow record", () => {
    const agg = new LogAggregator();
    for (let i = 0; i < 700; i++) agg.add(fact({ level: "warn", code: `w${i}` }));
    agg.add(fact({ level: "fatal", code: "boom" }));
    for (let i = 0; i < 5; i++) agg.add(fact({ level: "error", code: "frequent" }));
    const [payload] = agg.drain();
    expect(payload!.records).toHaveLength(MAX_LOG_RECORDS);
    const codes = payload!.records.map((r) => r.code);
    expect(codes[0]).toBe("boom");
    expect(codes[1]).toBe("frequent");
    const overflow = payload!.records.at(-1)!;
    expect(overflow).toMatchObject({ code: "log_overflow", level: "warn" });
    // 702 distinct keys, 499 kept, so 203 left out
    expect(overflow.count).toBe(203);
    expect(LogsSchema.safeParse(payload).success).toBe(true);
  });

  it("is empty after a drain, and drains nothing when nothing was logged", () => {
    const agg = new LogAggregator();
    expect(agg.drain()).toEqual([]);
    agg.add(fact());
    expect(agg.drain()).toHaveLength(1);
    expect(agg.drain()).toEqual([]);
  });

  it("counts error and fatal records by class per window, never warnings", () => {
    const agg = new LogAggregator();
    agg.add(fact({ level: "error", code: "A" }));
    agg.add(fact({ level: "error", code: "A" }));
    agg.add(fact({ level: "fatal", code: "B" }));
    agg.add(fact({ level: "warn", code: "C" }));
    expect(agg.takeErrorClasses()).toEqual({ A: 2, B: 1 });
    expect(agg.takeErrorClasses()).toEqual({});
  });

  it("bounds its memory: past 1000 distinct keys new ones are counted, not stored", () => {
    const agg = new LogAggregator();
    for (let i = 0; i < 1_200; i++) agg.add(fact({ level: "warn", code: `k${i}` }));
    const [payload] = agg.drain();
    expect(payload!.records).toHaveLength(MAX_LOG_RECORDS);
    const overflow = payload!.records.at(-1)!;
    // 1000 stored + 200 dropped keys; 499 kept -> 501 stored left out + 200 dropped
    expect(overflow.count).toBe(701);
  });
});
