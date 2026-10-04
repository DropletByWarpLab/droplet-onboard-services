/**
 * WARP-2767 — the credential behind the pre-auth calendar ICS feed.
 *
 * The URL token is `<rowId>.<secret>` (selector / verifier). Only
 * sha256(secret) is stored, so neither a database read nor a backup yields a
 * working link, and the verifier compares hashes in constant time. Each row
 * belongs to exactly one User (FK, cascade on delete) and carries an explicit
 * lifecycle state — see CalendarFeedTokenState in schema.prisma.
 *
 * Expiry policy: FEED_TOKEN_TTL_MS (180 days). Calendar apps poll unattended
 * and show nothing when a feed starts refusing them, so a short TTL would
 * quietly break subscriptions; no expiry at all was the defect. Half a year
 * bounds a forgotten or forwarded link while renewal stays a single click in
 * the dashboard, which shows the expiry date.
 *
 * WARP-3533 — one mechanism, three feeds. A link carries a `scope`
 * (CalendarFeedTokenScope): the person's calendar (every link that existed
 * before PM feeds), their "my work" feed, or one project's feed (+ `projectId`).
 * A link reads ONLY its own feed, and rotating or revoking one feed's link
 * leaves every other feed's alone — so a project link pasted into a team
 * calendar exposes that project's due dates and nothing of the person's own
 * calendar, and re-issuing the calendar link does not break the PM feeds. The
 * functions below take a {@link FeedTarget}; omitted, it is the calendar feed,
 * which is every pre-existing caller.
 */
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const FEED_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Which feed a link reads. `projectId` is present exactly for a project feed. */
export type FeedTarget =
  | { scope: "calendar" }
  | { scope: "pm_my_work" }
  | { scope: "pm_project"; projectId: string };

const CALENDAR_FEED: FeedTarget = { scope: "calendar" };

/** The (scope, projectId) pair a target means, as a Prisma `where` fragment. */
function targetWhere(target: FeedTarget): { scope: FeedTarget["scope"]; projectId: string | null } {
  return { scope: target.scope, projectId: target.scope === "pm_project" ? target.projectId : null };
}

/**
 * The path a feed is served at, for the username it is bound to. The caller
 * appends `?token=` + the freshly minted token (the one and only time it is
 * shown). Kept beside the routes it names: routes/calendar.ts.
 */
export function feedPath(username: string, target: FeedTarget): string {
  const user = encodeURIComponent(username);
  switch (target.scope) {
    case "calendar":
      return `/api/calendar/publish/${user}.ics`;
    case "pm_my_work":
      return `/api/calendar/publish/${user}/my-work.ics`;
    case "pm_project":
      return `/api/calendar/publish/${user}/projects/${encodeURIComponent(target.projectId)}.ics`;
  }
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export interface FeedTokenStatus {
  state: "active" | "none";
  createdAt: Date | null;
  expiresAt: Date | null;
}

/** The caller's current link for `target`, without the secret (only its hash exists). */
export async function getFeedTokenStatus(
  prisma: PrismaClient,
  userId: string,
  target: FeedTarget = CALENDAR_FEED,
): Promise<FeedTokenStatus> {
  const row = await prisma.calendarFeedToken.findFirst({
    where: { userId, state: "active", expiresAt: { gt: new Date() }, ...targetWhere(target) },
    orderBy: { createdAt: "desc" },
  });
  return row
    ? { state: "active", createdAt: row.createdAt, expiresAt: row.expiresAt }
    : { state: "none", createdAt: null, expiresAt: null };
}

/**
 * Every live PM feed link `userId` holds, by feed: for the Developer page's
 * list, in one query. The calendar link is not a PM feed and is not here.
 */
export async function listActivePmFeedLinks(
  prisma: PrismaClient,
  userId: string,
): Promise<Array<{ target: FeedTarget; createdAt: Date; expiresAt: Date }>> {
  const rows = await prisma.calendarFeedToken.findMany({
    where: { userId, state: "active", expiresAt: { gt: new Date() }, scope: { in: ["pm_my_work", "pm_project"] } },
    orderBy: { createdAt: "desc" },
  });
  const links: Array<{ target: FeedTarget; createdAt: Date; expiresAt: Date }> = [];
  for (const r of rows) {
    if (r.scope === "pm_project") {
      // CalendarFeedToken_project_scope_coherent makes the id present; the guard is the type's.
      if (r.projectId) links.push({ target: { scope: "pm_project", projectId: r.projectId }, createdAt: r.createdAt, expiresAt: r.expiresAt });
    } else {
      links.push({ target: { scope: "pm_my_work" }, createdAt: r.createdAt, expiresAt: r.expiresAt });
    }
  }
  return links;
}

/**
 * Mint a new link for `userId` and `target`, ending every link that user
 * already had FOR THAT FEED in the same transaction. The returned token is
 * shown exactly once.
 */
export async function rotateFeedToken(
  prisma: PrismaClient,
  userId: string,
  target: FeedTarget = CALENDAR_FEED,
): Promise<{ id: string; token: string; expiresAt: Date; rotated: number }> {
  const secret = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FEED_TOKEN_TTL_MS);
  const where = targetWhere(target);
  const [ended, row] = await prisma.$transaction([
    prisma.calendarFeedToken.updateMany({
      where: { userId, state: "active", ...where },
      data: { state: "rotated", endedAt: now },
    }),
    prisma.calendarFeedToken.create({
      data: { userId, secretHash: hashSecret(secret), expiresAt, ...where },
    }),
  ]);
  return { id: row.id, token: `${row.id}.${secret}`, expiresAt, rotated: ended.count };
}

/** Turn the caller's link(s) for `target` off with no replacement. */
export async function revokeFeedTokens(
  prisma: PrismaClient,
  userId: string,
  target: FeedTarget = CALENDAR_FEED,
): Promise<number> {
  const r = await prisma.calendarFeedToken.updateMany({
    where: { userId, state: "active", ...targetWhere(target) },
    data: { state: "revoked", endedAt: new Date() },
  });
  return r.count;
}

/** Who a feed link belongs to, once it has been proven good for one feed. */
export interface FeedPrincipal {
  userId: string;
  username: string;
  /** The person's role NOW — read at this request, never frozen into the link. */
  role: string;
}

/**
 * Resolve a presented token to the person whose `target` feed it may read, or
 * null. `urlUser` is the username in the feed path: a valid token for someone
 * else is refused exactly like a forged one, and so is a valid token for a
 * different feed (a project link on the calendar path, a link for project A on
 * project B's path).
 */
export async function resolveFeedToken(
  prisma: PrismaClient,
  token: string,
  urlUser: string,
  target: FeedTarget = CALENDAR_FEED,
): Promise<FeedPrincipal | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 200) return null;
  const id = token.slice(0, dot);
  const presented = Buffer.from(hashSecret(token.slice(dot + 1)), "hex");

  const row = await prisma.calendarFeedToken.findUnique({
    where: { id },
    include: { user: { select: { username: true, directoryStatus: true, role: true } } },
  });
  if (!row) return null;
  if (!crypto.timingSafeEqual(presented, Buffer.from(row.secretHash, "hex"))) return null;
  if (row.state !== "active") return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.calendarFeedToken.updateMany({
      where: { id, state: "active" },
      data: { state: "expired", endedAt: new Date() },
    });
    return null;
  }
  if (row.user.directoryStatus !== "ACTIVE") return null;
  if (row.user.username !== urlUser) return null;
  const want = targetWhere(target);
  if (row.scope !== want.scope || (row.projectId ?? null) !== want.projectId) return null;
  return { userId: row.userId, username: row.user.username, role: row.user.role };
}

/**
 * The calendar feed's verifier (WARP-2767): the username whose calendar the
 * token may read, or null. A link for any other feed is refused here.
 */
export async function verifyFeedToken(
  prisma: PrismaClient,
  token: string,
  urlUser: string,
): Promise<string | null> {
  return (await resolveFeedToken(prisma, token, urlUser, CALENDAR_FEED))?.username ?? null;
}
