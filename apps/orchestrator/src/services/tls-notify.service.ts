/**
 * WARP-2944 (ADR-058 slice 7) — the certificate lifecycle reaches the owner.
 *
 * The daily tls-issuance tick already knows when renewal starts failing and
 * how long the current certificate has left; until now that knowledge went to
 * the log and nowhere an owner looks. This is the `TlsNotifier` the tick
 * calls (see tls-issuance.service.ts for WHEN — the transition rule lives
 * there); this file decides WHO hears it and says it in the owner's words.
 *
 * Recipients: every owner and admin, keyed by `User.username` — the
 * notification subsystem publishes to `droplet/notifications/${username}`
 * and both readers of NotificationLog filter by username (see the note in
 * audit-verify.service.ts; the id-keyed path is WARP-2910/2911's job, and a
 * notification keyed the other way reaches nobody today).
 *
 * Dedupe for `expiringSoon`: at most one notification per certificate. The
 * tick calls it daily inside the last week; the log row itself is the record
 * — a row with this title newer than `notAfter − 7d` means this certificate's
 * warning already went out. No schema column, no migration.
 */

import type { PrismaClient } from "@prisma/client";
import { sendNotification } from "./notifications.service.js";
import { EXPIRY_WARNING_DAYS, type TlsNotifier } from "./tls-issuance.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tls-notify");

export const TLS_RENEW_FAILED_TITLE = "Your Droplet couldn't renew its security certificate";
export const TLS_EXPIRING_TITLE = "Your Droplet's security certificate expires soon";

/** The one action that helps, in the owner's words. Shared with the
 *  dashboard card so the two never disagree. */
export const TLS_RENEW_ACTION =
  "Make sure the Droplet has a working internet connection — it renews on its own once it can reach the certificate service. " +
  "A Droplet needs outbound internet at least once every 60 days to keep its padlock.";

export function renewFailedBody(daysLeft: number | null): string {
  const left =
    daysLeft === null
      ? "It is still serving its current certificate."
      : daysLeft > 0
        ? `It is still serving its current certificate, which is valid for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}.`
        : "Its current certificate has expired, so browsers will warn until this is fixed; the Droplet apps keep working through their pairing.";
  return `${left} ${TLS_RENEW_ACTION}`;
}

export function expiringSoonBody(daysLeft: number): string {
  const when = daysLeft <= 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  return `The certificate for your Droplet's web address expires ${when} and has not been renewed yet. ${TLS_RENEW_ACTION}`;
}

export function createTlsNotifier(prisma: PrismaClient): TlsNotifier {
  async function recipients(): Promise<string[]> {
    const rows = await prisma.user.findMany({
      where: { role: { in: ["owner", "admin"] } },
      select: { username: true },
    });
    return rows.map((r) => r.username);
  }

  async function fanOut(title: string, body: string): Promise<void> {
    const users = await recipients();
    for (const username of users) {
      await sendNotification(prisma, { userId: username, kind: "system", title, body });
    }
    logger.info({ title, recipients: users.length }, "tls-notify: sent");
  }

  return {
    async renewFailed({ fqdn, daysLeft }) {
      logger.warn({ fqdn, daysLeft }, "tls-notify: renewal failing — telling the owner");
      await fanOut(TLS_RENEW_FAILED_TITLE, renewFailedBody(daysLeft));
    },

    async expiringSoon({ fqdn, notAfter, daysLeft }) {
      const windowStart = new Date(new Date(notAfter).getTime() - EXPIRY_WARNING_DAYS * 86_400_000);
      const already = await prisma.notificationLog.findFirst({
        where: {
          kind: "system",
          title: TLS_EXPIRING_TITLE,
          createdAt: { gte: windowStart },
        },
        select: { id: true },
      });
      if (already) return;
      logger.warn({ fqdn, notAfter, daysLeft }, "tls-notify: certificate expiring — telling the owner");
      await fanOut(TLS_EXPIRING_TITLE, expiringSoonBody(daysLeft));
    },
  };
}
