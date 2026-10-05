/**
 * WARP-3504 (ADR-068) — the pino stream hook behind the box's operational log
 * telemetry (`logs.v1`, source A: the orchestrator's own logs).
 *
 * `createLogger` (lib/logger.ts) writes every record to stdout AND hands each
 * record at warn or above to {@link logTapStream}, through
 * {@link stdoutWithLogTap}. The tap reduces a record to the ONLY four things
 * the telemetry sender may use:
 *
 *   level   warn | error | fatal
 *   logger  the pino logger name ("update-agent", "cron-runtime", ...)
 *   code    a stable class: the record's `event`, else `err.code`
 *           (ECONNREFUSED, P2002), else the error class name, else the logger
 *           name. Never free text.
 *   msg     pino's own `msg` string. NEVER `err.message`, the stack or any
 *           other structured field: those carry values (ids, names, paths)
 *           that the convention keeps out of `msg`.
 *
 * The sender redacts `msg` before it queues anything (box-telemetry/redact.ts);
 * the tap itself does no I/O and never throws into the logger. Records logged
 * before the sender attaches (boot errors are the valuable ones) wait in a
 * small ring and are handed over on attach.
 */

export type TappedLevel = "warn" | "error" | "fatal";

export interface TappedLog {
  /** Epoch ms from the record's `time`. */
  at: number;
  level: TappedLevel;
  logger: string;
  code: string;
  msg: string;
}

/** The sender's own logger. Its warnings are never tapped: a failing send
 *  would otherwise log a warning that becomes a log record that is sent. */
export const TELEMETRY_LOGGER_NAME = "box-telemetry";

const CODE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const EARLY_MAX = 200;

type Sink = (record: TappedLog) => void;

let sink: Sink | null = null;
const early: TappedLog[] = [];

/** Attach (or, with null, detach) the consumer. Attaching drains the ring. */
export function setLogTapSink(next: Sink | null): void {
  sink = next;
  if (!next) return;
  for (const record of early.splice(0)) deliver(next, record);
}

function deliver(to: Sink, record: TappedLog): void {
  try {
    to(record);
  } catch {
    // A consumer bug must never reach the logger.
  }
}

function codeOf(o: Record<string, unknown>, logger: string, level: TappedLevel): string {
  const pick = (v: unknown): string | null =>
    typeof v === "string" && CODE_RE.test(v) ? v : null;
  const err =
    typeof o.err === "object" && o.err !== null ? (o.err as Record<string, unknown>) : {};
  const fromLogger = logger.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40);
  return (
    pick(o.event) ??
    pick(err.code) ??
    pick(err.type) ??
    pick(err.name) ??
    (fromLogger ? `${fromLogger}.${level}` : `unclassified.${level}`)
  );
}

/** Level numbers pino writes: 40 warn, 50 error, 60 fatal. */
function levelOf(n: unknown): TappedLevel | null {
  return n === 40 ? "warn" : n === 50 ? "error" : n === 60 ? "fatal" : null;
}

/** Tap one pino line (one JSON record). Records below warn are ignored. */
export const logTapStream = {
  write(line: string): void {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const level = levelOf(o.level);
      if (!level) return;
      const logger = typeof o.name === "string" ? o.name : "";
      if (logger === TELEMETRY_LOGGER_NAME) return;
      const record: TappedLog = {
        at: typeof o.time === "number" ? o.time : Date.now(),
        level,
        logger,
        code: codeOf(o, logger, level),
        msg: typeof o.msg === "string" ? o.msg : "",
      };
      if (sink) {
        deliver(sink, record);
      } else {
        early.push(record);
        if (early.length > EARLY_MAX) early.shift();
      }
    } catch {
      // Not JSON, or a consumer threw: drop it, never disturb the logger.
    }
  },
};

const WARN_OR_ABOVE = /^\{"level":(?:40|50|60)[,}]/;

/**
 * What lib/logger.ts hands pino as its destination: the line goes to stdout
 * exactly as before, and a warn+ line also to {@link logTapStream}. pino
 * writes `level` first, so the check is a prefix test, not a parse.
 */
export const stdoutWithLogTap = {
  write(line: string): void {
    process.stdout.write(line);
    if (WARN_OR_ABOVE.test(line)) logTapStream.write(line);
  },
};
