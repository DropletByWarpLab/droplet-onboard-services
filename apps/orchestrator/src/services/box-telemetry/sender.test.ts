/**
 * WARP-3504 (ADR-068) — the box telemetry sender, end to end with the HQ token
 * client, the portal, the collectors, the Docker view and the clock all
 * injected: token handling (idle while not enrolled, backoff while HQ or the
 * portal is down, one forced refresh on 401), the bounded buffer's oldest-first
 * delivery, a malformed body dropped instead of retried, events from container
 * transitions and OTA steps, the log fold, the daily row, and that no token or
 * payload ever reaches a log line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecordParams } from "../activity.service.js";
import { HqTokenError } from "../hq-token.service.js";
import { HeartbeatSchema } from "./contract.js";
import type { HeartbeatFacts } from "./builders.js";
import { createBoxTelemetry, inertBoxTelemetry } from "./sender.js";
import type { ContainerFact, HeartbeatWindow } from "./sources.js";
import { TelemetryStore } from "./spool.js";
import { sampleFacts } from "./__fixtures__/samples.js";

const T0 = 1_790_000_000_000;
const HEARTBEAT_URL = "https://portal.test/api/v1/telemetry/heartbeat";
const EVENTS_URL = "https://portal.test/api/v1/telemetry/events";
const LOGS_URL = "https://portal.test/api/v1/telemetry/logs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "box-telemetry-sender-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ok = () => new Response(null, { status: 200 });
const status = (code: number, headers?: Record<string, string>) => () => new Response(null, { status: code, headers });

function harness() {
  let t = T0;
  const now = () => t;
  const store = new TelemetryStore(path.join(dir, "state.json"), now);
  const getToken = vi.fn(async (_scopes: readonly string[], _opts?: { minRemainingMs?: number }) => ({
    token: "TOKEN-SECRET-1",
    expiresAt: t + 600_000,
  }));
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => ok());
  const records: RecordParams[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const containers = vi.fn(async (): Promise<ContainerFact[] | null> => []);
  const facts: { override: Partial<HeartbeatFacts> } = { override: {} };
  const heartbeat = vi.fn(async (w: HeartbeatWindow): Promise<HeartbeatFacts> => ({
    ...sampleFacts({ now: w.now }),
    ...facts.override,
  }));
  const tel = createBoxTelemetry({
    hqTokens: { getToken },
    portalBase: "https://portal.test",
    store,
    collectors: { containers, heartbeat },
    record: async (p) => {
      records.push(p);
    },
    fetch: fetchMock as unknown as typeof fetch,
    now,
    log: log as never,
  });
  const calls = () => fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
  const bodiesTo = (url: string) => calls().filter(([u]) => u === url).map(([, init]) => JSON.parse(init.body as string));
  const sentEvents = () => bodiesTo(EVENTS_URL).flatMap((b) => b.events as Array<{ type: string; code?: string; release?: string }>);
  return {
    tel,
    store,
    getToken,
    fetchMock,
    records,
    log,
    containers,
    heartbeat,
    facts,
    calls,
    bodiesTo,
    sentEvents,
    advance: (ms: number) => {
      t += ms;
    },
    clock: () => t,
  };
}

const container = (over: Partial<ContainerFact> = {}): ContainerFact => ({
  name: "ai-gateway",
  state: "running",
  health: "healthy",
  restarts: 0,
  exitCode: null,
  ...over,
});

describe("a healthy box", () => {
  it("sends the heartbeat and the boot event with the HQ token, oldest first, to the portal's endpoints", async () => {
    const h = harness();
    h.tel.start();
    await h.tel.heartbeatTick();

    expect(h.getToken).toHaveBeenCalledWith(["telemetry:ingest"], undefined);
    expect(h.calls().map(([u]) => u)).toEqual([HEARTBEAT_URL, EVENTS_URL]);
    for (const [, init] of h.calls()) {
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer TOKEN-SECRET-1" });
    }
    expect(HeartbeatSchema.safeParse(h.bodiesTo(HEARTBEAT_URL)[0]).success).toBe(true);
    expect(h.bodiesTo(EVENTS_URL)[0]).toEqual({
      schema: "events.v1",
      events: [{ type: "boot", at: new Date(T0).toISOString() }],
    });
    expect(h.tel.snapshot()).toMatchObject({ state: "ok", lastErrorCode: null, queued: { heartbeat: 0, events: 0, logs: 0 } });
  });

  it("asks the collector for the 5-minute window, with the OTA counts it has seen", async () => {
    const h = harness();
    h.tel.recordOtaCheck({ outcome: "no_release" });
    h.tel.recordOtaCheck({ outcome: "already_known", gitSha: "a".repeat(40) });
    h.tel.recordOtaCheck({ outcome: "verify_failed", failureReason: "signature_failed", detail: "d" } as never);
    await h.tel.heartbeatTick();
    expect(h.heartbeat).toHaveBeenLastCalledWith({
      now: new Date(T0),
      windowSec: 300,
      otaChecks: 3,
      otaVerifyFailures: 1,
    });
    // A new window starts after a heartbeat was built.
    h.advance(300_000);
    await h.tel.heartbeatTick();
    expect(h.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ otaChecks: 0, otaVerifyFailures: 0 }));
  });

  it("a watch tick sends only what is pending, and nothing at all when nothing is", async () => {
    const h = harness();
    await h.tel.watchTick();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.heartbeat).not.toHaveBeenCalled();
    h.tel.recordLog({ at: T0, level: "error", logger: "x", code: "ECONNREFUSED", msg: "connect failed" });
    await h.tel.watchTick();
    expect(h.calls().map(([u]) => u)).toEqual([LOGS_URL]);
  });

  it("runs two ticks one after the other, never at once", async () => {
    const h = harness();
    await Promise.all([h.tel.heartbeatTick(), h.tel.watchTick(), h.tel.heartbeatTick()]);
    expect(h.heartbeat).toHaveBeenCalledTimes(2);
    // Two heartbeats, strictly one after the other.
    const sent = h.bodiesTo(HEARTBEAT_URL).map((b) => b.sentAt);
    expect(sent).toHaveLength(2);
  });
});

describe("a box HQ will not issue a token to", () => {
  it.each(["not_enrolled", "revoked"] as const)("%s: idle. Nothing is built or sent, HQ is asked every 5 minutes, one log line an hour", async (reason) => {
    const h = harness();
    h.getToken.mockRejectedValue(new HqTokenError(reason, "/v1/device/token"));
    h.tel.start();
    h.tel.recordLog({ at: T0, level: "error", logger: "x", code: "E1", msg: "m" });

    await h.tel.heartbeatTick();
    expect(h.tel.snapshot().state).toBe(reason);
    expect(h.heartbeat).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.store.count("events")).toBe(0);
    expect(h.store.count("logs")).toBe(0);
    expect(h.log.info).toHaveBeenCalledTimes(1);

    // A minute later HQ is not asked again.
    h.advance(60_000);
    await h.tel.watchTick();
    expect(h.getToken).toHaveBeenCalledTimes(1);

    // After 5 minutes it is, and still no second log line within the hour.
    h.advance(240_001);
    await h.tel.heartbeatTick();
    expect(h.getToken).toHaveBeenCalledTimes(2);
    expect(h.log.info).toHaveBeenCalledTimes(1);

    // An hour on: one more line.
    h.advance(3_600_000);
    await h.tel.heartbeatTick();
    expect(h.log.info).toHaveBeenCalledTimes(2);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("is delivered, with a token.refused event for the refusal, once the box is enrolled", async () => {
    const h = harness();
    h.getToken.mockRejectedValue(new HqTokenError("not_enrolled", "/v1/device/token"));
    h.tel.start();
    await h.tel.heartbeatTick();
    h.advance(60_000);
    await h.tel.watchTick();

    h.getToken.mockResolvedValue({ token: "TOKEN-SECRET-1", expiresAt: h.clock() + 600_000 });
    h.advance(300_000);
    await h.tel.heartbeatTick();

    expect(h.tel.snapshot().state).toBe("ok");
    expect(h.heartbeat).toHaveBeenCalledTimes(1);
    expect(h.sentEvents().map((e) => [e.type, e.code])).toEqual([
      ["boot", undefined],
      ["token.refused", "not_enrolled"],
    ]);
  });

  it("reports an HQ signature refusal once, then backs off and keeps buffering", async () => {
    const h = harness();
    h.getToken.mockRejectedValue(new HqTokenError("bad_signature", "/v1/device/token"));
    await h.tel.heartbeatTick();
    h.advance(61_000);
    await h.tel.heartbeatTick();
    expect(h.tel.snapshot()).toMatchObject({ state: "retrying", lastErrorCode: "bad_signature" });
    expect(h.store.count("heartbeat")).toBe(2);
    h.getToken.mockResolvedValue({ token: "TOKEN-SECRET-1", expiresAt: h.clock() + 600_000 });
    h.advance(200_000);
    await h.tel.watchTick();
    expect(h.sentEvents().filter((e) => e.type === "token.refused")).toEqual([
      expect.objectContaining({ code: "bad_signature" }),
    ]);
  });
});

describe("HQ or the portal being down", () => {
  it("HQ unreachable: buffers, backs off, then delivers everything oldest first", async () => {
    const h = harness();
    h.getToken.mockRejectedValueOnce(new HqTokenError("unreachable", "network"));
    h.tel.start();
    await h.tel.heartbeatTick();
    expect(h.tel.snapshot()).toMatchObject({ state: "retrying", lastErrorCode: "hq_unreachable" });
    expect(h.tel.snapshot().queued).toEqual({ heartbeat: 1, events: 1, logs: 0 });
    expect(h.fetchMock).not.toHaveBeenCalled();

    h.advance(61_000);
    await h.tel.heartbeatTick();

    const heartbeats = h.bodiesTo(HEARTBEAT_URL).map((b) => b.sentAt);
    expect(heartbeats).toEqual([new Date(T0).toISOString(), new Date(T0 + 61_000).toISOString()]);
    expect(h.tel.snapshot()).toMatchObject({ state: "ok", queued: { heartbeat: 0, events: 0, logs: 0 } });
    expect(h.log.info).toHaveBeenCalledWith(expect.objectContaining({ failures: 1 }), expect.stringContaining("recovered"));
  });

  it("portal 5xx: keeps the body, waits out a 60 s backoff, then delivers", async () => {
    const h = harness();
    h.fetchMock.mockImplementationOnce(async () => status(503)());
    h.tel.start();
    await h.tel.heartbeatTick();
    expect(h.tel.snapshot()).toMatchObject({ state: "retrying", lastErrorCode: "portal_503" });
    expect(h.tel.snapshot().queued).toEqual({ heartbeat: 1, events: 1, logs: 0 });
    expect(h.fetchMock).toHaveBeenCalledTimes(1);

    h.advance(30_000);
    await h.tel.watchTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);

    h.advance(31_000);
    await h.tel.watchTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(h.tel.snapshot()).toMatchObject({ state: "ok", lastErrorCode: null, queued: { heartbeat: 0, events: 0, logs: 0 } });
  });

  it("portal 429: honours Retry-After", async () => {
    const h = harness();
    h.fetchMock.mockImplementationOnce(async () => status(429, { "retry-after": "120" })());
    h.tel.start();
    await h.tel.heartbeatTick();
    expect(h.tel.snapshot().lastErrorCode).toBe("portal_429");
    h.advance(61_000);
    await h.tel.watchTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    h.advance(60_000);
    await h.tel.watchTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("backs off 60 s, then 120 s, on consecutive failures", async () => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => status(500)());
    h.tel.start();
    await h.tel.heartbeatTick(); // failure 1 -> wait 60 s
    h.advance(61_000);
    await h.tel.watchTick(); // failure 2 -> wait 120 s
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    h.advance(100_000);
    await h.tel.watchTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    h.advance(21_000);
    await h.tel.watchTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a network error is a retry, not a loss", async () => {
    const h = harness();
    h.fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await h.tel.heartbeatTick();
    expect(h.tel.snapshot()).toMatchObject({ state: "retrying", lastErrorCode: "portal_unreachable" });
    expect(h.store.count("heartbeat")).toBe(1);
  });

  it("a 4xx other than auth means that body is malformed: dropped and counted, the rest still goes", async () => {
    const h = harness();
    h.fetchMock.mockImplementationOnce(async () => status(400)());
    h.tel.start();
    await h.tel.heartbeatTick();
    expect(h.tel.snapshot()).toMatchObject({ state: "ok", queued: { heartbeat: 0, events: 0, logs: 0 } });
    expect(h.calls().map(([u]) => u)).toEqual([HEARTBEAT_URL, EVENTS_URL]);
    expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ kind: "heartbeat", code: "portal_400" }), expect.any(String));
    await h.tel.dailyTick();
    expect(h.records[0]!.refs).toMatchObject({ rejected: 1, heartbeats: 0, events: 1 });
  });

  it("401: one forced token refresh, then the same body goes again with the new token", async () => {
    const h = harness();
    h.getToken
      .mockResolvedValueOnce({ token: "TOKEN-1", expiresAt: T0 + 600_000 })
      .mockResolvedValueOnce({ token: "TOKEN-2", expiresAt: T0 + 600_000 });
    h.fetchMock.mockImplementationOnce(async () => status(401)());
    await h.tel.heartbeatTick();

    expect(h.getToken).toHaveBeenNthCalledWith(2, ["telemetry:ingest"], { minRemainingMs: 86_400_000 });
    expect(h.calls().map(([, init]) => (init.headers as Record<string, string>).authorization)).toEqual([
      "Bearer TOKEN-1",
      "Bearer TOKEN-2",
    ]);
    expect(h.tel.snapshot().state).toBe("ok");
  });

  it("401 again after the refresh: backs off instead of looping", async () => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => status(401)());
    await h.tel.heartbeatTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.tel.snapshot()).toMatchObject({ state: "retrying", lastErrorCode: "portal_unauthorized" });
    expect(h.store.count("heartbeat")).toBe(1);
  });

  it("sends at most 20 bodies per cycle so a backlog does not burst the portal", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) {
      h.store.enqueue(
        "events",
        JSON.stringify({ schema: "events.v1", events: [{ type: "boot", at: new Date(T0 + i).toISOString() }] }),
      );
    }
    await h.tel.watchTick();
    expect(h.fetchMock).toHaveBeenCalledTimes(20);
    expect(h.store.count("events")).toBe(10);
    h.advance(60_000);
    await h.tel.watchTick();
    expect(h.store.count("events")).toBe(0);
  });
});

describe("the buffer file is not trusted", () => {
  it("a buffered body that fails the strict schema is dropped, never sent", async () => {
    const h = harness();
    h.store.enqueue("heartbeat", JSON.stringify({ schema: "heartbeat.v1", extra: 1 }));
    h.store.enqueue(
      "events",
      JSON.stringify({ schema: "events.v1", events: [{ type: "boot", at: new Date(T0).toISOString(), prompt: "what is Jane's salary" }] }),
    );
    h.store.enqueue("logs", "not json at all");
    h.tel.recordLog({ at: T0, level: "warn", logger: "x", code: "W1", msg: "fine" });
    await h.tel.watchTick();
    expect(h.calls().map(([u]) => u)).toEqual([LOGS_URL]);
    expect(JSON.stringify(h.calls())).not.toMatch(/prompt|salary/);
    expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "spooled_invalid" }), expect.any(String));
    expect(h.tel.snapshot().queued).toEqual({ heartbeat: 0, events: 0, logs: 0 });
  });
});

describe("events", () => {
  it("a container that stops, then comes back: one service.crash and one service.recovered, the service in the code", async () => {
    const h = harness();
    h.containers.mockResolvedValueOnce([container(), container({ name: "orchestrator" })]);
    await h.tel.watchTick(); // baseline
    h.advance(60_000);
    h.containers.mockResolvedValueOnce([container({ state: "exited", health: "none", exitCode: 137 }), container({ name: "orchestrator" })]);
    await h.tel.watchTick();
    h.advance(60_000);
    h.containers.mockResolvedValueOnce([container({ restarts: 1 }), container({ name: "orchestrator" })]);
    await h.tel.watchTick();

    expect(h.sentEvents().map((e) => [e.type, e.code])).toEqual([
      ["service.crash", "ai-gateway:exit_137"],
      ["service.recovered", "ai-gateway:running"],
    ]);
  });

  it("a restart between two looks is a crash too, and its recovery follows", async () => {
    const h = harness();
    h.containers.mockResolvedValueOnce([container()]);
    await h.tel.watchTick();
    h.advance(60_000);
    h.containers.mockResolvedValueOnce([container({ restarts: 1 })]);
    await h.tel.watchTick();
    h.advance(60_000);
    h.containers.mockResolvedValueOnce([container({ restarts: 1 })]);
    await h.tel.watchTick();
    expect(h.sentEvents().map((e) => [e.type, e.code])).toEqual([
      ["service.crash", "ai-gateway:restarted"],
      ["service.recovered", "ai-gateway:running"],
    ]);
  });

  it("a clean exit (code 0) is a job finishing, not a crash; a first sight is a baseline, not an event", async () => {
    const h = harness();
    h.containers.mockResolvedValueOnce([container({ name: "init-job" }), container({ name: "seen-first-as-dead", state: "dead", health: "none" })]);
    await h.tel.watchTick();
    h.advance(60_000);
    h.containers.mockResolvedValueOnce([
      container({ name: "init-job", state: "exited", health: "none", exitCode: 0 }),
      container({ name: "seen-first-as-dead", state: "dead", health: "none" }),
    ]);
    await h.tel.watchTick();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("a service that keeps flapping reports one crash per 5 minutes, not one per look", async () => {
    const h = harness();
    h.containers.mockResolvedValueOnce([container()]);
    await h.tel.watchTick();
    for (let i = 0; i < 3; i++) {
      h.advance(30_000);
      h.containers.mockResolvedValueOnce([container({ state: "restarting", health: "none", restarts: i })]);
      await h.tel.watchTick();
      h.advance(30_000);
      h.containers.mockResolvedValueOnce([container({ restarts: i })]);
      await h.tel.watchTick();
    }
    expect(h.sentEvents().filter((e) => e.type === "service.crash")).toHaveLength(1);
  });

  it("an unreadable Docker (null) adds nothing and forgets nothing", async () => {
    const h = harness();
    h.containers.mockResolvedValueOnce([container()]);
    await h.tel.watchTick();
    h.containers.mockResolvedValueOnce(null);
    await h.tel.watchTick();
    h.containers.mockResolvedValueOnce([container({ state: "dead", health: "none" })]);
    await h.tel.watchTick();
    expect(h.sentEvents().map((e) => e.type)).toEqual(["service.crash"]);
  });

  it("disk.low fires when the disk crosses 90 % and re-arms below 85 %", async () => {
    const h = harness();
    const at = (diskPct: number) => {
      h.facts.override = { usage: { ...sampleFacts().usage, diskPct } };
    };
    for (const pct of [93, 93, 88, 80, 95]) {
      at(pct);
      await h.tel.heartbeatTick();
      h.advance(300_000);
    }
    expect(h.sentEvents().filter((e) => e.type === "disk.low")).toEqual([
      { type: "disk.low", at: new Date(T0).toISOString(), code: "disk_ge_90" },
      { type: "disk.low", at: new Date(T0 + 4 * 300_000).toISOString(), code: "disk_ge_90" },
    ]);
  });

  it("OTA: a found release, a refused release, an install, a rollback and a failure each become one event", async () => {
    const h = harness();
    h.tel.recordOtaCheck({ outcome: "pending_created", deviceUpdateId: "d1", gitSha: "a".repeat(40), supersededCount: 0 });
    h.tel.recordOtaCheck({ outcome: "verify_failed", failureReason: "signature_failed", detail: "d" } as never);
    h.tel.recordUpdateTransition({ to: "applying", failureReason: null, releaseTag: "ota-stage-12-gabc1234" });
    h.tel.recordUpdateTransition({ to: "committed", failureReason: null, releaseTag: "ota-stage-12-gabc1234" });
    h.tel.recordUpdateTransition({ to: "rolled_back", failureReason: "health_gate_failed", releaseTag: "ota-stage-13-gdef5678" });
    h.tel.recordUpdateTransition({ to: "rejected", failureReason: "image_signature_failed", releaseTag: null });
    h.tel.recordUpdateTransition({ to: "failed", failureReason: null, releaseTag: "ota-stage-13-gdef5678" });
    await h.tel.watchTick();

    expect(h.sentEvents()).toEqual([
      { type: "ota.download", at: new Date(T0).toISOString(), code: "release_found" },
      { type: "ota.failed", at: new Date(T0).toISOString(), code: "signature_failed" },
      { type: "ota.apply", at: new Date(T0).toISOString(), code: "committed", release: "ota-stage-12-gabc1234" },
      { type: "ota.rollback", at: new Date(T0).toISOString(), code: "health_gate_failed", release: "ota-stage-13-gdef5678" },
      { type: "ota.failed", at: new Date(T0).toISOString(), code: "image_signature_failed" },
      { type: "ota.failed", at: new Date(T0).toISOString(), code: "failed", release: "ota-stage-13-gdef5678" },
    ]);
  });
});

describe("logs", () => {
  it("folds repeats, masks the message, and keeps the error classes for the heartbeat", async () => {
    const h = harness();
    const log = (level: "warn" | "error", n: number) => {
      for (let i = 0; i < n; i++) {
        h.tel.recordLog({ at: T0 + i, level, logger: "x", code: level === "error" ? "ECONNREFUSED" : "W_SLOW", msg: "connect to 10.0.0.5 failed" });
      }
    };
    log("error", 3);
    log("warn", 2);
    await h.tel.watchTick();
    expect(h.bodiesTo(LOGS_URL)).toEqual([
      {
        schema: "logs.v1",
        records: [
          { at: new Date(T0 + 2).toISOString(), service: "orchestrator", level: "error", code: "ECONNREFUSED", msg: "connect to [ip] failed", count: 3 },
          { at: new Date(T0 + 1).toISOString(), service: "orchestrator", level: "warn", code: "W_SLOW", msg: "connect to [ip] failed", count: 2 },
        ],
      },
    ]);
    await h.tel.heartbeatTick();
    expect(h.bodiesTo(HEARTBEAT_URL)[0].activity.errorsByClass).toEqual({ ECONNREFUSED: 3 });
  });
});

describe("what the owner sees", () => {
  it("starts empty, then shows the last body of each kind that the portal accepted, verbatim", async () => {
    const h = harness();
    expect(h.tel.snapshot()).toMatchObject({
      state: "starting",
      portalHost: "portal.test",
      heartbeatIntervalSec: 300,
      lastAttemptAt: null,
      lastSuccessAt: null,
      queued: { heartbeat: 0, events: 0, logs: 0 },
      dropped: 0,
      last: { heartbeat: null, events: null, logs: null },
    });
    h.tel.start();
    h.tel.recordLog({ at: T0, level: "warn", logger: "x", code: "W1", msg: "slow" });
    await h.tel.heartbeatTick();

    const snap = h.tel.snapshot();
    expect(snap.last.heartbeat).toEqual({ sentAt: new Date(T0).toISOString(), payload: h.bodiesTo(HEARTBEAT_URL)[0] });
    expect(snap.last.events?.payload).toEqual(h.bodiesTo(EVENTS_URL)[0]);
    expect(snap.last.logs?.payload).toEqual(h.bodiesTo(LOGS_URL)[0]);
    expect(snap.lastSuccessAt).toBe(new Date(T0).toISOString());
    expect(snap.schemas.map((s) => s.schema)).toEqual(["heartbeat.v1", "events.v1", "logs.v1"]);
    expect(snap.neverSent.length).toBeGreaterThan(0);
    expect(snap.retention).toEqual({ rawDays: 30, dailySummaryMonths: 13 });
  });

  it("a payload that was queued but not yet accepted is not shown as sent", async () => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => status(503)());
    await h.tel.heartbeatTick();
    expect(h.tel.snapshot().last.heartbeat).toBeNull();
    expect(h.tel.snapshot().queued.heartbeat).toBe(1);
  });

  it("never carries a token", async () => {
    const h = harness();
    await h.tel.heartbeatTick();
    expect(JSON.stringify(h.tel.snapshot())).not.toContain("TOKEN-SECRET");
  });

  it("inert modes report their explicit state and do nothing", async () => {
    for (const state of ["disabled", "unconfigured"] as const) {
      const inert = inertBoxTelemetry(state);
      await inert.heartbeatTick();
      await inert.watchTick();
      await inert.dailyTick();
      expect(inert.snapshot()).toMatchObject({ state, portalHost: null, last: { heartbeat: null, events: null, logs: null } });
    }
  });
});

describe("the daily ActivityRow", () => {
  it("is one system row of counts only, then the counters start over", async () => {
    const h = harness();
    h.tel.start();
    h.tel.recordLog({ at: T0, level: "warn", logger: "x", code: "W1", msg: "jane@acme.example" });
    await h.tel.heartbeatTick();
    await h.tel.dailyTick();

    expect(h.records).toHaveLength(1);
    const row = h.records[0]!;
    expect(row).toMatchObject({
      kind: "system",
      severity: "info",
      what: "Sent operational health data to Warp",
      actor: { type: "system" },
    });
    expect(row.sub).toMatch(/^1 health snapshots, 1 events and 1 log records sent \(\d+ KB\)\. No customer data\.$/);
    expect(row.refs).toMatchObject({ heartbeats: 1, events: 1, logRecords: 1, refused: 0, rejected: 0, dropped: 0, state: "ok" });
    // Counts only: nothing of the payloads is in the row.
    expect(JSON.stringify(row)).not.toMatch(/jane|acme|ota-stage|TOKEN/);

    await h.tel.dailyTick();
    expect(h.records[1]!.refs).toMatchObject({ heartbeats: 0, events: 0, logRecords: 0 });
  });

  it("says plainly that nothing was sent when the box is not enrolled, and flags it", async () => {
    const h = harness();
    h.getToken.mockRejectedValue(new HqTokenError("revoked", "/v1/device/token"));
    await h.tel.heartbeatTick();
    await h.tel.dailyTick();
    expect(h.records[0]).toMatchObject({ severity: "warn" });
    expect(h.records[0]!.sub).toMatch(/^Nothing sent/);
  });
});

describe("what reaches a log line", () => {
  it("never a token, a payload or a response body, whatever went wrong", async () => {
    const h = harness();
    h.tel.start();
    h.tel.recordLog({ at: T0, level: "error", logger: "x", code: "E1", msg: "jane@acme.example" });
    h.fetchMock
      .mockImplementationOnce(async () => status(503)())
      .mockImplementationOnce(async () => status(400)())
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 203.0.113.9:443 with TOKEN-SECRET-1"));
    await h.tel.heartbeatTick();
    h.advance(61_000);
    await h.tel.heartbeatTick();
    h.getToken.mockRejectedValueOnce(new HqTokenError("unreachable", "boom"));
    h.advance(200_000);
    await h.tel.watchTick();

    const logged = JSON.stringify([...h.log.info.mock.calls, ...h.log.warn.mock.calls, ...h.log.debug.mock.calls]);
    expect(logged).not.toMatch(/TOKEN-SECRET|Bearer|heartbeat\.v1|events\.v1|logs\.v1|jane|acme|203\.0\.113/);
    expect(logged.length).toBeGreaterThan(2);
  });
});
