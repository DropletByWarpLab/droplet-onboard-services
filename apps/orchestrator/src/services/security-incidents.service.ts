/**
 * WARP-2978 (ADR-059 P3 §3.5, spec §6.1) — the incident engine: it sorts
 * SecurityEvent rows into incidents, attaches reason codes, seals incidents
 * after quiet, hands `alert` incidents to the notifier, and trims incidents
 * with the events (§6.10). The `incidents` health row is its own (§6.11).
 *
 * S0: the final signatures with safe bodies. `registerSecurityIncidentJobs`
 * registers NOTHING yet and leaves `registeredAt` null, so the health row
 * honestly reads "Not running" until slice B lands the engine.
 */
import type { PrismaClient } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityHealthRow } from "./security-events.service.js";
import type { EffectiveAccessResolver } from "../middleware/feature-gate.js";
import { RULESET } from "../lib/security-rules.js";

export const SECURITY_INCIDENT_INTERVAL_MS = 10_000;
export const SECURITY_INCIDENT_LOCK_KEY = "droplet:security-incidents";
/** Events triaged per tick at most. */
export const TRIAGE_BATCH = 200;
/** A tick stops triaging after this long — well inside the cron lock transaction's 60 s. */
export const TICK_BUDGET_MS = 30_000;
/** The floor only advances to a head seen at least this long ago (§6.1 step 3). */
export const FLOOR_SETTLE_MS = 120_000;
/** The grouping numbers (D13) and the evidence cap live with the rules they belong to (lib/security-rules.ts). */
export { QUIET_MS, SETTLE_MS, MAX_SPAN_MS, EVIDENCE_PER_CAMERA } from "../lib/security-rules.js";
/** camera_offline: a camera must stay down this long (§6.5) — the ruleset's number. */
export const OFFLINE_MIN_MS = RULESET.camera_offline.minOfflineMs;
/** Every sealed/plain incident follows its events (30 d); a coded one is kept a year (D30). */
export const SECURITY_INCIDENT_RETENTION_DAYS = 365;

/** What index.ts hands the engine (spec §6.1). */
export interface SecurityIncidentDeps {
  /** The box-wide `security` toggle (D29: incidents are still grouped when it is off; nothing is sent). */
  isSecurityModuleOn: () => Promise<boolean>;
  /** The §9 resolver — alert eligibility is re-checked at send time (§6.7). */
  resolveAccess: EffectiveAccessResolver;
  now?: () => Date;
}

// ── health (§6.11) ─────────────────────────────────────────────────────────

export interface IncidentHealthState {
  /** Set by `registerSecurityIncidentJobs`. Null = the engine is not running (§7's boot assertion). */
  registeredAt: Date | null;
  /** The last tick that completed every step. */
  lastOkAt: Date | null;
  lastError: { at: Date; message: string } | null;
  /** `failed` triage rows in the last 24 h, counted each tick. */
  failedLastDay: number;
}

const incidentHealth: IncidentHealthState = { registeredAt: null, lastOkAt: null, lastError: null, failedLastDay: 0 };

export function incidentHealthState(): Readonly<IncidentHealthState> {
  return incidentHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetIncidentHealthForTests(): void {
  Object.assign(incidentHealth, {
    registeredAt: null,
    lastOkAt: null,
    lastError: null,
    failedLastDay: 0,
  } satisfies IncidentHealthState);
}

/** The `incidents` row. S0: "Not running" until the engine registers. */
export function incidentHealthRow(
  health: Readonly<IncidentHealthState>,
  tz: string | null,
  now: Date,
): SecurityHealthRow {
  void tz;
  void now;
  const lastSeenAt = health.lastOkAt ? health.lastOkAt.toISOString() : null;
  if (!health.registeredAt) return { id: "incidents", state: "down", detail: "Not running", lastSeenAt };
  return { id: "incidents", state: "ok", detail: "Sorting events into incidents", lastSeenAt };
}

/** The row the /security/health handler shows. Never throws. */
export async function securityIncidentsHealth(
  prisma: Pick<PrismaClient, "securitySiteHours">,
  now: Date,
): Promise<SecurityHealthRow> {
  void prisma;
  return incidentHealthRow(incidentHealth, null, now);
}

// ── registration ──────────────────────────────────────────────────────────

/** S0: registers nothing and sets nothing — the health row honestly reads "Not running". */
export function registerSecurityIncidentJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  prisma: PrismaClient,
  deps: SecurityIncidentDeps,
): void {
  void cronRuntime;
  void prisma;
  void deps;
}

// ── retention (§6.10) ─────────────────────────────────────────────────────

export interface IncidentTrimResult {
  /** Incidents whose `eventsKept` changed. */
  marked: number;
  /** Incidents deleted (plain activity past the events' horizon, coded ones past a year). */
  deleted: number;
}

/** S0 stub: trims nothing. Slice B implements §6.10 with the events' own `before`. */
export async function trimSecurityIncidents(
  prisma: PrismaClient,
  before: Date,
  now: Date,
): Promise<IncidentTrimResult> {
  void prisma;
  void before;
  void now;
  return { marked: 0, deleted: 0 };
}
