/**
 * WARP-1044 — GC of exited droplet-ota-self-swap-<id> helper containers
 * (follow-up to the WARP-539 self-swap forensics decision).
 *
 * The detached self-swap helper (apply-update.sh, recreate-self-detached)
 * deliberately runs WITHOUT `--rm`: on an unattended fleet its logs are the
 * ONLY forensic trail when the rollback itself fails. The collision guard
 * reaps the previous helper for the SAME update id on a retry — but nothing
 * ever removes helpers from OLDER update ids, so every applied update leaves
 * one exited container behind forever. This is the cross-update-id janitor,
 * wired into the same daily 03:00 purge cron as purgeUpdateBackups and using
 * the same 7-day retention window.
 *
 * Safety rules (all enforced below, tested in purge-self-swap-helpers.test.ts):
 *   1. Only containers in status "exited" are ever considered — a running
 *      helper is mid-swap/mid-rollback and is NEVER touched (and the script's
 *      `docker rm` without -f means the daemon refuses one anyway).
 *   2. A helper whose update id has a NON-terminal DeviceUpdate row
 *      (pending/verifying/applying) is never touched, no matter how old —
 *      that id is in flight and its helper is live forensic state.
 *   3. Age is the container's own exit time (State.FinishedAt), older than
 *      the retention window (default 7 days, mirroring the backup GC).
 *   4. Logs are captured into <updatesDir>/<id>/self-swap-helper.log BEFORE
 *      the container is removed — the kept container was the only log store
 *      (WARP-539 persists nothing else) — and the capture is skipped when
 *      that file already exists (a prior sweep captured but failed the rm).
 *   5. Everything docker-side is best-effort: a failed listing skips the
 *      sweep, a failed capture/rm logs a warn and moves to the next helper.
 *      A docker hiccup must never crash the daily purge cron.
 *
 * The docker surface rides the SAME single audited host script as the apply
 * path (scripts/lib/apply-update.sh — fixed subcommands, argv arrays, never
 * a shell string): list-self-swap-helpers / capture-self-swap-logs /
 * rm-self-swap-helper. Nothing here talks to the socket directly.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { createLogger } from "../../lib/logger.js";
import { defaultExec, type ExecFn } from "./host-compose-runner.js";
import { TERMINAL_UPDATE_STATUSES } from "./purge-update-backups.js";

const defaultLog = createLogger("update-agent");

/** Container-name prefix the self-swap launch pins (apply-update.sh). */
export const SELF_SWAP_HELPER_PREFIX = "droplet-ota-self-swap-";

/** Every subcommand here is a quick daemon round-trip. */
const EXEC_TIMEOUT_MS = 60_000;

export interface PurgeSelfSwapHelpersOptions {
  /** Absolute path to the host helper (scripts/lib/apply-update.sh). */
  scriptPath: string;
  /** Container path holding <updateId>/ state dirs (log capture target). */
  updatesDir: string;
  /** Helpers exited longer ago than this are removed. Default 7 —
   *  the same window purgeUpdateBackups uses for backup/ trees. */
  retentionDays?: number;
  exec?: ExecFn;
  logger?: pino.Logger;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface PurgeSelfSwapHelpersResult {
  /** Number of helper containers removed. */
  removed: number;
  /** Number of helpers whose logs were captured before removal. */
  logsCaptured: number;
}

/** One line of `list-self-swap-helpers` output. */
interface HelperListing {
  updateId: string;
  status: string;
  finishedAt: string;
}

/**
 * Parse the listing (one JSON object per line). Lines that are not valid
 * JSON or do not carry the helper name prefix are skipped — the daemon is
 * the source here, but a foreign/renamed container must never be our call
 * to touch.
 */
function parseHelperListing(stdout: string): HelperListing[] {
  const helpers: HelperListing[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { name?: unknown; status?: unknown; finishedAt?: unknown };
    try {
      parsed = JSON.parse(trimmed) as typeof parsed;
    } catch {
      continue;
    }
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.finishedAt !== "string"
    ) {
      continue;
    }
    // docker inspect reports names with a leading slash.
    const name = parsed.name.replace(/^\//, "");
    if (!name.startsWith(SELF_SWAP_HELPER_PREFIX)) continue;
    const updateId = name.slice(SELF_SWAP_HELPER_PREFIX.length);
    if (!updateId) continue;
    helpers.push({ updateId, status: parsed.status, finishedAt: parsed.finishedAt });
  }
  return helpers;
}

/**
 * Remove every EXITED droplet-ota-self-swap-<id> helper container whose exit
 * time is older than the retention window and whose update id is not in
 * flight, capturing `docker logs` into <updatesDir>/<id>/self-swap-helper.log
 * first (unless already captured). Returns counts for the cron's summary
 * log line.
 */
export async function purgeSelfSwapHelpers(
  prisma: PrismaClient,
  opts: PurgeSelfSwapHelpersOptions,
): Promise<PurgeSelfSwapHelpersResult> {
  const log = opts.logger ?? defaultLog;
  const retentionDays = opts.retentionDays ?? 7;
  const exec = opts.exec ?? defaultExec();
  const now = opts.now ? opts.now() : Date.now();

  let listing: string;
  try {
    ({ stdout: listing } = await exec(opts.scriptPath, ["list-self-swap-helpers"], {
      timeoutMs: EXEC_TIMEOUT_MS,
    }));
  } catch (err) {
    // A docker hiccup must not crash the daily purge — skip this sweep.
    log.warn(
      {
        event: "update.self_swap_helper_list_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "OTA helper GC could not list self-swap containers — skipping this sweep",
    );
    return { removed: 0, logsCaptured: 0 };
  }

  const helpers = parseHelperListing(listing);
  if (helpers.length === 0) return { removed: 0, logsCaptured: 0 };

  // In-flight update ids: any row NOT in a terminal status. Its helper is
  // live forensic state (rule 2) — never touched, no matter how old.
  const inFlight = new Set(
    (
      await prisma.deviceUpdate.findMany({
        where: { status: { notIn: [...TERMINAL_UPDATE_STATUSES] } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  const cutoff = now - retentionDays * 86400_000;
  let removed = 0;
  let logsCaptured = 0;
  for (const helper of helpers) {
    if (helper.status !== "exited") continue; // rule 1 — running et al.
    if (inFlight.has(helper.updateId)) continue; // rule 2
    const finishedAt = Date.parse(helper.finishedAt);
    // An exited container always carries a real FinishedAt; anything
    // unparseable (or docker's 0001-01-01 zero value) is kept, not guessed at.
    if (!Number.isFinite(finishedAt) || finishedAt <= 0) continue;
    if (finishedAt >= cutoff) continue; // rule 3 — inside the window

    try {
      const logPath = path.join(opts.updatesDir, helper.updateId, "self-swap-helper.log");
      if (!existsSync(logPath)) {
        // Rule 4 — the container is the only log store; persist before rm.
        await exec(
          opts.scriptPath,
          ["capture-self-swap-logs", "--update-id", helper.updateId],
          { timeoutMs: EXEC_TIMEOUT_MS },
        );
        logsCaptured += 1;
      }
      await exec(opts.scriptPath, ["rm-self-swap-helper", "--update-id", helper.updateId], {
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      removed += 1;
    } catch (err) {
      // Rule 5 — one wedged helper must not abort the sweep for the rest.
      log.warn(
        {
          event: "update.self_swap_helper_purge_failed",
          deviceUpdateId: helper.updateId,
          err: err instanceof Error ? err.message : String(err),
        },
        "OTA helper GC could not reap a self-swap container — leaving it for the next sweep",
      );
    }
  }

  if (removed > 0) {
    log.info(
      { event: "update.self_swap_helper_purged", removed, logsCaptured, retentionDays },
      "OTA helper GC removed exited self-swap containers past retention",
    );
  }
  return { removed, logsCaptured };
}
