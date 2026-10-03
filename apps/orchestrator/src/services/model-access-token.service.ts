/**
 * WARP-3452 — coding-tool tokens for the local model API (`https://<box>/llm/`).
 *
 * A token is `dlk_` + 32 random bytes (base64url). Only sha256(full token) is
 * stored (unique), so a database read or a backup never yields a working
 * token; `prefix` (the 8 characters after `dlk_`) is for display. Each row
 * belongs to one User (FK, cascade) and carries an explicit status — see
 * ModelAccessTokenStatus in schema.prisma. Same shape as CalendarFeedToken
 * (calendar-feed-token.service.ts).
 *
 * Lifetime: 364 days from creation or renewal (Romain, 2026-10-02).
 *
 * ai-gateway checks EVERY `/llm/` request through `checkToken` (via
 * POST /api/llm-access/_introspect) — nothing is cached, so a revoke is
 * effective on the next request.
 *
 * This module imports nothing heavier than the activity recorder, because
 * role-mutation-guard.service.ts calls `revokeModelAccessTokensForUser` from
 * every deactivation and demotion path.
 */
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { recordActivity } from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("model-access-token");

export const MODEL_TOKEN_PREFIX = "dlk_";
export const MODEL_TOKEN_TTL_MS = 364 * 24 * 60 * 60 * 1000;
/** WorkspaceSetting holding the box-wide switch; seeded `false`. */
export const LLM_ACCESS_ENABLED_KEY = "ai.llm_access.enabled";
/** Who may hold a token. External guests never (Romain, 2026-10-02). */
export const TOKEN_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "family"]);

const LAST_USED_EVERY_MS = 60_000;
const REFUSAL_AUDIT_EVERY_MS = 60 * 60_000;
const USAGE_WINDOW_DAYS = 30;

type Status = "active" | "revoked" | "expired";

export interface TokenUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  errors: number;
}

export interface TokenRow {
  id: string;
  label: string;
  prefix: string;
  status: Status;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  usage30d: TokenUsage;
}

interface StoredToken {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  status: Status;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  usage?: TokenUsage[];
}

export function hashModelToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** UTC midnight of `now` — the usage row's day. */
function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toRow(t: StoredToken): TokenRow {
  const usage30d: TokenUsage = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
  for (const u of t.usage ?? []) {
    usage30d.requests += u.requests;
    usage30d.promptTokens += u.promptTokens;
    usage30d.completionTokens += u.completionTokens;
    usage30d.errors += u.errors;
  }
  return {
    id: t.id,
    label: t.label,
    prefix: t.prefix,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    usage30d,
  };
}

const usageSince = (now: Date) => ({
  where: { day: { gte: new Date(utcDay(now).getTime() - (USAGE_WINDOW_DAYS - 1) * 86_400_000) } },
});

// ── The box-wide switch ─────────────────────────────────────────────────────

/**
 * Strict read: only a literal `true` is on. A missing row, a malformed value
 * or an unreadable table all read as OFF — the default, and the closed side.
 */
export async function isLlmAccessEnabled(prisma: PrismaClient): Promise<boolean> {
  try {
    const row = await prisma.workspaceSetting.findUnique({
      where: { key: LLM_ACCESS_ENABLED_KEY },
      select: { valueJson: true },
    });
    return row?.valueJson === true;
  } catch (err) {
    logger.warn({ err }, "llm access switch unreadable; treating as off");
    return false;
  }
}

/** Write the switch. Returns whether the stored value changed. */
export async function setLlmAccessEnabled(prisma: PrismaClient, enabled: boolean): Promise<boolean> {
  const before = await isLlmAccessEnabled(prisma);
  await prisma.workspaceSetting.upsert({
    where: { key: LLM_ACCESS_ENABLED_KEY },
    create: { key: LLM_ACCESS_ENABLED_KEY, section: "ai", type: "bool", valueJson: enabled },
    update: { valueJson: enabled },
  });
  return before !== enabled;
}

// ── Token lifecycle ─────────────────────────────────────────────────────────

/**
 * Tokens newest first — one person's (`userId`) or everyone's (`null`, with
 * the holder). An active token found past `expiresAt` is stamped `expired`
 * first, so the list never shows a dead token as active.
 */
export async function listTokens(prisma: PrismaClient, userId: string): Promise<TokenRow[]>;
export async function listTokens(
  prisma: PrismaClient,
  userId: null,
): Promise<Array<TokenRow & { user: { id: string; displayName: string } }>>;
export async function listTokens(prisma: PrismaClient, userId: string | null, now = new Date()) {
  const scope = userId ? { userId } : {};
  await prisma.modelAccessToken.updateMany({
    where: { ...scope, status: "active", expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  const rows = await prisma.modelAccessToken.findMany({
    where: scope,
    orderBy: { createdAt: "desc" },
    include: { usage: usageSince(now), user: { select: { id: true, displayName: true } } },
  });
  return rows.map((r) => {
    const row = toRow(r as StoredToken);
    return userId ? row : { ...row, user: { id: r.user.id, displayName: r.user.displayName } };
  });
}

/** Mint a token for `userId`. The returned `token` is shown exactly once. */
export async function createToken(
  prisma: PrismaClient,
  userId: string,
  label: string,
  now = new Date(),
): Promise<{ token: string; row: TokenRow }> {
  const token = MODEL_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const row = await prisma.modelAccessToken.create({
    data: {
      userId,
      label,
      prefix: token.slice(MODEL_TOKEN_PREFIX.length, MODEL_TOKEN_PREFIX.length + 8),
      secretHash: hashModelToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + MODEL_TOKEN_TTL_MS),
    },
  });
  return { token, row: toRow(row as StoredToken) };
}

/** Who is acting on a token: its holder, or an owner/admin for any. */
export interface TokenManager {
  userId: string;
  isAdmin: boolean;
}

async function findManaged(prisma: PrismaClient, id: string, by: TokenManager) {
  const row = await prisma.modelAccessToken.findUnique({ where: { id } });
  // Someone else's token reads as absent: its id says nothing to a member.
  return row && (row.userId === by.userId || by.isAdmin) ? row : null;
}

/** expiresAt = now + 364 days; an expired token becomes active again. A revoked one stays revoked. */
export async function renewToken(
  prisma: PrismaClient,
  id: string,
  by: TokenManager,
  now = new Date(),
): Promise<{ row: TokenRow; userId: string; label: string } | "not_found" | "revoked"> {
  const found = await findManaged(prisma, id, by);
  if (!found) return "not_found";
  const updated = await prisma.modelAccessToken.updateMany({
    where: { id, status: { in: ["active", "expired"] } },
    data: { status: "active", expiresAt: new Date(now.getTime() + MODEL_TOKEN_TTL_MS) },
  });
  if (updated.count === 0) return "revoked";
  const row = await prisma.modelAccessToken.findUnique({ where: { id }, include: { usage: usageSince(now) } });
  return { row: toRow(row as StoredToken), userId: found.userId, label: found.label };
}

/** Revoke by hand (the row is kept). Idempotent: an already-revoked token reports `already`. */
export async function revokeToken(
  prisma: PrismaClient,
  id: string,
  by: TokenManager,
  now = new Date(),
): Promise<{ userId: string; label: string } | "not_found" | "already"> {
  const found = await findManaged(prisma, id, by);
  if (!found) return "not_found";
  const updated = await prisma.modelAccessToken.updateMany({
    where: { id, status: { in: ["active", "expired"] } },
    data: { status: "revoked", revokedAt: now, revokedReason: "manual", revokedById: by.userId },
  });
  return updated.count === 0 ? "already" : { userId: found.userId, label: found.label };
}

// ── Introspection (ai-gateway, every request) ───────────────────────────────

export type TokenCheck =
  | { ok: true; tokenId: string; userId: string; role: "owner" | "admin" | "family" }
  | { ok: false; status: 401; error: "invalid_token" | "revoked" | "expired" }
  | { ok: false; status: 403; error: "role_not_allowed" };

const INVALID: TokenCheck = { ok: false, status: 401, error: "invalid_token" };

/**
 * Resolve a presented token. Side effects: an active token past `expiresAt`
 * is stamped `expired`; an active token whose holder is deactivated, or is
 * now a guest, is revoked (the lifecycle hooks are best-effort, this closes
 * the gap; the guest still gets 403 `role_not_allowed`); a refused
 * revoked/expired token writes one ActivityRow per token per hour.
 */
export async function checkToken(prisma: PrismaClient, presented: unknown, now = new Date()): Promise<TokenCheck> {
  if (typeof presented !== "string" || !presented.startsWith(MODEL_TOKEN_PREFIX) || presented.length > 128) {
    return INVALID;
  }
  const row = await prisma.modelAccessToken.findUnique({
    where: { secretHash: hashModelToken(presented) },
    include: { user: { select: { role: true, directoryStatus: true } } },
  });
  if (!row) return INVALID;

  let status = row.status as Status;
  if (status === "active" && row.user.directoryStatus !== "ACTIVE") {
    await prisma.modelAccessToken.updateMany({
      where: { id: row.id, status: "active" },
      data: { status: "revoked", revokedAt: now, revokedReason: "user_deactivated" },
    });
    status = "revoked";
  } else if (status === "active" && row.expiresAt.getTime() <= now.getTime()) {
    await prisma.modelAccessToken.updateMany({ where: { id: row.id, status: "active" }, data: { status: "expired" } });
    status = "expired";
  }
  if (status !== "active") {
    await auditRefusal(prisma, row, status, now);
    return { ok: false, status: 401, error: status };
  }
  if (!TOKEN_ROLES.has(row.user.role)) {
    if (row.user.role === "guest") {
      // A demotion whose lifecycle revoke did not land: finish it here, or a
      // later re-promotion would silently bring the token back.
      await prisma.modelAccessToken.updateMany({
        where: { id: row.id, status: "active" },
        data: { status: "revoked", revokedAt: now, revokedReason: "role_guest" },
      });
      await auditRefusal(prisma, row, "revoked", now);
    }
    return { ok: false, status: 403, error: "role_not_allowed" };
  }
  return { ok: true, tokenId: row.id, userId: row.userId, role: row.user.role as "owner" | "admin" | "family" };
}

async function auditRefusal(
  prisma: PrismaClient,
  row: { id: string; userId: string; label: string },
  reason: "revoked" | "expired",
  now: Date,
): Promise<void> {
  // The conditional write is the claim: two concurrent refusals cannot both win it.
  const claimed = await prisma.modelAccessToken.updateMany({
    where: {
      id: row.id,
      OR: [{ refusalAuditedAt: null }, { refusalAuditedAt: { lt: new Date(now.getTime() - REFUSAL_AUDIT_EVERY_MS) } }],
    },
    data: { refusalAuditedAt: now },
  });
  if (claimed.count === 0) return;
  await recordActivity({
    kind: "auth",
    severity: "warn",
    sourceIcon: "key-round",
    what: reason === "revoked" ? "Coding tool refused: token revoked" : "Coding tool refused: token expired",
    sub: row.label,
    // Never the token or any part of it — the row id is the non-secret handle.
    refs: { tokenId: row.id, userId: row.userId, reason },
    actor: { type: "system", id: null },
  });
}

/**
 * An admitted request: today's `requests` + 1, and `lastUsedAt` at most once a
 * minute. Accounting only — a failed write is logged, never a refusal.
 */
export async function recordTokenUse(prisma: PrismaClient, tokenId: string, now = new Date()): Promise<void> {
  const day = utcDay(now);
  const writes = Promise.all([
    prisma.modelAccessTokenUsage.upsert({
      where: { tokenId_day: { tokenId, day } },
      create: { tokenId, day, requests: 1 },
      update: { requests: { increment: 1 } },
    }),
    prisma.modelAccessToken.updateMany({
      where: {
        id: tokenId,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_EVERY_MS) } }],
      },
      data: { lastUsedAt: now },
    }),
  ]);
  await writes.catch((err) => logger.warn({ err, tokenId }, "coding-tool usage count not recorded"));
}

/** ai-gateway's after-the-fact counts for one request. False when the token no longer exists. */
export async function addTokenUsage(
  prisma: PrismaClient,
  u: { tokenId: string; promptTokens: number; completionTokens: number; error: boolean },
  now = new Date(),
): Promise<boolean> {
  const exists = await prisma.modelAccessToken.findUnique({ where: { id: u.tokenId }, select: { id: true } });
  if (!exists) return false;
  const day = utcDay(now);
  const errors = u.error ? 1 : 0;
  await prisma.modelAccessTokenUsage.upsert({
    where: { tokenId_day: { tokenId: u.tokenId, day } },
    create: { tokenId: u.tokenId, day, promptTokens: u.promptTokens, completionTokens: u.completionTokens, errors },
    update: {
      promptTokens: { increment: u.promptTokens },
      completionTokens: { increment: u.completionTokens },
      errors: { increment: errors },
    },
  });
  return true;
}

// ── Lifecycle hook (deactivation, demotion to guest) ────────────────────────
//
// The rail-6 post-effects in role-mutation-guard.service.ts carry no Prisma
// client, so the box wires one here at boot, next to initVpnDeviceRevoke.

let boundPrisma: PrismaClient | null = null;

export function initModelAccessTokenRevoke(prisma: PrismaClient): void {
  boundPrisma = prisma;
}

/**
 * Revoke every token `userId` holds that is not already revoked. Best-effort;
 * never throws — `checkToken` refuses a deactivated holder (and a guest) on
 * its own, so a revoke that did not land here still cannot be used.
 */
export async function revokeModelAccessTokensForUser(
  userId: string,
  reason: "user_deactivated" | "role_guest",
  actor: ActivityActor,
): Promise<void> {
  if (!boundPrisma) {
    logger.error({ userId, reason }, "WARP-3452: token revoke not wired (initModelAccessTokenRevoke) — coding-tool tokens were NOT revoked");
    return;
  }
  try {
    const revoked = await boundPrisma.modelAccessToken.updateMany({
      where: { userId, status: { in: ["active", "expired"] } },
      data: { status: "revoked", revokedAt: new Date(), revokedReason: reason },
    });
    if (revoked.count === 0) return;
    await recordActivity({
      kind: "auth",
      severity: "warn",
      sourceIcon: "key-round",
      what: "Coding-tool tokens revoked",
      sub: reason === "user_deactivated" ? "account deactivated" : "role changed to guest",
      refs: { userId, revoked: revoked.count, reason },
      actor,
    });
  } catch (err) {
    logger.error({ err, userId, reason }, "WARP-3452: coding-tool token revoke failed (introspection still refuses the holder)");
  }
}
