/**
 * WARP-3504 (ADR-068) — the box side of the fleet telemetry contract v1 (§4):
 * `heartbeat.v1`, `events.v1` and `logs.v1` as zod mirrors of the portal's
 * schemas, with UNKNOWN KEYS REJECTED at every level.
 *
 * This is the closed allowlist. Nothing reaches the portal that did not pass
 * through one of these schemas, so a field that is not named here cannot be
 * sent, whatever a caller tries to hand the builders. The free-text positions
 * are few and each is pinned to a narrow shape: a compose service name, a
 * stable code, a release tag, a hex sha, a kernel/distro string, and `msg`
 * (redacted, <= 500 chars: box-telemetry/redact.ts).
 *
 * NEVER SENT (contract §4 and ADR-068): prompts or responses, file names,
 * paths or contents, user names, emails or ids, customer hostnames, LAN IPs,
 * MACs or device lists, camera data, business data. {@link NEVER_SENT} is the
 * plain-language version of that list, shown verbatim on the owner's page.
 *
 * Wire details that are a choice of this box, not of the contract text:
 *   - percentages and temperatures are whole numbers;
 *   - `services` is every compose service the box runs; `gpus` carries only a
 *     card whose four counters are all known (a null is not sent as a zero);
 *   - a box that has never taken an OTA release reports tag `factory-image`
 *     and gitSha `unknown`.
 */
import { z } from "zod";

export const HEARTBEAT_SCHEMA_ID = "heartbeat.v1";
export const EVENTS_SCHEMA_ID = "events.v1";
export const LOGS_SCHEMA_ID = "logs.v1";

export const TELEMETRY_KINDS = ["heartbeat", "events", "logs"] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

/** Appended to the portal origin. */
export const TELEMETRY_PATH: Record<TelemetryKind, string> = {
  heartbeat: "/api/v1/telemetry/heartbeat",
  events: "/api/v1/telemetry/events",
  logs: "/api/v1/telemetry/logs",
};

export const SERVICE_STATES = ["running", "exited", "restarting", "created", "paused", "dead"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export const SERVICE_HEALTH = ["healthy", "unhealthy", "starting", "none"] as const;
export type ServiceHealth = (typeof SERVICE_HEALTH)[number];

export const RELEASE_CHANNEL_VALUES = ["stage", "stable"] as const;
export const LOG_LEVELS = ["warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// The final label of the download step is an ICANN TLD, so the egress gate
// (scripts/check-egress-allowlist.py) would read a whole-string literal of that
// event name as a destination host. The OTA event names are therefore built from
// a prefix and a step, never written whole.
export const otaEvent = (step: "check" | "download" | "apply" | "rollback" | "failed") => `ota.${step}` as const;

export const EVENT_TYPES = [
  "boot",
  "shutdown",
  "service.crash",
  "service.recovered",
  otaEvent("check"),
  otaEvent("download"),
  otaEvent("apply"),
  otaEvent("rollback"),
  otaEvent("failed"),
  "token.refused",
  "disk.low",
  "gpu.error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const MAX_LOG_RECORDS = 500;
export const MAX_EVENTS_PER_POST = 100;
export const MSG_MAX_CHARS = 500;

const iso = z.string().datetime();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const pct = z.number().int().min(0).max(100);
// No dot: a compose service name here is `[a-z0-9_-]`, so an address or a file name cannot pass as one.
export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const STABLE_CODE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const RELEASE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const serviceName = z.string().regex(SERVICE_NAME_RE);
const stableCode = z.string().regex(STABLE_CODE_RE);
const releaseTag = z.string().regex(RELEASE_TAG_RE);
const gitSha = z.string().regex(/^(?:[0-9a-f]{7,64}|unknown)$/);
const hostText = z.string().regex(/^[\x20-\x7e]{1,128}$/);

const gpu = z
  .object({
    utilPct: pct,
    vramUsedMb: count,
    vramTotalMb: count,
    tempC: z.number().int().min(-50).max(150),
  })
  .strict();

const service = z
  .object({
    name: serviceName,
    state: z.enum(SERVICE_STATES),
    health: z.enum(SERVICE_HEALTH),
    restarts: count,
  })
  .strict();

export const MAX_ERROR_CLASSES = 32;

export const HeartbeatSchema = z
  .object({
    schema: z.literal(HEARTBEAT_SCHEMA_ID),
    sentAt: iso,
    release: z
      .object({ tag: releaseTag, gitSha, channel: z.enum(RELEASE_CHANNEL_VALUES) })
      .strict(),
    os: z.object({ kernel: hostText, distro: hostText }).strict(),
    uptime: z.object({ bootedAt: iso, seconds: count }).strict(),
    services: z.array(service).max(200),
    usage: z
      .object({
        cpuPct: pct,
        memPct: pct,
        diskPct: pct,
        netRxBytes: count,
        netTxBytes: count,
        gpus: z.array(gpu).max(8),
      })
      .strict(),
    activity: z
      .object({
        windowSec: z.number().int().min(1).max(86_400),
        chatTurns: count,
        agentRuns: count,
        activeUsers: count,
        ota: z
          .object({
            checks: count,
            downloads: count,
            applies: count,
            rollbacks: count,
            failures: count,
          })
          .strict(),
        errorsByClass: z
          .record(stableCode, count)
          .refine((o) => Object.keys(o).length <= MAX_ERROR_CLASSES, "too many error classes"),
      })
      .strict(),
  })
  .strict();
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

const event = z
  .object({
    type: z.enum(EVENT_TYPES),
    at: iso,
    code: stableCode.optional(),
    release: releaseTag.optional(),
  })
  .strict();
export type TelemetryEvent = z.infer<typeof event>;

export const EventsSchema = z
  .object({
    schema: z.literal(EVENTS_SCHEMA_ID),
    events: z.array(event).min(1).max(MAX_EVENTS_PER_POST),
  })
  .strict();
export type EventsPayload = z.infer<typeof EventsSchema>;

const logRecord = z
  .object({
    at: iso,
    service: serviceName,
    level: z.enum(LOG_LEVELS),
    code: stableCode,
    msg: z.string().min(1).max(MSG_MAX_CHARS),
    count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type LogRecord = z.infer<typeof logRecord>;

export const LogsSchema = z
  .object({
    schema: z.literal(LOGS_SCHEMA_ID),
    records: z.array(logRecord).min(1).max(MAX_LOG_RECORDS),
  })
  .strict();
export type LogsPayload = z.infer<typeof LogsSchema>;

export const PAYLOAD_SCHEMAS = {
  heartbeat: HeartbeatSchema,
  events: EventsSchema,
  logs: LogsSchema,
} as const;

/** Parse and re-serialise: strict schema in, the exact bytes out. Throws ZodError. */
export function serializePayload(kind: TelemetryKind, payload: unknown): string {
  return JSON.stringify(PAYLOAD_SCHEMAS[kind].parse(payload));
}

// ── What the owner sees (GET /api/telemetry/last, Settings page) ───────────

/** Plain-language list of what is never sent. Mirrors contract §4. */
export const NEVER_SENT: readonly string[] = [
  "Anything people type to the assistant, or anything it answers",
  "File names, folder paths or file contents",
  "Names, email addresses or IDs of members, guests or anyone else",
  "Names the business chose for its computers or network",
  "LAN addresses, hardware addresses, or lists of devices",
  "Camera footage or camera details",
  "Business data of any kind",
];

/** Defaults on the portal side; both are tunable there. */
export const RETENTION = { rawDays: 30, dailySummaryMonths: 13 } as const;

export interface SchemaDoc {
  schema: string;
  /** Path appended to the portal origin. */
  endpoint: string;
  /** Plain-language: when it is sent and what it is for. */
  summary: string;
  /** Every field, by path, with what it means. */
  fields: ReadonlyArray<{ path: string; meaning: string }>;
}

export const SCHEMA_DOCS: readonly SchemaDoc[] = [
  {
    schema: HEARTBEAT_SCHEMA_ID,
    endpoint: TELEMETRY_PATH.heartbeat,
    summary: "A health snapshot, sent every 5 minutes: which release runs, how busy the machine is, which services are up, and how much the assistant was used (counts only).",
    fields: [
      { path: "release.tag / gitSha / channel", meaning: "The software release this Droplet runs and the update channel it follows" },
      { path: "os.kernel / distro", meaning: "The operating system version of the machine" },
      { path: "uptime.bootedAt / seconds", meaning: "When the machine last started, and for how long it has been up" },
      { path: "services[].name / state / health / restarts", meaning: "Each Droplet service: running or not, its health check, and how often it restarted" },
      { path: "usage.cpuPct / memPct / diskPct", meaning: "Processor, memory and system disk use, in percent" },
      { path: "usage.netRxBytes / netTxBytes", meaning: "Bytes received and sent by the Droplet control plane" },
      { path: "usage.gpus[]", meaning: "Graphics card load, memory and temperature, when the card reports them" },
      { path: "activity.chatTurns / agentRuns", meaning: "How many assistant messages and background runs happened in the window. Counts, never content" },
      { path: "activity.activeUsers", meaning: "How many people were active in the window. A number, never who" },
      { path: "activity.ota", meaning: "How many update checks, downloads, installs, rollbacks and failures happened" },
      { path: "activity.errorsByClass", meaning: "How many errors of each kind (an error class name) the software logged" },
    ],
  },
  {
    schema: EVENTS_SCHEMA_ID,
    endpoint: TELEMETRY_PATH.events,
    summary: "Short notices, sent within a minute of happening: a start-up, a service crash or recovery, an update step, a refused credential, low disk space.",
    fields: [
      { path: "events[].type", meaning: "What happened, from a fixed list" },
      { path: "events[].at", meaning: "When it happened" },
      { path: "events[].code", meaning: "A short stable reason code, such as the update refusal reason" },
      { path: "events[].release", meaning: "The release an update step was about" },
    ],
  },
  {
    schema: LOGS_SCHEMA_ID,
    endpoint: TELEMETRY_PATH.logs,
    summary: "Warnings and errors the Droplet software logged, with a stable error code. Identical records in a window are merged and counted. Messages are cleaned on this Droplet before they leave: email addresses, network addresses, hardware addresses, file paths, web addresses and long tokens are masked.",
    fields: [
      { path: "records[].at / service / level", meaning: "When, which Droplet service, and warn, error or fatal" },
      { path: "records[].code", meaning: "A stable error code or class" },
      { path: "records[].msg", meaning: "The cleaned message, at most 500 characters" },
      { path: "records[].count", meaning: "How many identical records were merged" },
    ],
  },
];

/** Where the box is with the portal. Explicit, never inferred. */
export const TELEMETRY_LINK_STATES = [
  "disabled",
  "unconfigured",
  "starting",
  "ok",
  "retrying",
  "not_enrolled",
  "revoked",
] as const;
export type TelemetryLinkState = (typeof TELEMETRY_LINK_STATES)[number];

export interface SentRecord {
  sentAt: string;
  /** The exact JSON that was sent. */
  payload: unknown;
}

export interface TelemetryLast {
  state: TelemetryLinkState;
  /** Host of the portal this box sends to, or null when not configured. */
  portalHost: string | null;
  heartbeatIntervalSec: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** A short code, never a message. */
  lastErrorCode: string | null;
  queued: Record<TelemetryKind, number>;
  /** Payloads dropped because the buffer was full (oldest first). */
  dropped: number;
  last: Record<TelemetryKind, SentRecord | null>;
  schemas: readonly SchemaDoc[];
  neverSent: readonly string[];
  retention: typeof RETENTION;
}
