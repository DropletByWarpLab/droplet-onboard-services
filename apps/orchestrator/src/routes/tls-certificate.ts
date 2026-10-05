import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { servedCertFingerprint, servedCertMetadata } from "../lib/served-cert-pin.js";
import { config } from "../config.js";
const EXPIRY_WARNING_DAYS = 7;

/** Read-only certificate metadata and served-key fingerprint for owners.
 * Read the installed leaf, since historical fleet rows may describe an old cert.
 * This deployment uses local TLS and does not schedule HQ renewal. */
export interface TlsCertificateView {
  state: string;
  fqdn: string | null;
  notAfter: string | null;
  /** Whole days until the installed leaf expires; null when unreadable. */
  daysLeft: number | null;
  /** Retained compatibility field; no automatic fleet renewal is scheduled. */
  renewsInDays: number | null;
  /** True inside the last EXPIRY_WARNING_DAYS — what the card and screen warn on. */
  expiringSoon: boolean;
  hqConfigured: boolean;
  /** When the installed certificate file was last updated. */
  checkedAt: string | null;
  /** WARP-3414: SHA-256 of the served leaf's DER SPKI, uppercase hex in
   *  16 groups of 4 (`F017 AFA8 …`); null when the leaf is unreadable. */
  fingerprint: string | null;
  coversInternalHostname: boolean | null;
}

export function certificateView(
  row: { state: string; fqdn: string | null; notAfter: Date | null; updatedAt?: Date | null; coversInternalHostname?: boolean | null } | null,
  now: Date = new Date(),
  fingerprint: string | null = null,
): TlsCertificateView {
  const state = row?.state ?? "UNKNOWN";
  const fqdn = row?.fqdn || null;
  const notAfter = row?.notAfter ?? null;
  const daysLeft = notAfter ? Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000) : null;
  return {
    state,
    fqdn,
    notAfter: notAfter ? notAfter.toISOString() : null,
    daysLeft,
    renewsInDays: null,
    expiringSoon: daysLeft !== null && daysLeft < EXPIRY_WARNING_DAYS,
    hqConfigured: false,
    checkedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    fingerprint,
    coversInternalHostname: row?.coversInternalHostname ?? null,
  };
}

export function createTlsCertificateRouter(_prisma: PrismaClient): Router {
  const router = Router();

  router.get("/tls/certificate", requireRole("owner", "admin"), async (_req, res) => {
    const row = servedCertMetadata(config.DROPLET_LAN_HOSTNAME);
    res.json(certificateView(row, new Date(), servedCertFingerprint()));
  });

  return router;
}
