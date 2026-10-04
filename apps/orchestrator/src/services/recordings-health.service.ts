/**
 * WARP-3514 / ADR-070 — the hourly recordings-health check: ONE owner/admin
 * notification per outage, never one per tick (pattern of backup-health.service.ts).
 *
 * It judges the SAME facts the API shows (`deriveRecordingsWarnings`), so the page
 * and the alert can never disagree: missing drive, read-only drive, recordings on
 * the OS disk (even with zero cameras and no allocation), nearly full, cannot
 * grow, SMART failed, not encrypted.
 *
 * Outage state is PERSISTED (`RecordingsAlertState`), unlike the in-process
 * near-full edge in camera-storage.service.ts: these conditions last for days and
 * an orchestrator restart must not re-page the owner for each of them. A LATER
 * outage is announced again because recovery clears `notifiedAt`.
 *
 * If the host cannot be asked, NOTHING changes: an unreachable bridge is neither
 * an outage of the drive nor a recovery from one.
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";
import { deriveRecordingsWarnings, RECORDINGS_WARNING_MESSAGES } from "./recordings-overview.js";
import type { RecordingsFacts, RecordingsWarningCode } from "./recordings.types.js";

const logger = createLogger("recordings-health");

type HealthDb = Pick<PrismaClient, "recordingsAlertState">;

const CODES = [
  ["DRIVE_MISSING", "drive_missing"],
  ["READ_ONLY", "read_only"],
  ["ON_SYSTEM_DISK", "on_system_disk"],
  ["NEAR_FULL", "near_full"],
  ["CANNOT_GROW", "cannot_grow"],
  ["SMART_FAILED", "smart_failed"],
  ["NOT_ENCRYPTED", "not_encrypted"],
] as const satisfies ReadonlyArray<readonly [string, RecordingsWarningCode]>;

export const RECORDINGS_ALERT_TITLES: Readonly<Record<RecordingsWarningCode, string>> = Object.freeze({
  drive_missing: "The drive that holds your camera recordings is missing",
  read_only: "Your camera recordings drive is read-only",
  on_system_disk: "Camera recordings are on the system drive",
  near_full: "The space for camera recordings is almost full",
  cannot_grow: "Droplet could not make more room for camera recordings",
  smart_failed: "The camera recordings drive is failing",
  not_encrypted: "The camera recordings drive is not encrypted",
});

export interface RecordingsHealthDeps {
  prisma: HealthDb;
  collectFacts: () => Promise<RecordingsFacts>;
  /** Returns who was notified; an empty list means nobody got it and the alert is retried next hour. */
  notifyOwners: (title: string, body: string) => Promise<{ notified: string[] }>;
  now?: () => Date;
}

export interface RecordingsHealthResult {
  raised: RecordingsWarningCode[];
  cleared: RecordingsWarningCode[];
  /** True when the host could not be asked and nothing was changed. */
  skipped: boolean;
}

export interface RecordingsHealthCheck {
  runOnce(): Promise<RecordingsHealthResult>;
}

export function createRecordingsHealthCheck(deps: RecordingsHealthDeps): RecordingsHealthCheck {
  const { prisma, collectFacts, notifyOwners } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async runOnce() {
      const facts = await collectFacts();
      if (facts.hostError !== null || facts.drivesError !== null) {
        logger.warn({ hostError: facts.hostError, drivesError: facts.drivesError }, "recordings health skipped — the device-bridge cannot be asked");
        return { raised: [], cleared: [], skipped: true };
      }

      const active = new Set(deriveRecordingsWarnings(facts).map((w) => w.code));
      const states = new Map((await prisma.recordingsAlertState.findMany()).map((s) => [s.code, s]));
      const at = now();
      const raised: RecordingsWarningCode[] = [];
      const cleared: RecordingsWarningCode[] = [];

      for (const [dbCode, code] of CODES) {
        const state = states.get(dbCode);
        if (active.has(code)) {
          if (state?.active === true && state.notifiedAt !== null) continue; // this outage was already announced
          const result = await notifyOwners(RECORDINGS_ALERT_TITLES[code], RECORDINGS_WARNING_MESSAGES[code]);
          // notifiedAt only when somebody actually got it — otherwise the next tick retries.
          const notifiedAt = result.notified.length > 0 ? at : null;
          const since = state?.active === true && state.since !== null ? state.since : at;
          await prisma.recordingsAlertState.upsert({
            where: { code: dbCode },
            create: { code: dbCode, active: true, since, notifiedAt },
            update: { active: true, since, notifiedAt },
          });
          raised.push(code);
          logger.warn({ code, recipients: result.notified.length }, "recordings health: outage announced");
        } else if (state?.active === true) {
          await prisma.recordingsAlertState.update({
            where: { code: dbCode },
            data: { active: false, since: null, notifiedAt: null },
          });
          cleared.push(code);
        }
      }
      return { raised, cleared, skipped: false };
    },
  };
}
