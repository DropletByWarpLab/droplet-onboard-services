/**
 * WARP-1405 — backups can no longer fail silently.
 *
 * The incident: a DEVICE_SECRET_KEY rotation orphaned the restic repository,
 * every nightly run failed in half a second, and nobody heard for 16 days —
 * then it happened again. The backup runs on the HOST (systemd timer,
 * scripts/host/droplet-backup.sh); on every exit it writes an explicit status
 * file, bind-mounted read-only here (docker-compose.yml, orchestrator):
 *
 *   { state: ok|failed|key_mismatch|pending, reason, since,
 *     lastAttemptAt, lastSuccessAt, lastFailureAt, lastRekeyAt }
 *
 * This file turns that into ONE health value for the dashboard and the owner:
 *
 *   healthy        last run succeeded, inside the window
 *   pending        installed, first backup not due yet
 *   failing        last run failed, but a success is still inside the window
 *   overdue        no successful backup inside BACKUP_WINDOW_HOURS   → notify
 *   key_mismatch   the repository no longer opens with this box's key → notify
 *   not_reporting  no status file (dev host, or the host side is not installed)
 *
 * `overdue` is computed from time, not from the last run's outcome — so a
 * timer that stopped firing entirely (the failure no log line records) still
 * trips it. The window anchor before any success is `since`, which the host
 * writes on first contact (setup.sh runs `--check-key`).
 *
 * Notification: one per outage, not one per tick. Same record-as-dedupe
 * device as tls-notify: a NotificationLog row with this title created after
 * the last successful backup means this outage was already announced. The next
 * success moves the anchor, so a LATER outage is announced again. No schema.
 */
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { sendNotification } from "./notifications.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("backup-health");

/** The daily timer fires at 03:15 (+≤15 min jitter, Persistent=true). One
 *  missed night is tolerated; the second is an outage. */
export const BACKUP_WINDOW_HOURS = 48;

export const BACKUP_STATUS_FILE =
  process.env.DROPLET_BACKUP_STATUS_FILE ?? "/var/lib/droplet/backup-status/status.json";

export const BACKUP_STOPPED_TITLE = "Your Droplet's backups have stopped";

const HOST_STATES = ["ok", "failed", "key_mismatch", "pending"] as const;
export type HostBackupState = (typeof HOST_STATES)[number];

export interface HostBackupStatus {
  state: HostBackupState;
  reason: string;
  since: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastRekeyAt: string | null;
}

export type BackupHealth = "healthy" | "pending" | "failing" | "overdue" | "key_mismatch" | "not_reporting";

export interface BackupHealthView {
  health: BackupHealth;
  /** True for the states that page the owner. */
  alerting: boolean;
  reason: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastAttemptAt: string | null;
  lastRekeyAt: string | null;
  windowHours: number;
}

/** Parse the host file. Anything unreadable or off-contract is `null`
 *  (→ not_reporting), never a guessed state. */
export function parseHostStatus(raw: string): HostBackupStatus | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!HOST_STATES.includes(j.state as HostBackupState)) return null;
  const ts = (k: string): string | null => {
    const v = j[k];
    return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
  };
  return {
    state: j.state as HostBackupState,
    reason: typeof j.reason === "string" ? j.reason : "",
    since: ts("since"),
    lastAttemptAt: ts("lastAttemptAt"),
    lastSuccessAt: ts("lastSuccessAt"),
    lastFailureAt: ts("lastFailureAt"),
    lastRekeyAt: ts("lastRekeyAt"),
  };
}

export async function readHostStatus(file: string = BACKUP_STATUS_FILE): Promise<HostBackupStatus | null> {
  try {
    return parseHostStatus(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Pure: the host status + the clock → one health value. */
export function backupHealth(s: HostBackupStatus | null, now: Date = new Date()): BackupHealthView {
  const base = {
    reason: s?.reason || null,
    lastSuccessAt: s?.lastSuccessAt ?? null,
    lastFailureAt: s?.lastFailureAt ?? null,
    lastAttemptAt: s?.lastAttemptAt ?? null,
    lastRekeyAt: s?.lastRekeyAt ?? null,
    windowHours: BACKUP_WINDOW_HOURS,
  };
  if (!s) return { ...base, health: "not_reporting", alerting: false };
  if (s.state === "key_mismatch") return { ...base, health: "key_mismatch", alerting: true };

  const anchor = s.lastSuccessAt ?? s.since;
  const inWindow = anchor !== null && now.getTime() - Date.parse(anchor) <= BACKUP_WINDOW_HOURS * 3_600_000;
  if (!inWindow) return { ...base, health: "overdue", alerting: true };

  const health: BackupHealth = s.state === "ok" ? "healthy" : s.state === "failed" ? "failing" : "pending";
  return { ...base, health, alerting: false };
}

export function backupStoppedBody(v: BackupHealthView): string {
  const last = v.lastSuccessAt
    ? `The last successful backup was on ${new Date(v.lastSuccessAt).toUTCString()}.`
    : "It has not completed a backup yet.";
  const why =
    v.health === "key_mismatch"
      ? "The backup store no longer opens with this Droplet's key — usually after its secrets were reset."
      : v.reason
        ? `The last attempt failed while ${v.reason}.`
        : `No backup has completed in the last ${BACKUP_WINDOW_HOURS} hours.`;
  return `${why} ${last} Your files are safe on the Droplet, but they are not being backed up. Contact Droplet support to get backups running again.`;
}

export interface BackupHealthCheck {
  runOnce(): Promise<BackupHealthView>;
}

export function createBackupHealthCheck(deps: {
  prisma: PrismaClient;
  readStatus?: () => Promise<HostBackupStatus | null>;
  now?: () => Date;
}): BackupHealthCheck {
  const { prisma } = deps;
  const readStatus = deps.readStatus ?? (() => readHostStatus());
  const now = deps.now ?? (() => new Date());

  return {
    async runOnce() {
      const status = await readStatus();
      const view = backupHealth(status, now());
      if (!view.alerting) return view;

      // One notification per outage: anything newer than the last success
      // (or, before any success, than first contact) is this outage's.
      const anchor = status?.lastSuccessAt ?? status?.since ?? null;
      const already = await prisma.notificationLog.findFirst({
        where: {
          kind: "system",
          title: BACKUP_STOPPED_TITLE,
          ...(anchor ? { createdAt: { gt: new Date(anchor) } } : {}),
        },
        select: { id: true },
      });
      if (already) return view;

      const users = await prisma.user.findMany({
        where: { role: { in: ["owner", "admin"] } },
        select: { username: true },
      });
      const body = backupStoppedBody(view);
      for (const { username } of users) {
        await sendNotification(prisma, { username, kind: "system", title: BACKUP_STOPPED_TITLE, body, url: "/settings" });
      }
      logger.warn({ health: view.health, recipients: users.length }, "backup-health: backups stopped — owner notified");
      return view;
    },
  };
}
