/**
 * WARP-3504 (ADR-068) — the box telemetry sender: authenticated operational
 * health, events and redacted logs to the operator portal, every enrolled box,
 * always on. Why it lives in the orchestrator and not in `services/fleet-agent`:
 * the orchestrator already owns every input (the HQ device-token client, the
 * Docker socket the OTA agent uses, the update agent's state changes, its own
 * logs and the COUNT queries behind the activity numbers), and a Python sidecar
 * would need a second copy of each plus a gRPC and Docker-socket mount of its
 * own. This supersedes the fleet-agent's double-gated telemetry profile for an
 * enrolled box; that agent is left untouched.
 *
 * ONE cycle does the work, run serialised from two schedules (cron-runtime):
 *   every 60 s   watch containers (crash / recovered events), then stage and
 *                flush pending events and log records
 *   every 5 min  the same, plus a `heartbeat.v1`
 * A cycle is: get a token (HQ) -> build -> validate -> spool -> POST oldest first.
 *
 * Token handling (HqTokenError reasons from WARP-3503):
 *   not_enrolled | revoked   IDLE. Nothing is built or sent, HQ is asked again
 *                            every 5 minutes, one info line per hour. A
 *                            `token.refused` event is queued once and goes out
 *                            if the box is ever enrolled.
 *   bad_signature            one `token.refused`, then backoff and buffering.
 *   unreachable              backoff and buffering (the outage case).
 * Portal answers: 2xx delivered; 401/403 one forced token refresh, then
 * backoff; 429/5xx/408/network backoff (honouring Retry-After); any other 4xx
 * means THAT body is malformed, so it is dropped and counted, never retried.
 *
 * It never logs a payload, a token or a response body: only counts, kinds and
 * short codes, under a logger name the log tap ignores (log-tap.ts), so a
 * failing send cannot become a log record that is sent.
 */
import { createLogger } from "../../lib/logger.js";
import { TELEMETRY_LOGGER_NAME, type TappedLog } from "../../lib/log-tap.js";
import type { RecordParams } from "../activity.service.js";
import type { HqTokenService } from "../hq-token.service.js";
import { HqTokenError } from "../hq-token.service.js";
import type { CheckForUpdateResult } from "../update-agent/poller.js";
import {
  NEVER_SENT,
  RETENTION,
  SCHEMA_DOCS,
  SERVICE_NAME_RE,
  TELEMETRY_PATH,
  otaEvent,
  serializePayload,
  type TelemetryKind,
  type TelemetryLast,
  type TelemetryLinkState,
} from "./contract.js";
import {
  LogAggregator,
  buildEvents,
  buildHeartbeat,
  type EventFact,
  type HeartbeatFacts,
} from "./builders.js";
import type { ContainerFact, HeartbeatWindow } from "./sources.js";
import type { SpoolEntry, TelemetryStore } from "./spool.js";

export const HEARTBEAT_INTERVAL_MS = 300_000;
export const WATCH_INTERVAL_MS = 60_000;

const DISK_LOW_PCT = 90;
const DISK_REARM_PCT = 85;
const CRASH_COOLDOWN_MS = 300_000;
const MAX_SENDS_PER_FLUSH = 20;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 1_800_000;
const IDLE_RETRY_MS = 300_000;
const IDLE_LOG_EVERY_MS = 3_600_000;
const EVENT_QUEUE_MAX = 500;
const POST_TIMEOUT_MS = 15_000;
/** Asking the token cache for longer than any token lives forces a fresh mint. */
const FORCE_REFRESH_MS = 24 * 3_600_000;

export interface SenderDeps {
  hqTokens: Pick<HqTokenService, "getToken">;
  /** The portal origin, no trailing slash and no `/api/v1`. */
  portalBase: string;
  store: TelemetryStore;
  collectors: {
    containers(): Promise<ContainerFact[] | null>;
    heartbeat(window: HeartbeatWindow): Promise<HeartbeatFacts>;
  };
  record: (params: RecordParams) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Pick<ReturnType<typeof createLogger>, "info" | "warn" | "debug">;
}

export interface BoxTelemetry {
  snapshot(): TelemetryLast;
  /** Boot event; call once after wiring. */
  start(): void;
  heartbeatTick(): Promise<void>;
  watchTick(): Promise<void>;
  dailyTick(): Promise<void>;
  recordLog(record: TappedLog): void;
  recordOtaCheck(result: CheckForUpdateResult): void;
  recordUpdateTransition(t: { to: string; failureReason: string | null; releaseTag: string | null }): void;
}

type PostResult =
  | { kind: "ok" }
  | { kind: "unauthorized" }
  | { kind: "retry"; code: string; retryAfterMs?: number }
  | { kind: "reject"; code: string };

function retryAfterMs(header: string | null): number | undefined {
  const secs = Number(header);
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, 3_600_000) : undefined;
}

export function createBoxTelemetry(deps: SenderDeps): BoxTelemetry {
  const { store } = deps;
  const clock = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? createLogger(TELEMETRY_LOGGER_NAME);
  const portalHost = (() => {
    try {
      return new URL(deps.portalBase).host;
    } catch {
      return null;
    }
  })();

  let link: TelemetryLinkState = "starting";
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastErrorCode: string | null = null;
  let backoffUntil = 0;
  let failures = 0;
  let lastIdleLogAt = 0;
  let refusedCode: string | null = null;
  let otaChecks = 0;
  let otaVerifyFailures = 0;
  let diskLowArmed = true;

  const events: EventFact[] = [];
  const logs = new LogAggregator();
  const seen = new Map<string, { state: string; restarts: number }>();
  const crashed = new Set<string>();
  const lastCrashAt = new Map<string, number>();

  let chain: Promise<void> = Promise.resolve();
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const isIdle = () => link === "not_enrolled" || link === "revoked";

  function pushEvent(e: EventFact): void {
    events.push(e);
    if (events.length > EVENT_QUEUE_MAX) events.shift();
  }

  // ── tokens ───────────────────────────────────────────────────────────────

  function refused(code: string, at: number): void {
    if (refusedCode === code) return;
    refusedCode = code;
    pushEvent({ type: "token.refused", at, code });
    store.bump("refused");
  }

  function backoff(code: string, at: number, retryAfter?: number): void {
    failures += 1;
    const wait = retryAfter ?? Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    backoffUntil = at + wait;
    link = "retrying";
    lastErrorCode = code;
    if (failures === 1) log.warn({ code }, "telemetry delivery is failing; buffering and backing off");
  }

  function onTokenError(err: unknown, at: number): void {
    const reason = err instanceof HqTokenError ? err.reason : "unreachable";
    if (reason === "not_enrolled" || reason === "revoked") {
      link = reason;
      lastErrorCode = reason;
      backoffUntil = at + IDLE_RETRY_MS;
      refused(reason, at);
      if (at - lastIdleLogAt >= IDLE_LOG_EVERY_MS) {
        lastIdleLogAt = at;
        log.info({ reason }, "telemetry idle: Warp HQ issues this box no token");
      }
      return;
    }
    if (reason === "bad_signature") refused(reason, at);
    backoff(reason === "unreachable" ? "hq_unreachable" : reason, at);
  }

  /** A token, or null (idle, or in backoff). Sets the link state on failure. */
  async function tryToken(opts?: { force?: boolean }): Promise<string | null> {
    const at = clock();
    if (!opts?.force && at < backoffUntil) return null;
    try {
      const { token } = await deps.hqTokens.getToken(
        ["telemetry:ingest"],
        opts?.force ? { minRemainingMs: FORCE_REFRESH_MS } : undefined,
      );
      refusedCode = null;
      if (isIdle()) link = "starting"; // enrolled now: leave the idle state
      return token;
    } catch (err) {
      onTokenError(err, at);
      return null;
    }
  }

  // ── building ─────────────────────────────────────────────────────────────

  async function stageHeartbeat(): Promise<void> {
    const now = new Date(clock());
    let facts: HeartbeatFacts;
    try {
      facts = await deps.collectors.heartbeat({
        now,
        windowSec: HEARTBEAT_INTERVAL_MS / 1000,
        otaChecks,
        otaVerifyFailures,
      });
    } catch (err) {
      log.warn({ code: (err as NodeJS.ErrnoException)?.code ?? "collect_failed" }, "heartbeat facts could not be collected");
      return;
    }
    otaChecks = 0;
    otaVerifyFailures = 0;
    let body: string;
    try {
      const payload = buildHeartbeat({
        ...facts,
        activity: { ...facts.activity, errorsByClass: logs.takeErrorClasses() },
      });
      body = serializePayload("heartbeat", payload);
    } catch {
      log.warn({ code: "heartbeat_invalid" }, "heartbeat failed validation and was not queued");
      return;
    }
    store.enqueue("heartbeat", body);
    if (facts.usage.diskPct >= DISK_LOW_PCT && diskLowArmed) {
      diskLowArmed = false;
      pushEvent({ type: "disk.low", at: now.getTime(), code: "disk_ge_90" });
    } else if (facts.usage.diskPct < DISK_REARM_PCT) {
      diskLowArmed = true;
    }
  }

  function stagePending(): void {
    try {
      for (const payload of buildEvents(events.splice(0))) store.enqueue("events", serializePayload("events", payload));
      for (const payload of logs.drain()) store.enqueue("logs", serializePayload("logs", payload));
    } catch {
      log.warn({ code: "stage_invalid" }, "pending events or logs failed validation and were dropped");
    }
  }

  async function watchContainers(): Promise<void> {
    const list = await deps.collectors.containers();
    if (!list) return;
    const at = clock();
    const now = new Set(list.map((c) => c.name));
    for (const name of seen.keys()) if (!now.has(name)) seen.delete(name);
    for (const c of list) {
      const before = seen.get(c.name);
      seen.set(c.name, { state: c.state, restarts: c.restarts });
      if (!before) continue; // first sight is the baseline, not an event
      const stopped =
        before.state === "running" &&
        (c.state === "restarting" || c.state === "dead" || (c.state === "exited" && c.exitCode !== 0));
      // A restart the policy did after a crash we already reported is the same episode.
      if (stopped || (c.restarts > before.restarts && !crashed.has(c.name))) {
        if (at - (lastCrashAt.get(c.name) ?? 0) >= CRASH_COOLDOWN_MS) {
          lastCrashAt.set(c.name, at);
          crashed.add(c.name);
          const reason = stopped
            ? c.state === "exited"
              ? `exit_${c.exitCode ?? "unknown"}`
              : c.state
            : "restarted";
          pushEvent({ type: "service.crash", at, code: eventCode(c.name, reason) });
        }
      } else if (crashed.has(c.name) && c.state === "running" && c.health !== "unhealthy" && c.health !== "starting") {
        crashed.delete(c.name);
        pushEvent({ type: "service.recovered", at, code: eventCode(c.name, "running") });
      }
    }
  }

  // Events carry no service field in the contract, so the service rides in `code`.
  function eventCode(service: string, reason: string): string {
    const code = `${service}:${reason}`;
    return SERVICE_NAME_RE.test(service) && code.length <= 64 ? code : reason;
  }

  // ── sending ──────────────────────────────────────────────────────────────

  async function post(entry: SpoolEntry, token: string): Promise<PostResult> {
    let res: Response;
    try {
      res = await doFetch(`${deps.portalBase}${TELEMETRY_PATH[entry.kind]}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: entry.body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch {
      return { kind: "retry", code: "portal_unreachable" };
    }
    void res.body?.cancel().catch(() => undefined);
    if (res.ok) return { kind: "ok" };
    if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { kind: "retry", code: `portal_${res.status}`, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
    }
    return { kind: "reject", code: `portal_${res.status}` };
  }

  function unitsOf(kind: TelemetryKind, body: string): number {
    if (kind === "heartbeat") return 1;
    const parsed = JSON.parse(body) as { events?: unknown[]; records?: unknown[] };
    return (kind === "events" ? parsed.events : parsed.records)?.length ?? 0;
  }

  async function flush(first: string | null): Promise<void> {
    let token = first;
    if (token === null || !store.peek()) return;
    lastAttemptAt = clock();
    let refreshed = false;
    for (let sent = 0; sent < MAX_SENDS_PER_FLUSH; ) {
      const entry = store.peek();
      if (!entry) break;
      let body: string;
      try {
        // The buffer file is not trusted: validate again before it leaves.
        body = serializePayload(entry.kind, JSON.parse(entry.body));
      } catch {
        store.shift();
        store.bump("rejected");
        log.warn({ kind: entry.kind, code: "spooled_invalid" }, "a buffered payload failed validation and was dropped");
        continue;
      }
      const result = await post({ ...entry, body }, token);
      if (result.kind === "ok") {
        store.shift();
        store.recordSent(entry.kind, body, unitsOf(entry.kind, body));
        lastSuccessAt = clock();
        sent += 1;
        continue;
      }
      if (result.kind === "reject") {
        store.shift();
        store.bump("rejected");
        log.warn({ kind: entry.kind, code: result.code }, "the portal refused a payload as malformed; dropped");
        continue;
      }
      if (result.kind === "unauthorized" && !refreshed) {
        refreshed = true;
        const fresh = await tryToken({ force: true });
        if (fresh === null) return;
        token = fresh;
        continue;
      }
      backoff(result.kind === "retry" ? result.code : "portal_unauthorized", clock(), result.kind === "retry" ? result.retryAfterMs : undefined);
      return;
    }
    if (failures > 0) log.info({ failures }, "telemetry delivery recovered");
    failures = 0;
    backoffUntil = 0;
    lastErrorCode = null;
    link = "ok";
  }

  async function cycle(withHeartbeat: boolean): Promise<void> {
    await watchContainers().catch(() => undefined);
    const token = await tryToken();
    if (isIdle()) return; // not enrolled / revoked: build and send nothing
    if (withHeartbeat) await stageHeartbeat();
    stagePending();
    await flush(token);
    await store.persist();
  }

  // ── what the owner sees ─────────────────────────────────────────────────

  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

  function sentRecord(kind: TelemetryKind) {
    const row = store.last(kind);
    if (!row) return null;
    try {
      return { sentAt: row.at, payload: JSON.parse(row.body) as unknown };
    } catch {
      return null;
    }
  }

  return {
    snapshot: () => ({
      state: link,
      portalHost,
      heartbeatIntervalSec: HEARTBEAT_INTERVAL_MS / 1000,
      lastAttemptAt: iso(lastAttemptAt),
      lastSuccessAt: iso(lastSuccessAt),
      lastErrorCode,
      queued: {
        heartbeat: store.count("heartbeat"),
        events: store.count("events"),
        logs: store.count("logs"),
      },
      dropped: store.droppedTotal,
      last: { heartbeat: sentRecord("heartbeat"), events: sentRecord("events"), logs: sentRecord("logs") },
      schemas: SCHEMA_DOCS,
      neverSent: NEVER_SENT,
      retention: RETENTION,
    }),

    start() {
      pushEvent({ type: "boot", at: clock() });
    },

    heartbeatTick: () => serialize(() => cycle(true)),
    watchTick: () => serialize(() => cycle(false)),

    async dailyTick() {
      const s = store.takeStats();
      await store.persist();
      const kb = Math.round(s.bytes / 1024);
      const attention = isIdle() || s.refused + s.rejected + s.dropped > 0;
      await deps.record({
        kind: "system",
        severity: attention ? "warn" : "info",
        sourceIcon: "radio",
        what: "Sent operational health data to Warp",
        sub: isIdle()
          ? "Nothing sent: Warp is not issuing this Droplet an access token. No customer data."
          : `${s.heartbeats} health snapshots, ${s.events} events and ${s.logRecords} log records sent (${kb} KB). No customer data.`,
        refs: { ...s, state: link },
        actor: { type: "system" },
      });
    },

    recordLog(r) {
      logs.add({ at: r.at, service: "orchestrator", level: r.level, code: r.code, msg: r.msg });
    },

    recordOtaCheck(result) {
      otaChecks += 1;
      if (result.outcome === "verify_failed") {
        otaVerifyFailures += 1;
        pushEvent({ type: otaEvent("failed"), at: clock(), code: result.failureReason });
      } else if (result.outcome === "pending_created") {
        pushEvent({ type: otaEvent("download"), at: clock(), code: "release_found" });
      }
    },

    recordUpdateTransition({ to, failureReason, releaseTag }) {
      const at = clock();
      if (to === "committed") pushEvent({ type: otaEvent("apply"), at, code: "committed", release: releaseTag });
      else if (to === "rolled_back") pushEvent({ type: otaEvent("rollback"), at, code: failureReason ?? "rolled_back", release: releaseTag });
      else if (to === "failed" || to === "rejected") pushEvent({ type: otaEvent("failed"), at, code: failureReason ?? to, release: releaseTag });
    },
  };
}

/** The sender's visible state when it is not running at all. */
export function inertBoxTelemetry(state: Extract<TelemetryLinkState, "disabled" | "unconfigured">): BoxTelemetry {
  const none = { heartbeat: null, events: null, logs: null };
  const noop = () => undefined;
  return {
    snapshot: () => ({
      state,
      portalHost: null,
      heartbeatIntervalSec: HEARTBEAT_INTERVAL_MS / 1000,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      queued: { heartbeat: 0, events: 0, logs: 0 },
      dropped: 0,
      last: none,
      schemas: SCHEMA_DOCS,
      neverSent: NEVER_SENT,
      retention: RETENTION,
    }),
    start: noop,
    heartbeatTick: async () => undefined,
    watchTick: async () => undefined,
    dailyTick: async () => undefined,
    recordLog: noop,
    recordOtaCheck: noop,
    recordUpdateTransition: noop,
  };
}

