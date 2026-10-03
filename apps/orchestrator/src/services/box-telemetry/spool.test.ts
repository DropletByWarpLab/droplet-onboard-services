/**
 * WARP-3504 (ADR-068) — the bounded on-disk buffer: oldest dropped first and
 * counted, survives a restart, tolerates a damaged or unwritable file, and
 * never writes anything but what it was handed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SPOOL_MAX_BYTES, SPOOL_MAX_ENTRIES, TelemetryStore } from "./spool.js";

let dir: string;
let file: string;
let clock = 1_790_000_000_000;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "box-telemetry-"));
  file = path.join(dir, "telemetry", "state.json");
  clock = 1_790_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TelemetryStore buffer", () => {
  it("hands bodies back oldest first and counts them per kind", () => {
    const s = new TelemetryStore(file, now);
    s.enqueue("heartbeat", '{"n":1}');
    s.enqueue("events", '{"n":2}');
    s.enqueue("heartbeat", '{"n":3}');
    expect(s.count("heartbeat")).toBe(2);
    expect(s.count("events")).toBe(1);
    expect(s.count("logs")).toBe(0);
    expect(s.peek()?.body).toBe('{"n":1}');
    s.shift();
    expect(s.peek()?.body).toBe('{"n":2}');
  });

  it("drops the OLDEST first past the entry cap, and counts what it dropped", () => {
    const s = new TelemetryStore(file, now);
    for (let i = 0; i < SPOOL_MAX_ENTRIES + 5; i++) s.enqueue("heartbeat", `{"i":${i}}`);
    expect(s.count("heartbeat")).toBe(SPOOL_MAX_ENTRIES);
    expect(s.peek()?.body).toBe('{"i":5}');
    expect(s.droppedTotal).toBe(5);
  });

  it("drops the oldest first past the byte cap", () => {
    const s = new TelemetryStore(file, now);
    // Three bodies of this size (plus the one-letter marker) just fit; a fourth does not.
    const big = "x".repeat(Math.floor(SPOOL_MAX_BYTES / 3) - 1);
    s.enqueue("logs", `A${big}`);
    s.enqueue("logs", `B${big}`);
    s.enqueue("logs", `C${big}`);
    s.enqueue("logs", `D${big}`);
    expect(s.count("logs")).toBe(3);
    expect(s.peek()?.body.startsWith("B")).toBe(true);
    expect(s.droppedTotal).toBe(1);
  });
});

describe("TelemetryStore persistence", () => {
  it("survives a restart: the waiting bodies, the last accepted body of each kind and the counters", async () => {
    const a = new TelemetryStore(file, now);
    a.enqueue("heartbeat", '{"waiting":1}');
    a.enqueue("events", '{"events":[1,2]}');
    a.recordSent("heartbeat", '{"sent":"hb"}', 1);
    a.recordSent("events", '{"sent":"ev"}', 2);
    a.recordSent("logs", '{"sent":"lg"}', 7);
    a.bump("refused");
    a.bump("rejected");
    await a.persist();

    const b = new TelemetryStore(file, now);
    await b.load();
    expect(b.count("heartbeat")).toBe(1);
    expect(b.count("events")).toBe(1);
    expect(b.last("heartbeat")?.body).toBe('{"sent":"hb"}');
    expect(b.last("events")?.body).toBe('{"sent":"ev"}');
    expect(b.last("logs")?.body).toBe('{"sent":"lg"}');
    expect(b.last("heartbeat")?.at).toBe(new Date(1_790_000_000_000).toISOString());
    expect(b.takeStats()).toMatchObject({ heartbeats: 1, events: 2, logRecords: 7, refused: 1, rejected: 1, dropped: 0 });
  });

  it("writes a private file, by rename, and nothing but state", async () => {
    const s = new TelemetryStore(file, now);
    s.enqueue("heartbeat", '{"a":1}');
    await s.persist();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => statSync(`${file}.tmp`)).toThrow();
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["lastSent", "spool", "stats", "v"]);
  });

  it("writes nothing when nothing changed", async () => {
    const s = new TelemetryStore(file, now);
    await s.persist();
    expect(() => statSync(file)).toThrow();
  });

  it("starts empty from a missing or damaged file, with a warning for a damaged one", async () => {
    const warnings: string[] = [];
    const missing = new TelemetryStore(file, now, (m) => warnings.push(m));
    await missing.load();
    expect(missing.peek()).toBeUndefined();
    expect(warnings).toEqual([]);

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    const damaged = new TelemetryStore(file, now, (m) => warnings.push(m));
    await damaged.load();
    expect(damaged.peek()).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("drops malformed spool rows instead of trusting the file", async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        spool: [
          { kind: "heartbeat", body: '{"ok":1}', queuedAt: 1 },
          { kind: "nonsense", body: "{}", queuedAt: 2 },
          { kind: "events", body: 5, queuedAt: 3 },
          null,
        ],
        lastSent: { heartbeat: { at: 1, body: "{}" } },
        stats: { since: "2026-10-01T00:00:00.000Z", heartbeats: 4 },
      }),
    );
    const s = new TelemetryStore(file, now);
    await s.load();
    expect(s.count("heartbeat")).toBe(1);
    expect(s.count("events")).toBe(0);
    expect(s.last("heartbeat")).toBeNull();
    expect(s.takeStats()).toMatchObject({ since: "2026-10-01T00:00:00.000Z", heartbeats: 4 });
  });

  it("degrades to memory only, with ONE warning, when the directory cannot be written", async () => {
    const warnings: string[] = [];
    // A file where the directory should be: mkdir fails.
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "x");
    const s = new TelemetryStore(path.join(blocked, "state.json"), now, (m) => warnings.push(m));
    s.enqueue("heartbeat", '{"a":1}');
    await s.persist();
    await s.persist();
    expect(warnings).toHaveLength(1);
    expect(s.count("heartbeat")).toBe(1);
  });

  it("takeStats starts the next period", () => {
    const s = new TelemetryStore(file, now);
    s.recordSent("heartbeat", "{}", 1);
    clock += 86_400_000;
    expect(s.takeStats().heartbeats).toBe(1);
    expect(s.takeStats()).toMatchObject({ heartbeats: 0, since: new Date(clock).toISOString() });
  });
});
