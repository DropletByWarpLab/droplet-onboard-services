import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { requireRole } from "../middleware/auth.js";
import { EXPIRY_WARNING_DAYS } from "../services/tls-issuance.service.js";

/**
 * WARP-2944 (ADR-058 slice 7) — the certificate lifecycle, for the owner.
 *
 * The public `GET /api/tls/status` carries the minimum a plain-HTTP status
 * page needs before any login exists (state, CT-public FQDN, whether HQ is
 * configured). Settings → Device information needs more — how long the
 * current certificate has left, when the box will renew it, whether renewal
 * is failing — and that is an OWNER's view: authenticated, `owner`/`admin`,
 * mounted after authMiddleware like the settings router. Read-only; it reads
 * the same state row the daily tls-issuance tick maintains and adds no
 * polling of its own.
 *
 * `daysLeft` / `renewsInDays` are computed here, once, so the dashboard card
 * and the screen never disagree on the arithmetic: renewal starts inside the
 * last 30 days (tls-issuance RENEW_THRESHOLD_DAYS); the owner is warned
 * inside the last EXPIRY_WARNING_DAYS.
 */
const RENEW_THRESHOLD_DAYS = 30;

export interface TlsCertificateView {
  state: string;
  fqdn: string | null;
  notAfter: string | null;
  /** Whole days until `notAfter`; null without a public certificate. */
  daysLeft: number | null;
  /** Whole days until the box starts renewing on its own (0 = now). */
  renewsInDays: number | null;
  /** True inside the last EXPIRY_WARNING_DAYS — what the card and screen warn on. */
  expiringSoon: boolean;
  hqConfigured: boolean;
  /** When the state row last changed — the last tick that touched it. */
  checkedAt: string | null;
}

export function certificateView(
  row: { state: string; fqdn: string | null; notAfter: Date | null; updatedAt?: Date | null } | null,
  now: Date = new Date(),
): TlsCertificateView {
  const state = row?.state ?? "BOOTSTRAP_SELF_SIGNED";
  const fqdn = row?.fqdn || config.DROPLET_PUBLIC_FQDN || null;
  const notAfter = row?.notAfter ?? null;
  const daysLeft = notAfter ? Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000) : null;
  return {
    state,
    fqdn,
    notAfter: notAfter ? notAfter.toISOString() : null,
    daysLeft,
    renewsInDays: daysLeft === null ? null : Math.max(0, daysLeft - RENEW_THRESHOLD_DAYS),
    expiringSoon: daysLeft !== null && daysLeft < EXPIRY_WARNING_DAYS,
    hqConfigured: Boolean(config.HQ_ISSUANCE_URL),
    checkedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export function createTlsCertificateRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/tls/certificate", requireRole("owner", "admin"), async (_req, res) => {
    const row = await prisma.tlsCert.findFirst({ orderBy: { updatedAt: "desc" } });
    res.json(certificateView(row));
  });

  return router;
}
