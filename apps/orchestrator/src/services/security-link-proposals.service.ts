/**
 * WARP-2979 (ADR-059 P4 §6.3, DS-006) — Droplet's link proposals: an hourly
 * job that counts co-occurrence between a source a PERSON placed in an area
 * and every other camera or part of a view, suggests links above a floor and
 * activates links above a higher bar ("Linked by Droplet", one-tap Undo).
 *
 * What it may write, and nothing else (security-link-proposals.imports.test.ts,
 * slice L): `SecurityZoneLink` rows it created (`origin = droplet`), the area
 * version it CASes, and one ActivityRow per state change, audited IN the
 * transaction as the system actor (`auditSecuritySystemInTx`, never `ai`).
 * It never removes, rejects, demotes or re-scores a link, never touches a row
 * a person set, never builds on its own unconfirmed links (anchors are
 * `stateSetBy = person` only), never re-proposes a `removed` or `rejected`
 * source, and never exceeds 32 active links or 8 open suggestions per area
 * (§6.6). `SecurityAiSettings.linking` decides: `off` looks for nothing,
 * `suggest_only` never activates.
 *
 * Registration (§6.3): `cronRuntime.scheduleInterval(1 h, tick, {lockKey})` —
 * plain SQL plus arithmetic, bounded to 30 s, so it fits the cron lock's 60 s
 * transaction. There is no first tick; health reads "First look by …" for
 * the first hour. `registeredAt` is the `links` health row's boot assertion.
 *
 * S0 FOUNDATION (slice L fills the bodies). The signatures are final; the
 * bodies are SAFE: `registerSecurityLinkJobs` registers NOTHING, so the
 * health row honestly reads "Not running" until slice L wires the tick, and
 * `runSecurityLinkProposals` writes nothing.
 */
import type { PrismaClient } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityHealthRow } from "./security-events.service.js";
import type { SecurityAiSettingsView } from "./security-ai-settings.js";

/** Hourly (D8). A bare `scheduleInterval` has no first tick. */
export const SECURITY_LINK_INTERVAL_MS = 3_600_000;
export const SECURITY_LINK_LOCK_KEY = "droplet:security-link-proposals";
/** Work budget per tick: stop at the next area boundary and resume there next hour (rotation). */
export const SECURITY_LINK_BUDGET_MS = 30_000;
/** The `links` row reads down when registered over this long and no run completed within it (§6.15). */
export const LINK_HEALTH_STALE_MS = 70 * 60_000;
/** Open suggestions per area, and new rows per run (§6.3 step 6). */
export const MAX_OPEN_SUGGESTIONS_PER_AREA = 8;
export const MAX_NEW_LINK_ROWS_PER_RUN = 20;

/** What one tick did (health's `lastRun`, and the tick's log line). */
export interface LinkRunSummary {
  /** (anchor, candidate[, reverse]) scorings. */
  scored: number;
  /** New `proposed` rows. */
  proposed: number;
  /** Links made `active` by Droplet (new, or from `proposed`). */
  activated: number;
  /** `proposed` rows whose evidence was refreshed (not a state change; not audited). */
  refreshed: number;
  ms: number;
}

/** In-memory health state (one orchestrator process per box). */
export interface LinkHealthState {
  /** Set by `registerSecurityLinkJobs`. Null = the job is not running (the boot assertion). */
  registeredAt: Date | null;
  /** The last tick that completed (including a `linking = off` tick, which only records this). */
  lastOkAt: Date | null;
  lastError: { at: Date; message: string } | null;
  lastRun: LinkRunSummary | null;
}

const linkHealth: LinkHealthState = { registeredAt: null, lastOkAt: null, lastError: null, lastRun: null };

export function linkHealthState(): Readonly<LinkHealthState> {
  return linkHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetLinkHealthForTests(): void {
  Object.assign(linkHealth, { registeredAt: null, lastOkAt: null, lastError: null, lastRun: null } satisfies LinkHealthState);
}

/**
 * The `links` row (§6.15), pure. Every viewer; it names no area, camera or
 * incident. `tz` is the site's own zone for clock copy (never UTC; without
 * one, minutes), exactly as P3's incidents row.
 *
 *   · down "Not running" — not registered (the boot assertion);
 *   · down "Couldn't look for links: <reason>" — `lastError` newer than `lastOkAt`;
 *   · down "Hasn't looked for links since 3:14 PM" — registered over 70 min
 *     ago and no completed run in the last 70 min;
 *   · not_configured "Turned off in Security settings" — `linking = off`;
 *   · ok "Looks every hour for cameras that cover your areas" (`link_and_suggest`)
 *     / "…and only suggests them" (`suggest_only`); "First look by 4:14 PM" in
 *     the first hour. `lastSeenAt` = `lastOkAt`.
 *
 * S0 stub: only the first state is reachable while the job registers
 * nothing, and that is the only one it returns; slice L builds the rest.
 */
export function linkHealthRow(
  state: Readonly<LinkHealthState>,
  settings: Pick<SecurityAiSettingsView, "linking"> | null,
  tz: string | null,
  now: Date,
): SecurityHealthRow {
  void settings;
  void tz;
  void now;
  return { id: "links", state: "down", detail: "Not running", lastSeenAt: state.lastOkAt ? state.lastOkAt.toISOString() : null };
}

/**
 * The row /security/health shows. NEVER throws: settings or the site zone
 * that cannot be read degrade the row (settings null, minutes instead of a
 * clock time), never the header.
 *
 * S0 stub: reads nothing (the only reachable state needs nothing).
 */
export async function securityLinksHealth(
  prisma: Pick<PrismaClient, "securityAiSettings" | "securitySiteHours">,
  now: Date,
): Promise<SecurityHealthRow> {
  void prisma;
  return linkHealthRow(linkHealth, null, null, now);
}

/**
 * One tick (§6.3): settings → anchors → one load of the window's rows →
 * coverage and blind spells → score → plan per area → apply per area in one
 * READ_COMMITTED transaction (CAS the area, write the links guarded on
 * `{state, origin: 'droplet', stateSetBy: 'droplet'}`, audit last) → health.
 * A throw sets `lastError` and rethrows into `safeRun`'s canary.
 *
 * S0 stub — writes nothing and reports nothing done.
 */
export async function runSecurityLinkProposals(prisma: PrismaClient, now: Date = new Date()): Promise<LinkRunSummary> {
  void prisma;
  void now;
  return { scored: 0, proposed: 0, activated: 0, refreshed: 0, ms: 0 };
}

/**
 * Wire the hourly job (index.ts, right after `registerSecurityIncidentJobs`)
 * and set `registeredAt`.
 *
 * S0 stub: registers NOTHING and leaves `registeredAt` null, so the `links`
 * health row reads "Not running" — the truth — until slice L wires the tick.
 */
export function registerSecurityLinkJobs(cronRuntime: Pick<CronRuntime, "scheduleInterval">, prisma: PrismaClient): void {
  void cronRuntime;
  void prisma;
}
