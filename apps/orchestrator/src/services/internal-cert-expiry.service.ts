/**
 * WARP-3653 -- days left on this box's internal CA leaf certificate.
 *
 * Every internal bundle is issued together and renewed by the same daily host
 * pass (scripts/host/droplet-renew-internal-certs.sh), so this container's own
 * bundle is the representative reading: the orchestrator mounts only its own
 * (data/secrets/service-tls/orchestrator -> /data/service-tls). `null` means
 * there is no readable certificate (a dev host, or setup has not run), never 0.
 */
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { config } from "../config.js";

const DAY_MS = 86_400_000;
const CACHE_MS = 10 * 60_000;

/** Pure: whole days until notAfter, negative once expired. Null when unparseable. */
export function daysLeftFromPem(pem: string, now: Date = new Date()): number | null {
  try {
    return Math.floor((new Date(new X509Certificate(pem).validTo).getTime() - now.getTime()) / DAY_MS);
  } catch {
    return null;
  }
}

let cache: { at: number; days: number | null } | null = null;

export async function internalCertDaysLeft(now: Date = new Date()): Promise<number | null> {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.days;
  let days: number | null = null;
  try {
    days = daysLeftFromPem(await readFile(config.DROPLET_TLS_CERT, "utf8"), now);
  } catch {
    days = null;
  }
  cache = { at: now.getTime(), days };
  return days;
}
