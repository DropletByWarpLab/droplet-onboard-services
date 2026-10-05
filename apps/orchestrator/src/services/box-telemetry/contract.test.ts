/**
 * WARP-3504 (ADR-068) — the closed allowlist: the zod mirrors of the three
 * `*.v1` payloads reject every key the contract does not name, at every level,
 * and pin the free-text positions to narrow shapes.
 */
import { describe, it, expect } from "vitest";
import {
  EVENT_TYPES,
  EventsSchema,
  HeartbeatSchema,
  LogsSchema,
  MAX_LOG_RECORDS,
  SCHEMA_DOCS,
  serializePayload,
} from "./contract.js";
import { buildHeartbeat } from "./builders.js";
import { sampleFacts } from "./__fixtures__/samples.js";

const heartbeat = () => JSON.parse(JSON.stringify(buildHeartbeat(sampleFacts()))) as Record<string, any>;
const events = () => ({
  schema: "events.v1",
  events: [{ type: "boot", at: "2026-10-03T12:00:00.000Z" }],
});
const logs = () => ({
  schema: "logs.v1",
  records: [
    { at: "2026-10-03T12:00:00.000Z", service: "orchestrator", level: "error", code: "ECONNREFUSED", msg: "x", count: 2 },
  ],
});

/** Keys a payload must never be able to carry, whatever their value. */
const FORBIDDEN = ["prompt", "response", "email", "fileName", "path", "hostname", "userId", "username", "ip", "mac", "camera"];

describe("the contract's own shapes validate", () => {
  it("heartbeat.v1, events.v1 and logs.v1", () => {
    expect(HeartbeatSchema.safeParse(heartbeat()).success).toBe(true);
    expect(EventsSchema.safeParse(events()).success).toBe(true);
    expect(LogsSchema.safeParse(logs()).success).toBe(true);
  });

  it("the event type list is exactly the contract's", () => {
    expect([...EVENT_TYPES]).toEqual([
      "boot",
      "shutdown",
      "service.crash",
      "service.recovered",
      "ota.check",
      "ota.download",
      "ota.apply",
      "ota.rollback",
      "ota.failed",
      "token.refused",
      "disk.low",
      "gpu.error",
    ]);
  });
});

describe("a forbidden key cannot pass validation, at any level", () => {
  const inject = (obj: Record<string, any>, where: string, key: string) => {
    const target = (where ? where.split(".") : []).reduce((o, k) => (/^\d+$/.test(k) ? o[Number(k)] : o[k]), obj as any);
    target[key] = "leak";
    return obj;
  };

  it.each(FORBIDDEN)("heartbeat.v1 rejects %s at the top and in every nested object", (key) => {
    for (const where of [
      "",
      "release",
      "os",
      "uptime",
      "services.0",
      "usage",
      "usage.gpus.0",
      "activity",
      "activity.ota",
    ]) {
      const hb = inject(heartbeat(), where, key);
      expect(HeartbeatSchema.safeParse(hb).success, `${key} at ${where || "top"}`).toBe(false);
    }
  });

  it.each(FORBIDDEN)("events.v1 rejects %s at the top and on an event", (key) => {
    expect(EventsSchema.safeParse(inject(events(), "", key)).success).toBe(false);
    expect(EventsSchema.safeParse(inject(events(), "events.0", key)).success).toBe(false);
  });

  it.each(FORBIDDEN)("logs.v1 rejects %s at the top and on a record", (key) => {
    expect(LogsSchema.safeParse(inject(logs(), "", key)).success).toBe(false);
    expect(LogsSchema.safeParse(inject(logs(), "records.0", key)).success).toBe(false);
  });

  it("serializePayload refuses a payload with an extra key instead of passing it through", () => {
    const hb = heartbeat();
    hb.userId = "u-1";
    expect(() => serializePayload("heartbeat", hb)).toThrow();
  });
});

describe("the free-text positions are pinned to narrow shapes", () => {
  it("a service name must be a compose-style name, not a path or an address", () => {
    for (const name of ["/data/files", "Camille's Mac", "10.0.0.5", "a@b.co", "UPPER", ""]) {
      const hb = heartbeat();
      hb.services[0].name = name;
      expect(HeartbeatSchema.safeParse(hb).success, name).toBe(false);
    }
  });

  it("a code, release tag and sha cannot carry free text", () => {
    const ev = events();
    ev.events[0] = { type: "boot", at: "2026-10-03T12:00:00.000Z", code: "has spaces and /paths" } as never;
    expect(EventsSchema.safeParse(ev).success).toBe(false);
    const ev2 = events();
    ev2.events[0] = { type: "boot", at: "2026-10-03T12:00:00.000Z", release: "name with space" } as never;
    expect(EventsSchema.safeParse(ev2).success).toBe(false);
    const hb = heartbeat();
    hb.release.gitSha = "not-a-sha";
    expect(HeartbeatSchema.safeParse(hb).success).toBe(false);
  });

  it("kernel and distro must be printable ASCII of bounded length", () => {
    const hb = heartbeat();
    hb.os.distro = "x".repeat(129);
    expect(HeartbeatSchema.safeParse(hb).success).toBe(false);
    const hb2 = heartbeat();
    hb2.os.kernel = "kern\nel";
    expect(HeartbeatSchema.safeParse(hb2).success).toBe(false);
  });

  it("errorsByClass keys must be stable codes, and there are at most 32 of them", () => {
    const hb = heartbeat();
    hb.activity.errorsByClass = { "someone@example.org": 1 };
    expect(HeartbeatSchema.safeParse(hb).success).toBe(false);
    const hb2 = heartbeat();
    hb2.activity.errorsByClass = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, 1]));
    expect(HeartbeatSchema.safeParse(hb2).success).toBe(false);
  });

  it("a log msg is at most 500 characters and a payload at most 500 records", () => {
    const l = logs();
    (l.records[0] as any).msg = "m".repeat(501);
    expect(LogsSchema.safeParse(l).success).toBe(false);
    const many = logs();
    many.records = Array.from({ length: MAX_LOG_RECORDS + 1 }, () => logs().records[0]!);
    expect(LogsSchema.safeParse(many).success).toBe(false);
  });

  it("an empty events or logs payload is not a payload", () => {
    expect(EventsSchema.safeParse({ schema: "events.v1", events: [] }).success).toBe(false);
    expect(LogsSchema.safeParse({ schema: "logs.v1", records: [] }).success).toBe(false);
  });
});

describe("the owner-facing schema descriptions", () => {
  it("cover all three schemas and name their endpoints", () => {
    expect(SCHEMA_DOCS.map((d) => d.schema)).toEqual(["heartbeat.v1", "events.v1", "logs.v1"]);
    expect(SCHEMA_DOCS.map((d) => d.endpoint)).toEqual([
      "/api/v1/telemetry/heartbeat",
      "/api/v1/telemetry/events",
      "/api/v1/telemetry/logs",
    ]);
    for (const d of SCHEMA_DOCS) expect(d.fields.length).toBeGreaterThan(0);
  });

  it("use business language, never the wire words for roles", () => {
    const text = JSON.stringify(SCHEMA_DOCS).toLowerCase();
    expect(text).not.toMatch(/household|family/);
  });
});
