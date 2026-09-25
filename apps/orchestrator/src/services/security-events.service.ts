/**
 * WARP-2977 (ADR-059 §3.3, §6, §7) — the Security command center's event
 * store: the one writer of `SecurityEvent`, the threat mirror, retention,
 * and the ingest health the /security header shows.
 *
 * Meaning lives in `security-event-ingest.ts` (pure); this file persists it.
 *
 * Health is first-class because this box has shipped built-but-dark before:
 * an ingest that never subscribed looks exactly like a quiet site. The feed
 * header renders `securityIngestHealth()` so "nothing is reporting" and
 * "nothing happened" can never look the same (§3.2).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import {
  parseFrigateStatus,
  statusTransitionToDraft,
  threatRowToDraft,
  type SecurityEventDraft,
  type SourceHealth,
  type StatusReading,
} from "./security-event-ingest.js";
import { trimSecurityIncidents } from "./security-incidents.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-events");

/** DS-010. Clip references outlive Frigate's own 14-day clip retention and read "clip expired". */
export const SECURITY_EVENT_RETENTION_DAYS = 30;
/** 03:50 — continues the 03:00 / 03:15 / … / 03:45 spacing that keeps nightly legs off each other's lock pool. */
export const SECURITY_RETENTION_CRON = "50 3 * * *";
export const SECURITY_RETENTION_LOCK_KEY = "droplet:security-event-retention";
export const SECURITY_THREAT_MIRROR_INTERVAL_MS = 60_000;
export const SECURITY_THREAT_MIRROR_LOCK_KEY = "droplet:security-threat-mirror";
/** Rows read per mirror tick. A backlog drains over several ticks rather than one long transaction. */
export const SECURITY_THREAT_MIRROR_BATCH = 500;

const SINGLETON = "singleton";

type SecurityPrisma = Pick<PrismaClient, "securityEvent" | "securityIngestState" | "activityRow">;

// ── the one writer ──────────────────────────────────────────────────────

/**
 * Store one observation. Idempotent on `dedupeKey`: a QoS-1 redelivery of
 * the same Frigate `end` returns false and writes nothing. Never throws —
 * the MQTT handler that calls it must keep serving the live surface.
 */
export async function recordSecurityEvent(
  prisma: Pick<PrismaClient, "securityEvent">,
  draft: SecurityEventDraft,
): Promise<boolean> {
  try {
    const { count } = await prisma.securityEvent.createMany({ data: [draft], skipDuplicates: true });
    if (count > 0) ingestHealth.lastRecordedAt = new Date();
    return count > 0;
  } catch (err) {
    ingestHealth.lastWriteError = { at: new Date(), message: err instanceof Error ? err.message : String(err) };
    logger.error({ err, dedupeKey: draft.dedupeKey }, "security event write failed");
    return false;
  }
}

// ── camera / Frigate health: transitions only ───────────────────────────

const HEALTH_BY_KIND: Partial<Record<string, SourceHealth>> = {
  camera_offline: "offline",
  camera_online: "online",
  source_offline: "offline",
  source_online: "online",
};

/**
 * What one status reading meant. The two halves are separate on purpose:
 *   · `broadcast` — a change the LIVE surface should hear about. It never
 *     depends on the database: a camera going dark is shown even when its row
 *     could not be written (the detection path's rule, camera.service.ts).
 *   · `stored` — whether a row was written: true, false (the write failed; it
 *     is retried with its original time on that camera's next reading), or
 *     null (nothing to write).
 */
export interface StatusObservation {
  broadcast: SecurityEventDraft | null;
  stored: boolean | null;
}

export interface StatusTracker {
  /**
   * Feed one `frigate/<camera>/status/detect` or `frigate/available`
   * message. Resolves to null when the message is not a status topic.
   */
  observe(topic: string, payload: string, now?: Date): Promise<StatusObservation | null>;
  /**
   * Latest reading per camera (null key = Frigate itself), for the health
   * header and the coverage recorder (WARP-2980). `at` is the last reading;
   * `since` is when the health last CHANGED — a repeated reading (or a
   * retained replay on reconnect) moves `at`, never `since`.
   */
  snapshot(): ReadonlyMap<string | null, TrackedHealth>;
}

/** One camera's (or Frigate's own) latest reading, as `StatusTracker.snapshot()` holds it. */
export interface TrackedHealth {
  health: SourceHealth;
  /** The last reading. */
  at: Date;
  /** WARP-2980 — when `health` last changed. Coverage breaks a span on a change since its last confirmation. */
  since: Date;
}

/**
 * Two memories per camera, because "what the dashboard was told" and "what
 * the store holds" diverge whenever a write fails:
 *   · `told` — the last health broadcast. Dedupes the live surface.
 *   · `persisted` — the health the store reflects, read back from it the
 *     first time the camera reports after boot, so a restart does not
 *     re-announce every camera and a retained `online` is not news.
 * A transition whose write failed is kept in `pending` and retried, with its
 * ORIGINAL time and dedupe key, on the camera's next reading — so the feed
 * never shows "reporting again" without the offline row before it. If the
 * camera returns to the stored state first, the pending row is dropped: the
 * store then says nothing happened, which is consistent, not contradictory.
 *
 * Readings for one camera are applied in arrival order (a per-key promise
 * chain): `offline` then `online` a millisecond apart must not race.
 */
export function createStatusTracker(prisma: Pick<PrismaClient, "securityEvent">): StatusTracker {
  const last = new Map<string | null, TrackedHealth>();
  const told = new Map<string | null, SourceHealth>();
  const persisted = new Map<string | null, SourceHealth | null>();
  const pending = new Map<string | null, SecurityEventDraft>();
  const chains = new Map<string | null, Promise<unknown>>();

  async function previousFromStore(camera: string | null): Promise<SourceHealth | null> {
    const row = await prisma.securityEvent.findFirst({
      where: { source: "frigate_status", camera },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { kind: true },
    });
    return row ? (HEALTH_BY_KIND[row.kind] ?? null) : null;
  }

  async function apply(reading: StatusReading, now: Date): Promise<StatusObservation> {
    const key = reading.camera;
    const prev = last.get(key);
    last.set(key, { health: reading.health, at: now, since: prev && prev.health === reading.health ? prev.since : now });

    if (!persisted.has(key)) {
      try {
        persisted.set(key, await previousFromStore(key));
      } catch (err) {
        // No history to compare against — treat as first sight. The worst
        // case is one duplicate offline row; the alternative is a missed one.
        logger.warn({ err, camera: key }, "security status lookup failed");
        persisted.set(key, null);
      }
    }
    const inStore = persisted.get(key) ?? null;

    // The live surface: compared with what it was last told (before the
    // first reading after boot, the store's view).
    const broadcast = statusTransitionToDraft(reading, told.has(key) ? told.get(key)! : inStore, now);
    told.set(key, reading.health);

    // The store: compared with what it holds. `disabled` and a first-sight
    // `online` produce no row but still move the store's view forward.
    const fresh = statusTransitionToDraft(reading, inStore, now);
    if (!fresh) {
      pending.delete(key);
      persisted.set(key, reading.health);
      return { broadcast, stored: null };
    }
    const retry = pending.get(key);
    const draft = retry && retry.kind === fresh.kind ? retry : fresh;
    const stored = await recordSecurityEvent(prisma, draft);
    if (stored) {
      pending.delete(key);
      persisted.set(key, reading.health);
    } else {
      pending.set(key, draft);
    }
    return { broadcast, stored };
  }

  return {
    observe(topic, payload, now = new Date()) {
      const reading = parseFrigateStatus(topic, payload);
      if (!reading) return Promise.resolve(null);
      const prior = chains.get(reading.camera) ?? Promise.resolve();
      const next = prior.then(() => apply(reading, now));
      chains.set(
        reading.camera,
        next.catch(() => undefined),
      );
      return next;
    },
    snapshot: () => last,
  };
}

// ── the threat mirror ───────────────────────────────────────────────────

export interface ThreatMirrorResult {
  scanned: number;
  mirrored: number;
  cursor: bigint;
}

/**
 * Copy warn/err `network` and `auth` ActivityRows into the store — the rows
 * `list_threat_events` already treats as the threat feed. The chain row stays
 * the record; the SecurityEvent points at it by id.
 *
 * A fresh box starts from the retention horizon, not from the genesis row:
 * a threat older than the store keeps would be deleted by the next retention
 * run anyway.
 */
export async function mirrorThreatRows(
  prisma: SecurityPrisma,
  now: Date = new Date(),
  batch: number = SECURITY_THREAT_MIRROR_BATCH,
): Promise<ThreatMirrorResult> {
  const state = await prisma.securityIngestState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
    select: { threatCursor: true },
  });
  const horizon = new Date(now.getTime() - SECURITY_EVENT_RETENTION_DAYS * 86_400_000);
  // Read the chain's head FIRST. Appends are serialised under the chain's
  // advisory lock (activity.service.ts), so every id at or below a visible
  // head is committed or rolled back — none can appear later. Scanning up to
  // it and then advancing to it lets a box with rare threats stop rescanning
  // its whole 30-day window every minute.
  const { _max } = await prisma.activityRow.aggregate({ _max: { id: true } });
  const head = _max.id ?? state.threatCursor;
  const rows = await prisma.activityRow.findMany({
    where: {
      id: { gt: state.threatCursor, lte: head },
      at: { gte: horizon },
      kind: { in: ["network", "auth"] },
      severity: { in: ["warn", "err"] },
    },
    orderBy: { id: "asc" },
    take: batch,
    select: { id: true, at: true, kind: true, severity: true, what: true },
  });

  let mirrored = 0;
  if (rows.length > 0) {
    const drafts = rows.map((r) =>
      threatRowToDraft({
        id: r.id,
        at: r.at,
        kind: r.kind as "network" | "auth",
        severity: r.severity as "warn" | "err",
        what: r.what,
      }),
    );
    ({ count: mirrored } = await prisma.securityEvent.createMany({ data: drafts, skipDuplicates: true }));
  }
  // A full batch may have more matches behind it: stop at the last one read.
  // Otherwise this tick saw everything up to the head.
  const cursor =
    rows.length === batch ? rows[rows.length - 1].id : head > state.threatCursor ? head : state.threatCursor;
  await prisma.securityIngestState.update({
    where: { id: SINGLETON },
    data: { threatCursor: cursor, threatMirrorRanAt: now },
  });
  return { scanned: rows.length, mirrored, cursor };
}

// ── retention ───────────────────────────────────────────────────────────

export async function trimSecurityEvents(
  prisma: Pick<PrismaClient, "securityEvent" | "securityIngestState">,
  retentionDays: number = SECURITY_EVENT_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<{ deleted: number; before: Date }> {
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  const { count } = await prisma.securityEvent.deleteMany({ where: { startedAt: { lt: before } } });
  await prisma.securityIngestState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, retentionRanAt: now, retentionDeleted: count },
    update: { retentionRanAt: now, retentionDeleted: count },
  });
  return { deleted: count, before };
}

/**
 * Both jobs on the orchestrator's cron runtime, each single-flighted on its
 * own advisory lock. No new container, no bare setInterval, no while(true).
 *
 * WARP-2978 (§6.10): the retention leg trims incidents right after the
 * events, with the events' own `before`, so an incident's `eventsKept` says
 * exactly what the trim removed.
 */
export function registerSecurityJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval" | "scheduleCron">,
  prisma: PrismaClient,
): void {
  cronRuntime.scheduleInterval(
    SECURITY_THREAT_MIRROR_INTERVAL_MS,
    async () => {
      const r = await mirrorThreatRows(prisma);
      if (r.mirrored > 0) logger.info(r, "security threat mirror");
    },
    { lockKey: SECURITY_THREAT_MIRROR_LOCK_KEY },
  );
  cronRuntime.scheduleCron(
    SECURITY_RETENTION_CRON,
    async () => {
      const now = new Date();
      const r = await trimSecurityEvents(prisma, SECURITY_EVENT_RETENTION_DAYS, now);
      if (r.deleted > 0) logger.info(r, "security event retention trim");
      const i = await trimSecurityIncidents(prisma, r.before, now);
      if (i.marked > 0 || i.deleted > 0) logger.info(i, "security incident retention trim");
      await prisma.securityIngestState.update({ where: { id: SINGLETON }, data: { retentionIncidentsDeleted: i.deleted } });
    },
    { lockKey: SECURITY_RETENTION_LOCK_KEY },
  );
  ingestHealth.jobsRegistered = true;
}

// ── ingest health ───────────────────────────────────────────────────────

interface IngestHealthState {
  /** SUBACK granted for `frigate/events`. False until then, and false again if the broker refused it. */
  frigateSubscribed: boolean;
  frigateSubscribeError: string | null;
  frigateSubscribedAt: Date | null;
  lastFrigateMessageAt: Date | null;
  lastRecordedAt: Date | null;
  lastWriteError: { at: Date; message: string } | null;
  jobsRegistered: boolean;
}

const ingestHealth: IngestHealthState = {
  frigateSubscribed: false,
  frigateSubscribeError: null,
  frigateSubscribedAt: null,
  lastFrigateMessageAt: null,
  lastRecordedAt: null,
  lastWriteError: null,
  jobsRegistered: false,
};

/** The topics the ingest needs. camera.service subscribes to exactly these. */
export const SECURITY_FRIGATE_TOPICS = ["frigate/events", "frigate/+/status/detect", "frigate/available"] as const;

/**
 * Called from camera.service's SUBACK. MQTT reports a refused topic as
 * granted QoS 128 (e.g. a broker ACL that no longer allows `frigate/#`):
 * that is the loud failure §7 asks for — logged at error and shown on
 * /security — rather than a feed that is silently empty.
 */
export function noteFrigateSubscription(granted: ReadonlyArray<{ topic: string; qos: number }>, now = new Date()): void {
  const refused = SECURITY_FRIGATE_TOPICS.filter(
    (t) => !granted.some((g) => g.topic === t && g.qos !== 128 && g.qos >= 0 && g.qos <= 2),
  );
  if (refused.length > 0) {
    ingestHealth.frigateSubscribed = false;
    ingestHealth.frigateSubscribeError = `broker refused ${refused.join(", ")}`;
    logger.error({ refused }, "security ingest NOT subscribed — /security will show the camera feed as down");
    return;
  }
  ingestHealth.frigateSubscribed = true;
  ingestHealth.frigateSubscribeError = null;
  ingestHealth.frigateSubscribedAt = now;
}

export function noteFrigateSubscribeFailed(err: unknown): void {
  ingestHealth.frigateSubscribed = false;
  ingestHealth.frigateSubscribeError = err instanceof Error ? err.message : String(err);
  logger.error({ err }, "security ingest subscribe failed — /security will show the camera feed as down");
}

/**
 * The broker connection dropped (`close` / `offline`). Nothing is being
 * heard until the next CONNECT and its SUBACK restore the flag — until then
 * the header says the camera feed is down, never "Listening".
 */
export function noteFrigateConnectionLost(): void {
  if (!ingestHealth.frigateSubscribed && ingestHealth.frigateSubscribeError) return;
  ingestHealth.frigateSubscribed = false;
  ingestHealth.frigateSubscribeError = "Lost the connection to the camera system's message broker";
  logger.warn("security ingest lost its MQTT connection — /security shows the camera feed as down until it resubscribes");
}

export function noteFrigateMessage(now = new Date()): void {
  ingestHealth.lastFrigateMessageAt = now;
}

export type SourceState = "ok" | "quiet" | "down" | "not_configured";

/**
 * The header's rows, in the pinned display order
 * `camera_ingest, camera_system, (locks — P2b PR-2), threat_mirror, site_mode, incidents, alerts, patterns, retention`.
 * `site_mode` (WARP-2977 P2b) is the opening-hours ticker's row; `incidents`
 * and `alerts` (WARP-2978 P3) are the incident engine's and the notifier's;
 * `patterns` (WARP-2980 P5) is the baseline job's. P4's `links, summaries` go
 * between alerts and patterns when they land — whichever merges second moves
 * this pin.
 */
export type SecurityHealthId =
  | "camera_ingest"
  | "camera_system"
  | "threat_mirror"
  | "site_mode"
  | "incidents"
  | "alerts"
  | "patterns"
  | "retention";

export interface SecurityHealthRow {
  id: SecurityHealthId;
  state: SourceState;
  detail: string;
  lastSeenAt: string | null;
}

/** `3 events`, `1 incident`. */
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Hours of silence after which a subscribed camera feed reads as quiet rather than ok. */
const QUIET_AFTER_MS = 6 * 3_600_000;

/**
 * The feed header. Pure over its inputs so every branch is testable; the
 * route passes the live state.
 */
export function buildSecurityHealth(input: {
  frigateConfigured: boolean;
  ingest: Readonly<IngestHealthState>;
  frigate: { health: SourceHealth; at: Date } | undefined;
  state: {
    threatMirrorRanAt: Date | null;
    retentionRanAt: Date | null;
    retentionDeleted: number;
    /** WARP-2978 — incidents the last run removed (§6.10). */
    retentionIncidentsDeleted?: number;
  } | null;
  /**
   * WARP-2977 P2b — the site-mode ticker's row (`siteModeHealthRow` in
   * security-mode.service.ts), placed before `retention`. Optional: omitted,
   * the header is exactly P2a's.
   */
  siteMode?: SecurityHealthRow;
  /**
   * WARP-2978 — the incident engine's row (every viewer) and the alerts row
   * (owner/admin only: it names who is told), placed after `site_mode`. Each
   * optional and placed on its own.
   */
  incidents?: SecurityHealthRow;
  alerts?: SecurityHealthRow;
  /**
   * WARP-2980 P5 — the baseline job's row (`patternsHealthRow` in
   * security-baselines.service.ts), placed right before `retention`.
   * Optional: omitted, the header is exactly P2b's.
   */
  patterns?: SecurityHealthRow;
  now: Date;
}): SecurityHealthRow[] {
  const { ingest, now } = input;
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const rows: SecurityHealthRow[] = [];

  if (!input.frigateConfigured) {
    rows.push({ id: "camera_ingest", state: "not_configured", detail: "No camera system is set up", lastSeenAt: null });
  } else if (!ingest.frigateSubscribed) {
    rows.push({
      id: "camera_ingest",
      state: "down",
      detail: ingest.frigateSubscribeError ?? "Not listening to the camera system",
      lastSeenAt: iso(ingest.lastFrigateMessageAt),
    });
  } else {
    const heard = ingest.lastFrigateMessageAt ?? ingest.frigateSubscribedAt;
    const quiet = !heard || now.getTime() - heard.getTime() > QUIET_AFTER_MS;
    // The most recent write failed and nothing has been saved since.
    const failing =
      ingest.lastWriteError !== null && (!ingest.lastRecordedAt || ingest.lastWriteError.at > ingest.lastRecordedAt);
    rows.push({
      id: "camera_ingest",
      state: failing ? "down" : quiet ? "quiet" : "ok",
      detail: failing
        ? "Camera events are arriving but could not be saved"
        : quiet
          ? "Listening, but nothing heard from the cameras for 6 hours"
          : "Listening",
      lastSeenAt: iso(ingest.lastFrigateMessageAt),
    });
  }

  if (input.frigateConfigured) {
    rows.push(
      input.frigate
        ? {
            id: "camera_system",
            state: input.frigate.health === "online" ? "ok" : "down",
            detail: input.frigate.health === "online" ? "Camera system running" : "Camera system is not running",
            lastSeenAt: iso(input.frigate.at),
          }
        : { id: "camera_system", state: "quiet", detail: "No word from the camera system since Droplet started", lastSeenAt: null },
    );
  }

  const mirrorRan = input.state?.threatMirrorRanAt ?? null;
  rows.push({
    id: "threat_mirror",
    state: !ingest.jobsRegistered
      ? "down"
      : mirrorRan && now.getTime() - mirrorRan.getTime() <= 5 * SECURITY_THREAT_MIRROR_INTERVAL_MS
        ? "ok"
        : "quiet",
    detail: !ingest.jobsRegistered ? "Not scheduled" : "Checks the network and sign-in log every minute",
    lastSeenAt: iso(mirrorRan),
  });

  if (input.siteMode) rows.push(input.siteMode);
  if (input.incidents) rows.push(input.incidents);
  if (input.alerts) rows.push(input.alerts);
  if (input.patterns) rows.push(input.patterns);

  const retentionRan = input.state?.retentionRanAt ?? null;
  rows.push({
    id: "retention",
    state: !ingest.jobsRegistered
      ? "down"
      : retentionRan && now.getTime() - retentionRan.getTime() <= 36 * 3_600_000
        ? "ok"
        : "quiet",
    detail: `Keeps events ${SECURITY_EVENT_RETENTION_DAYS} days and incidents a year${retentionRan ? `; last removed ${count(input.state?.retentionDeleted ?? 0, "event")} and ${count(input.state?.retentionIncidentsDeleted ?? 0, "incident")}` : "; not run yet"}`,
    lastSeenAt: iso(retentionRan),
  });

  return rows;
}

export function securityIngestHealthState(): Readonly<IngestHealthState> {
  return ingestHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetSecurityIngestHealthForTests(): void {
  Object.assign(ingestHealth, {
    frigateSubscribed: false,
    frigateSubscribeError: null,
    frigateSubscribedAt: null,
    lastFrigateMessageAt: null,
    lastRecordedAt: null,
    lastWriteError: null,
    jobsRegistered: false,
  } satisfies IngestHealthState);
}

// ── the feed query ──────────────────────────────────────────────────────

export interface SecurityFeedQuery {
  limit: number;
  cursor?: { startedAt: Date; id: bigint };
  kinds?: Prisma.SecurityEventWhereInput["kind"];
  camera?: string;
  includeLow: boolean;
}

/**
 * Who may see which rows. Camera rows follow CameraAccessGrant — a camera
 * outside the grant is absent, not redacted (DS-005). Mirrored threats point
 * at owner/admin-only ActivityRows, so they are owner/admin-only here too.
 */
export function feedVisibilityWhere(
  visibleCameras: "all" | ReadonlySet<string>,
  mayReadThreats: boolean,
): Prisma.SecurityEventWhereInput {
  const and: Prisma.SecurityEventWhereInput[] = [];
  if (visibleCameras !== "all") {
    and.push({ OR: [{ camera: null }, { camera: { in: [...visibleCameras] } }] });
  }
  if (!mayReadThreats) and.push({ source: { not: "activity_mirror" } });
  return and.length > 0 ? { AND: and } : {};
}

/**
 * One page of the feed. `visibility` is ALWAYS `AND[0]` — the DS-005 filter
 * is never merged with, or replaced by, a caller's narrowing.
 *
 * `extraWhere` (WARP-2977 P2b) is appended after the camera clause: the area
 * filter (`?zone=`) passes its `zoneEventWhere` clause here. It can only
 * narrow — every entry is ANDed — so it can never widen what `visibility`
 * lets through.
 */
export async function listSecurityEvents(
  prisma: Pick<PrismaClient, "securityEvent">,
  visibility: Prisma.SecurityEventWhereInput,
  q: SecurityFeedQuery,
  extraWhere: readonly Prisma.SecurityEventWhereInput[] = [],
) {
  const where: Prisma.SecurityEventWhereInput = {
    AND: [
      visibility,
      q.includeLow ? {} : { kind: { not: "detection_low" } },
      q.kinds ? { kind: q.kinds } : {},
      q.camera ? { camera: q.camera } : {},
      ...extraWhere,
      q.cursor
        ? {
            OR: [
              { startedAt: { lt: q.cursor.startedAt } },
              { startedAt: q.cursor.startedAt, id: { lt: q.cursor.id } },
            ],
          }
        : {},
    ],
  };
  const rows = await prisma.securityEvent.findMany({
    where,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const tail = page[page.length - 1];
  return {
    events: page.map((r) => ({
      id: r.id.toString(),
      source: r.source,
      kind: r.kind,
      severity: r.severity,
      camera: r.camera,
      labels: r.labels,
      cameraZones: r.cameraZones,
      score: r.score,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      summary: r.summary,
      // A detection's Frigate id, for the clip/thumbnail routes (which run their own camera guard).
      frigateEventId: r.source === "frigate" ? r.sourceRef.slice(r.sourceRef.indexOf("/") + 1) : null,
    })),
    nextCursor: rows.length > q.limit && tail ? `${tail.startedAt.getTime()}.${tail.id}` : null,
  };
}

/** Postgres BIGINT ceiling — a larger id would fail in the query as a 503, not a 400. */
const INT8_MAX = 9_223_372_036_854_775_807n;

export function parseFeedCursor(raw: string): { startedAt: Date; id: bigint } | null {
  const m = /^(\d{1,15})\.(\d{1,19})$/.exec(raw);
  if (!m) return null;
  const id = BigInt(m[2]);
  if (id > INT8_MAX) return null;
  return { startedAt: new Date(Number(m[1])), id };
}
