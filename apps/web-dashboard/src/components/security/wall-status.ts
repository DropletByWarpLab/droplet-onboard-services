/**
 * WARP-2981 (ADR-059 P6, §3.8) — the Security wall's copy and its pure rules.
 *
 * The wall is a TV in a room, left on for hours with nobody watching it, so
 * three rules shape everything here:
 *
 *   1. Never a number it has not been given. Before a read's first answer a
 *      cell shows "—", never 0; after a failure the last answer stays, dimmed,
 *      under a banner that names its time.
 *   2. "Nothing happened" and "nothing is reporting" never look the same. The
 *      needs-attention count says when it may be behind; the sources cell
 *      names the sources that are not reporting and never claims more than
 *      "All reporting" (about the sources, not about the site).
 *   3. Everything is this viewer's own projection (DS-005): the wall reads
 *      what /security already shows them, and names nobody.
 *
 * Every string a person reads on the wall is in `WALL_COPY` (plain strings,
 * `{slot}`s filled by ModeCard's `fill`), so the Security copy lint scans it.
 */
import type { SecurityHealthRow } from "@/lib/types";
import { fill } from "./ModeCard";

export const WALL_COPY = {
  // Plain words: "wall" is our name for it, not the person's.
  link: "TV view",
  // D6: the tier is tierLabel("family"), pinned in wall-status.test.
  linkTitle: "A full-screen view for a TV signed in with a Staff account. It shows that account's cameras.",
  heading: "Security TV view",
  leave: "Back to Security",
  fullScreen: "Full screen",
  exitFullScreen: "Leave full screen",
  stripLabel: "Security status",

  camerasConnecting: "Connecting to the cameras…",
  // No camera granted to this account (or Cameras not open to it): the account is the fix, not the box.
  camerasNone: "This account can't see any cameras yet",
  camerasNoneBody: "Someone who manages Droplet can choose which cameras it shows, on the Users page.",
  camerasLost: "The camera list isn't coming through.",
  camerasLostBody: "Droplet keeps trying. The status below still updates.",
  // One tile per camera; {camera} is the name the household gave it.
  tileAlt: "{camera}, latest picture",
  tileConnecting: "Connecting…",
  tileLost: "No picture yet. Droplet keeps trying.",
  tileStale: "Picture from {time}",
  tileNotSending: "Not sending pictures",
  tileOff: "Turned off",

  modeLabel: "Site mode",
  modeUnknown: "Can't tell right now",

  attentionLabel: "Needs attention",
  alertsOne: "1 alert",
  alertsMany: "{n} alerts",
  // Each true for every cause of its row going down (spec critic item 7).
  behindUnsorted: "Some events haven't been sorted, so this may be behind.",
  behindCameraEvents: "Camera events aren't getting through, so this may be behind.",
  behindWarnings: "Network and sign-in warnings aren't getting through, so this may be behind.",

  sourcesLabel: "Sources",
  sourcesAllReporting: "All reporting",
  notReportingOne: "1 not reporting",
  notReportingMany: "{n} not reporting",
  quietOne: "1 quiet",
  quietMany: "{n} quiet",
  notSetUpOne: "1 not set up",
  notSetUpMany: "{n} not set up",
  otherSource: "Another source",

  updatedLabel: "Updated",
  unknownValue: "—",
  waiting: "Waiting for Droplet…",
  staleTitle: "This screen can't reach Droplet right now.",
  staleBody: "What you see is from {time}. It updates again as soon as Droplet answers.",
  staleNeverBody: "Parts of it haven't loaded yet. They fill in as soon as Droplet answers.",
  offlineTitle: "This screen is offline.",
  offlineBody: "What you see is from {time}.",
  signOutSoon: "This screen will be signed out by {time} at the latest. Someone will need to sign in again to keep it on.",

  // D6 (Stefan: "Member wall, own cameras") — the wall runs on a Staff account only. {tier} is tierLabel("family").
  // The device is named "this screen", as on the wall's banners: the refusal is as often a laptop's as a TV's.
  refusedTitle: "This TV view doesn't run on an owner or admin account",
  refusedWhy: "An owner or admin account can reach nearly everything in Droplet, and a TV stays signed in, in a room, for hours.",
  refusedGuestTitle: "This TV view doesn't run on a guest account",
  refusedGuestWhy: "A guest account can't see Security or its cameras, so there is nothing to show here.",
  refusedWhat: "Sign in here with a {tier} account instead. This screen then shows only the cameras that account has been given.",
  refusedManage: "You can add that account, and choose its cameras, on the Users page.",
  refusedManageLink: "Open Users",
  refusedSignOut: "Sign out on this screen",
  refusedGuestLeave: "Back to Overview",

  // The sign-in ended while the wall was up, or there never was one: never a sign-in form in front of the room by itself.
  signedOutTitle: "This TV view is signed out",
  signedOutBody: "Nothing is shown until someone signs in on this screen.",
  signedOutAction: "Sign in on this screen",
} as const;

/**
 * D6 — the one role a wall runs for: Staff (`family`). An owner or admin
 * session is refused (Stefan: "Member wall, own cameras"): a TV stays signed
 * in, unattended, in a room, one click from everything that account can do.
 * A guest is refused too: every read the wall makes (route 17's counts,
 * /security/health, /security/mode, /api/cameras and its pictures) is floored
 * at owner/admin/family on the server, so a guest wall would only collect
 * 403s, and each 403 is an audited denial that becomes a threat incident. A
 * role this build does not know is refused: the wall cannot vouch that it is
 * not an admin's. The rule is the UI's: every read the wall makes is an
 * ordinary route this person may already call from /security or /cameras.
 */
const WALL_ROLES: ReadonlySet<string> = new Set(["family"]);

export function wallRunsFor(role: string | null | undefined): boolean {
  return typeof role === "string" && WALL_ROLES.has(role);
}

/** Two missed 15 s polls: the strip is as fresh as its stalest cell. */
export const WALL_STALE_AFTER_MS = 45_000;
/** The sign-out warning shows in the sign-in's last half hour. */
export const WALL_SESSION_WARN_MS = 30 * 60_000;
/** A camera tile's picture older than this (its last few asks failed) is dimmed under its own time: never drawn as current. */
export const WALL_TILE_STALE_AFTER_MS = 15_000;
/** The render clock: "Updated", staleness and the sign-out warning are re-judged this often. */
export const WALL_TICK_MS = 5_000;

/**
 * The camera tiles' grid on a TV: the nearest square that holds them, wider
 * than tall (1 → 1×1, 2 → 2×1, 3–4 → 2×2, 5–6 → 3×2, 7–9 → 3×3, 10–12 → 4×3),
 * so every tile fits the space the strip leaves and none is off screen.
 */
export function tileGrid(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/**
 * What each /security health row is to the wall. Only event SOURCES count in
 * the sources cell (ADR §3.2): `patterns` reads quiet for its 14 learning
 * days, `retention` and `alerts` feed nothing on screen, `site_mode` is the
 * mode cell's and `incidents` the needs-attention cell's. A `Record`, so a new
 * row id (locks, summaries) cannot land without being classified here.
 */
export type WallRowRole = "source" | "engine" | "mode" | "other";
export const WALL_ROW_ROLE: Record<SecurityHealthRow["id"], WallRowRole> = {
  camera_ingest: "source",
  camera_system: "source",
  threat_mirror: "source",
  site_mode: "mode",
  incidents: "engine",
  alerts: "other",
  patterns: "other",
  retention: "other",
};

/** The source rows, in the server's order. An id this build does not know counts as a source: never hide what we can't classify. */
export function sourceRows(rows: readonly SecurityHealthRow[]): SecurityHealthRow[] {
  return rows.filter((r) => (WALL_ROW_ROLE[r.id] ?? "source") === "source");
}

/** "{n} things", or its singular. */
export function countLine(n: number, one: string, many: string): string {
  return n === 1 ? one : fill(many, { n: String(n) });
}

/** The sources cell's headline: not reporting › quiet › not set up › All reporting (every source `ok`). */
export function sourcesHeadline(rows: readonly SecurityHealthRow[]): string {
  const sources = sourceRows(rows);
  if (sources.length === 0) return WALL_COPY.unknownValue;
  const n = (state: SecurityHealthRow["state"]) => sources.filter((r) => r.state === state).length;
  if (n("down") > 0) return countLine(n("down"), WALL_COPY.notReportingOne, WALL_COPY.notReportingMany);
  if (n("quiet") > 0) return countLine(n("quiet"), WALL_COPY.quietOne, WALL_COPY.quietMany);
  if (n("not_configured") > 0) return countLine(n("not_configured"), WALL_COPY.notSetUpOne, WALL_COPY.notSetUpMany);
  return WALL_COPY.sourcesAllReporting;
}

export type CountBehind = "unsorted" | "camera_events" | "warnings";

/** The copy for each reason the count may be behind. */
export const BEHIND_COPY: Record<CountBehind, string> = {
  unsorted: WALL_COPY.behindUnsorted,
  camera_events: WALL_COPY.behindCameraEvents,
  warnings: WALL_COPY.behindWarnings,
};

/**
 * Why the needs-attention number may be missing incidents, or null — the rack
 * panel's `upToDate` rule (P6-3) over this viewer's rows: the engine is not
 * sorting, or camera events or (for an owner or admin, the only people who get
 * that row) network and sign-in warnings are not getting through.
 */
export function countBehind(rows: readonly SecurityHealthRow[]): CountBehind | null {
  const down = (id: SecurityHealthRow["id"]) => rows.some((r) => r.id === id && r.state === "down");
  if (down("incidents")) return "unsorted";
  if (down("camera_ingest")) return "camera_events";
  if (down("threat_mirror")) return "warnings";
  return null;
}

/** The reads the wall judges its freshness by. `modules` gates the others; the three status reads are what is on screen. */
export type WallRead = "modules" | "counts" | "sources" | "mode";
const STATUS_READS: readonly WallRead[] = ["counts", "sources", "mode"];

export interface WallFreshness {
  /** loading: nothing to judge yet; stale: a read failed before its first answer, or the stalest is > 45 s old. */
  state: "loading" | "fresh" | "stale" | "offline";
  /** The OLDEST last success of the three status reads — null until all three have answered. */
  updatedAt: number | null;
}

/**
 * How fresh the strip is. The modules read polls every 2 min, so its age is
 * not judged; it counts only when it has failed before ever answering (then
 * nothing else is even asked).
 */
export function wallFreshness(
  lastOkAt: Readonly<Record<WallRead, number | null>>,
  failed: Readonly<Record<WallRead, boolean>>,
  online: boolean,
  now: number,
): WallFreshness {
  const answered = STATUS_READS.map((k) => lastOkAt[k]);
  const updatedAt = answered.every((t): t is number => t !== null) ? Math.min(...answered) : null;
  if (!online) return { state: "offline", updatedAt };
  const neverAnswered = (["modules", ...STATUS_READS] as const).some((k) => failed[k] && lastOkAt[k] === null);
  if (neverAnswered) return { state: "stale", updatedAt };
  if (updatedAt === null) return { state: "loading", updatedAt };
  return { state: now - updatedAt > WALL_STALE_AFTER_MS ? "stale" : "fresh", updatedAt };
}

/** Whether the sign-in's latest end (P6-A's `session.endsAt`) is within the last half hour and still ahead. */
export function sessionWarning(endsAt: string | null, now: number): boolean {
  if (endsAt === null) return false;
  const left = Date.parse(endsAt) - now;
  return left > 0 && left <= WALL_SESSION_WARN_MS;
}
