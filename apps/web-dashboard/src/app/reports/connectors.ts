/**
 * WARP-1994 — connector presentation rules, kept out of the component so the
 * two that carry real meaning are testable on their own: which pill a status
 * gets, and what order the rows come in.
 */

import type { IntegrationStatusName } from "./api";

export interface PillSpec {
  label: string;
  /** CSS modifier on `.rp-pill`. */
  tone: "ok" | "warn" | "bad" | "accent" | "muted";
  /** lucide icon name resolved by the component. */
  icon: "check" | "warn" | "lock" | "refresh" | "plug" | "key";
}

/**
 * All nine states get their own treatment. Collapsing DEGRADED into ERROR,
 * or DISABLED into NOT_CONFIGURED, loses the distinction that tells a user
 * whether to fix something or whether they turned it off on purpose.
 */
export const PILL: Record<IntegrationStatusName, PillSpec> = {
  CONNECTED: { label: "Connected", tone: "ok", icon: "check" },
  // WARP-2623 — connected, one dataset refused. Same wording as the hub tile
  // (`connector-visuals.tsx`) so one connection reads the same in both places.
  // `warn`, not `bad`: nothing is broken, and a red pill on a connector that
  // is syncing correctly is the "Can't connect" lie this ticket removed.
  CAPABILITY_LIMITED: { label: "Connected · limited", tone: "warn", icon: "warn" },
  DEGRADED: { label: "Needs attention", tone: "warn", icon: "warn" },
  DRIFT_LOCKED: { label: "Locked — schema changed", tone: "bad", icon: "lock" },
  NEEDS_RECONNECT: { label: "Paste a new key", tone: "warn", icon: "key" },
  ERROR: { label: "Can't connect", tone: "bad", icon: "warn" },
  PROVISIONING: { label: "Setting up", tone: "accent", icon: "refresh" },
  DISABLED: { label: "Turned off", tone: "muted", icon: "plug" },
  NOT_CONFIGURED: { label: "Not connected", tone: "muted", icon: "plug" },
};

/**
 * Sort weight — problems first. A user should never have to hunt for the
 * broken one, and the alphabetical default buries it behind whatever
 * happens to be connected.
 */
const WEIGHT: Record<IntegrationStatusName, number> = {
  ERROR: 0,
  DRIFT_LOCKED: 1,
  // Above DEGRADED: a transient throttle clears itself, a revoked credential
  // never does — it waits for a person, so it is the more urgent of the two.
  NEEDS_RECONNECT: 2,
  DEGRADED: 3,
  // WARP-2623 — below the problems and above CONNECTED. It is not a problem:
  // the connection works and no retry, key or support call changes it. But it
  // is the one healthy state that still carries a fact the owner has not seen,
  // so it sorts ahead of the connectors with nothing to say.
  CAPABILITY_LIMITED: 4,
  CONNECTED: 5,
  PROVISIONING: 6,
  DISABLED: 7,
  NOT_CONFIGURED: 8,
};

export function statusWeight(s: IntegrationStatusName): number {
  // An unrecognised status from a newer box sorts with the problems rather
  // than last: something we can't classify is worth a look, not a burial.
  return WEIGHT[s] ?? 0;
}

/** Provider key → display name. Unknown keys are title-cased rather than
 *  dropped, so a connector added server-side still reads sensibly. */
const NAMES: Record<string, string> = {
  eaglesoft: "Eaglesoft (direct SQL)",
  "eaglesoft-api": "Eaglesoft API",
  "eaglesoft-export": "Eaglesoft (export)",
  "dentrix-export": "Dentrix (export)",
  "opendental-export": "Open Dental (export)",
};

export function providerName(provider: string): string {
  const known = NAMES[provider];
  if (known) return known;
  return provider
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Two-letter mark for the tile's provider square. */
export function providerMark(provider: string): string {
  const base = provider.split(/[-_]/)[0] ?? provider;
  return base.slice(0, 2).toUpperCase();
}

/**
 * "2 min ago" / "3 days ago" / null when never synced.
 *
 * Returns null rather than a placeholder so the caller decides the copy —
 * "Never connected" reads very differently from "synced —".
 */
export function relativeSince(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.floor((now.getTime() - then) / 1000);
  // A clock skew that puts the sync slightly in the future reads as "just
  // now", not as a negative duration.
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The row's one-line status. Deliberately does NOT invent a sync time for a
 * connector that has never synced — brief §9's rule applied at row level.
 */
export function statusLine(
  c: { status: IntegrationStatusName; writeEnabled: boolean; lastSyncedAt: string | null },
  now: Date,
): string {
  const rel = relativeSince(c.lastSyncedAt, now);
  const access = c.writeEnabled ? "read-write" : "read-only";
  if (c.status === "NOT_CONFIGURED") return "Never connected";
  if (c.status === "DISABLED") return rel ? `Turned off · last synced ${rel}` : "Turned off";
  if (c.status === "PROVISIONING") return "Setting up · first sync pending";
  if (!rel) return `${PILL[c.status].label} · never synced`;
  return `Synced ${rel} · ${access}`;
}
