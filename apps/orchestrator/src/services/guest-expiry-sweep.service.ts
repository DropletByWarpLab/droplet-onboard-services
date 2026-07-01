/**
 * WARP-455 — guest-expiry-sweep cron worker.
 *
 * Nightly at 03:15 (wired through cron-runtime.service.ts in
 * src/index.ts) this sweep:
 *
 *   1. SELECTs every GuestExpiry row where status=ACTIVE AND
 *      expiresAt < now(). The composite index
 *      (status, expiresAt) on GuestExpiry makes this O(matches).
 *   2. For each row, flips status=EXPIRED with expiredAt=now(),
 *      then emits an `auth`-kind ActivityRow naming the user.
 *
 * Per the no-guessing rule (CLAUDE.md): we never derive expiry state
 * from `expiresAt < now()` at read time. The status column is the
 * canonical truth; this worker is the single writer that moves rows
 * into the EXPIRED bucket.
 *
 * Idempotency: re-running on a converged state walks zero ACTIVE rows
 * past `expiresAt`, emits zero ActivityRows, and writes nothing. The
 * controller brief explicitly calls this out — re-runnable on the same
 * tick is the WARP-446 / WARP-218 hygiene.
 *
 * Best-effort audit: a recordActivity failure on one row does NOT
 * abort the batch. Losing one audit row is acceptable; leaving the
 * entire batch ACTIVE because the recorder hiccupped is not. The
 * same posture activity.service's `recordSafely` and the auth route's
 * swallow-on-warn already use.
 *
 * JWT denylist note (handoff): the JWT denylist in jwt.service is
 * keyed on the refresh-token hash — the cron doesn't have the
 * guest's tokens in hand. The fail-safe is the 15-minute access-token
 * TTL: a guest whose row flipped to EXPIRED is locked out within at
 * most 15 minutes when their JWT can't refresh (the refresh handler
 * looks up the user; a follow-up ticket adds a User.role=guest +
 * GuestExpiry.status=EXPIRED short-circuit there). Wiring the full
 * live-revoke surface is intentionally scoped out of WARP-455 — the
 * 15-min ceiling is acceptable for a household-tier guest.
 */
import type { PrismaClient } from "@prisma/client";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("guest-expiry-sweep");

export interface SweepResult {
  /** How many rows transitioned ACTIVE → EXPIRED on this tick. */
  expired: number;
}

/**
 * Run one tick of the sweep. `now` is injected so tests can drive the
 * clock; production callers pass `new Date()`.
 */
export async function sweepExpiredGuests(
  prisma: PrismaClient,
  now: Date,
): Promise<SweepResult> {
  // Composite index (status, expiresAt) on GuestExpiry makes the
  // query a simple range scan over the small ACTIVE partition. The
  // include is small (just the User row) and avoids a follow-up
  // findUnique per match.
  const candidates = await prisma.guestExpiry.findMany({
    where: {
      status: "ACTIVE",
      expiresAt: { lt: now },
    },
    include: { user: true },
  });

  if (candidates.length === 0) {
    return { expired: 0 };
  }

  let flipped = 0;
  for (const row of candidates) {
    try {
      await prisma.guestExpiry.update({
        where: { id: row.id },
        data: {
          status: "EXPIRED",
          expiredAt: now,
        },
      });
      flipped += 1;
    } catch (err) {
      // Update failed (Prisma P2025 if the row was deleted between
      // our findMany and update, or a connection blip). Log and
      // continue — the next tick picks it up.
      logger.error(
        { err, id: row.id, userId: row.userId },
        "failed to flip guest expiry row",
      );
      continue;
    }

    // Best-effort audit. recordActivity itself swallows recorder
    // failures (recordSafely in activity.service); the try/catch
    // here belts-and-braces the contract so even a recorder-throw
    // doesn't abort the for loop.
    try {
      await recordActivity({
        kind: "auth",
        severity: "warn",
        sourceIcon: "clock-x",
        what: "Guest expired",
        sub: row.user?.username ?? row.userId,
        refs: {
          targetUserId: row.userId,
          targetUsername: row.user?.username ?? null,
          expiresAt: row.expiresAt.toISOString(),
          expiredAt: now.toISOString(),
        },
      });
    } catch (err) {
      logger.warn(
        { err, id: row.id, userId: row.userId },
        "ActivityRow emit failed (row already flipped, continuing)",
      );
    }
  }

  logger.info(
    { expired: flipped, examined: candidates.length },
    "guest-expiry-sweep tick complete",
  );
  return { expired: flipped };
}
