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
 */
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const FEED_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export interface FeedTokenStatus {
  state: "active" | "none";
  createdAt: Date | null;
  expiresAt: Date | null;
}

/** The caller's current link, without the secret (only its hash exists). */
export async function getFeedTokenStatus(
  prisma: PrismaClient,
  userId: string,
): Promise<FeedTokenStatus> {
  const row = await prisma.calendarFeedToken.findFirst({
    where: { userId, state: "active", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  return row
    ? { state: "active", createdAt: row.createdAt, expiresAt: row.expiresAt }
    : { state: "none", createdAt: null, expiresAt: null };
}

/**
 * Mint a new link for `userId`, ending every link that user already had in
 * the same transaction. The returned token is shown exactly once.
 */
export async function rotateFeedToken(
  prisma: PrismaClient,
  userId: string,
): Promise<{ id: string; token: string; expiresAt: Date; rotated: number }> {
  const secret = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FEED_TOKEN_TTL_MS);
  const [ended, row] = await prisma.$transaction([
    prisma.calendarFeedToken.updateMany({
      where: { userId, state: "active" },
      data: { state: "rotated", endedAt: now },
    }),
    prisma.calendarFeedToken.create({
      data: { userId, secretHash: hashSecret(secret), expiresAt },
    }),
  ]);
  return { id: row.id, token: `${row.id}.${secret}`, expiresAt, rotated: ended.count };
}

/** Turn the caller's link(s) off with no replacement. */
export async function revokeFeedTokens(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const r = await prisma.calendarFeedToken.updateMany({
    where: { userId, state: "active" },
    data: { state: "revoked", endedAt: new Date() },
  });
  return r.count;
}

/**
 * Resolve a presented token to the username whose feed it may read, or null.
 * `urlUser` is the username in the feed path: a valid token for someone else
 * is refused exactly like a forged one.
 */
export async function verifyFeedToken(
  prisma: PrismaClient,
  token: string,
  urlUser: string,
): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 200) return null;
  const id = token.slice(0, dot);
  const presented = Buffer.from(hashSecret(token.slice(dot + 1)), "hex");

  const row = await prisma.calendarFeedToken.findUnique({
    where: { id },
    include: { user: { select: { username: true, directoryStatus: true } } },
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
  return row.user.username;
}
