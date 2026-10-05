/**
 * WARP-3504 (ADR-068) — the payload builders. Pure functions.
 *
 * Each builder takes typed FACTS (numbers, enums, short identifiers; never an
 * object of unknown shape), copies them field by field into the contract
 * shape, and ends in the strict zod parse from contract.ts. There is no
 * spread, no pass-through and no `Record<string, unknown>` anywhere on the way
 * from a fact to the wire, so a field the contract does not name cannot be
 * sent, and a value that breaks its field's shape (a path in `code`, a free
 * string in `release.tag`) fails the parse and the payload is not produced.
 * Log messages are redacted HERE, so no caller can skip it.
 */
import {
  EventsSchema,
  HeartbeatSchema,
  LogsSchema,
  MAX_ERROR_CLASSES,
  MAX_EVENTS_PER_POST,
  MAX_LOG_RECORDS,
  STABLE_CODE_RE,
  type EventType,
  type EventsPayload,
  type Heartbeat,
  type LogLevel,
  type LogRecord,
  type LogsPayload,
  type ServiceHealth,
  type ServiceState,
} from "./contract.js";
import { redactMessage } from "./redact.js";

const finite = (n: number, what: string): number => {
  if (!Number.isFinite(n)) throw new RangeError(`telemetry fact ${what} is not a finite number`);
  return n;
};
const whole = (n: number, what: string): number => Math.max(0, Math.round(finite(n, what)));
const pct = (n: number, what: string): number => Math.min(100, whole(n, what));

/** A stable code, or `fallback` when the candidate is not one. */
export function toCode(candidate: string, fallback = "unclassified"): string {
  return STABLE_CODE_RE.test(candidate) ? candidate : fallback;
}

export interface HeartbeatFacts {
  now: Date;
  /** Null fields mean "this box has no OTA release": reported as the factory image. */
  release: { tag: string | null; gitSha: string | null; channel: "stage" | "stable" };
  os: { kernel: string; distro: string };
  bootedAt: Date;
  uptimeSec: number;
  services: ReadonlyArray<{ name: string; state: ServiceState; health: ServiceHealth; restarts: number }>;
  usage: {
    cpuPct: number;
    memPct: number;
    diskPct: number;
    netRxBytes: number;
    netTxBytes: number;
    gpus: ReadonlyArray<{ utilPct: number; vramUsedMb: number; vramTotalMb: number; tempC: number }>;
  };
  activity: {
    windowSec: number;
    chatTurns: number;
    agentRuns: number;
    activeUsers: number;
    ota: { checks: number; downloads: number; applies: number; rollbacks: number; failures: number };
    errorsByClass: Readonly<Record<string, number>>;
  };
}

/** The most frequent classes; the rest are summed into `other` so the key set stays bounded. */
export function foldErrorClasses(
  counts: Readonly<Record<string, number>>,
  max = MAX_ERROR_CLASSES - 1,
): Record<string, number> {
  const ranked = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => [toCode(k), whole(n, "errorsByClass")] as const)
    .sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  let rest = 0;
  ranked.forEach(([k, n], i) => {
    if (i < max) out[k] = (out[k] ?? 0) + n;
    else rest += n;
  });
  if (rest > 0) out.other = (out.other ?? 0) + rest;
  return out;
}

/** `heartbeat.v1`. Throws RangeError (non-finite fact) or ZodError (shape). */
export function buildHeartbeat(f: HeartbeatFacts): Heartbeat {
  const { usage: u, activity: a } = f;
  return HeartbeatSchema.parse({
    schema: "heartbeat.v1",
    sentAt: f.now.toISOString(),
    release: {
      tag: f.release.tag ?? "factory-image",
      gitSha: f.release.gitSha ?? "unknown",
      channel: f.release.channel,
    },
    os: { kernel: f.os.kernel, distro: f.os.distro },
    uptime: { bootedAt: f.bootedAt.toISOString(), seconds: whole(f.uptimeSec, "uptime") },
    services: f.services
      .map((s) => ({ name: s.name, state: s.state, health: s.health, restarts: whole(s.restarts, "restarts") }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    usage: {
      cpuPct: pct(u.cpuPct, "cpuPct"),
      memPct: pct(u.memPct, "memPct"),
      diskPct: pct(u.diskPct, "diskPct"),
      netRxBytes: whole(u.netRxBytes, "netRxBytes"),
      netTxBytes: whole(u.netTxBytes, "netTxBytes"),
      gpus: u.gpus.map((g) => ({
        utilPct: pct(g.utilPct, "gpu.utilPct"),
        vramUsedMb: whole(g.vramUsedMb, "gpu.vramUsedMb"),
        vramTotalMb: whole(g.vramTotalMb, "gpu.vramTotalMb"),
        tempC: Math.round(finite(g.tempC, "gpu.tempC")),
      })),
    },
    activity: {
      windowSec: whole(a.windowSec, "windowSec"),
      chatTurns: whole(a.chatTurns, "chatTurns"),
      agentRuns: whole(a.agentRuns, "agentRuns"),
      activeUsers: whole(a.activeUsers, "activeUsers"),
      ota: {
        checks: whole(a.ota.checks, "ota.checks"),
        downloads: whole(a.ota.downloads, "ota.downloads"),
        applies: whole(a.ota.applies, "ota.applies"),
        rollbacks: whole(a.ota.rollbacks, "ota.rollbacks"),
        failures: whole(a.ota.failures, "ota.failures"),
      },
      errorsByClass: foldErrorClasses(a.errorsByClass),
    },
  });
}

export interface EventFact {
  type: EventType;
  at: number | Date;
  code?: string;
  release?: string | null;
}

/**
 * `events.v1`, in batches of at most {@link MAX_EVENTS_PER_POST}. A `code` or
 * `release` that is not a stable code / release tag is dropped from the event
 * (the event itself still goes), never passed through.
 */
export function buildEvents(facts: readonly EventFact[]): EventsPayload[] {
  const events = facts.map((e) => {
    const code = e.code !== undefined && STABLE_CODE_RE.test(e.code) ? e.code : undefined;
    const release = e.release && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.release) ? e.release : undefined;
    return {
      type: e.type,
      at: new Date(e.at).toISOString(),
      ...(code ? { code } : {}),
      ...(release ? { release } : {}),
    };
  });
  const out: EventsPayload[] = [];
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_POST) {
    out.push(EventsSchema.parse({ schema: "events.v1", events: events.slice(i, i + MAX_EVENTS_PER_POST) }));
  }
  return out;
}

const LEVEL_RANK: Record<LogLevel, number> = { fatal: 3, error: 2, warn: 1 };
const MAX_AGGREGATE_KEYS = 1_000;

export interface LogFact {
  at: number;
  service: string;
  level: LogLevel;
  code: string;
  msg: string;
}

/**
 * Collects log facts and folds repeats: one record per (service, level, code)
 * with a `count`. `msg` is redacted on the way in. Bounded: past
 * {@link MAX_AGGREGATE_KEYS} distinct keys a new key is counted as dropped,
 * and a drain over {@link MAX_LOG_RECORDS} keeps the most severe, then the most
 * frequent, and adds one `log_overflow` record saying how many were left out.
 */
export class LogAggregator {
  private readonly rows = new Map<string, LogRecord>();
  private droppedKeys = 0;
  /** error|fatal counts by code since the last {@link takeErrorClasses}. */
  private errorClasses = new Map<string, number>();

  add(fact: LogFact): void {
    const code = toCode(fact.code);
    if (fact.level !== "warn") this.errorClasses.set(code, (this.errorClasses.get(code) ?? 0) + 1);
    const key = `${fact.service}\u0000${fact.level}\u0000${code}`;
    const row = this.rows.get(key);
    if (row) {
      row.count += 1;
      row.at = new Date(fact.at).toISOString();
      return;
    }
    if (this.rows.size >= MAX_AGGREGATE_KEYS) {
      this.droppedKeys += 1;
      return;
    }
    this.rows.set(key, {
      at: new Date(fact.at).toISOString(),
      service: fact.service,
      level: fact.level,
      code,
      msg: redactMessage(fact.msg) || code,
      count: 1,
    });
  }

  /** The pending records as one validated `logs.v1` payload (none when empty). Empties the aggregate. */
  drain(): LogsPayload[] {
    if (this.rows.size === 0) return [];
    const ranked = [...this.rows.values()].sort(
      (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.count - a.count,
    );
    const overflow = ranked.length > MAX_LOG_RECORDS || this.droppedKeys > 0;
    const records = overflow ? ranked.slice(0, MAX_LOG_RECORDS - 1) : ranked;
    if (overflow) {
      const left = ranked.length - records.length + this.droppedKeys;
      records.push({
        at: new Date().toISOString(),
        service: "orchestrator",
        level: "warn",
        code: "log_overflow",
        msg: `${left} further log records were left out of this send`,
        count: left,
      });
    }
    this.rows.clear();
    this.droppedKeys = 0;
    return [LogsSchema.parse({ schema: "logs.v1", records })];
  }

  /** The window's error counts by class (for `activity.errorsByClass`); starts a new window. */
  takeErrorClasses(): Record<string, number> {
    const out = Object.fromEntries(this.errorClasses);
    this.errorClasses = new Map();
    return out;
  }
}
