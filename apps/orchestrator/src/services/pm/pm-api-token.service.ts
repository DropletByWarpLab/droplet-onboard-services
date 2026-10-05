/**
 * WARP-3533 — personal API tokens for `/api/pm/*` and `/api/support/*`.
 *
 * A token is `dpm_` + 32 random bytes (base64url). Only sha256(full token) is
 * stored (unique), so a database read or a backup never yields a working
 * token; `prefix` (the 8 characters after `dpm_`) is for display. Each row
 * belongs to one User (FK, cascade) and carries an explicit status — see
 * PmApiTokenStatus in schema.prisma. Same shape as ModelAccessToken
 * (model-access-token.service.ts, ADR-067), with the difference that this one
 * DOES reach authMiddleware.
 *
 * What a token is, in one sentence: its holder, with fewer permissions.
 *   - `resolvePmApiTokenPrincipal` resolves it to the holder's CURRENT row (role
 *     and directory status read at this request), so every role, module and
 *     feature gate downstream runs exactly as it does for the holder's own
 *     session, and a token can never exceed what the holder may do today;
 *   - `scopes` only narrow it (middleware/pm-api-token-guard.ts);
 *   - it works only on the two prefixes in {@link tokenAreaForPath}.
 *
 * It stops working when the holder is deactivated or their role changes. Two
 * locks on that door: the lifecycle hooks in role-mutation-guard.service.ts
 * revoke eagerly ({@link revokePmApiTokensForUser}), and every use re-checks
 * the holder (a hook that did not land still cannot be used past this file).
 *
 * The box-wide switch (`workspace.api_tokens_enabled`, seeded OFF) makes every
 * token answer 401 without deleting any of them.
 *
 * The secret never leaves the response that mints it: nothing here logs or
 * audits a token or any part of it, and the only forms stored are its sha256
 * and the 8-character display prefix. The row id is the non-secret handle every
 * log line and audit row uses.
 *
 * This module imports nothing heavier than the activity recorder, because
 * role-mutation-guard.service.ts calls `revokePmApiTokensForUser` from every
 * deactivation and role-change path.
 */
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { recordActivity } from "../activity.singleton.js";
import type { ActivityActor } from "../activity.service.js";
import type { Role } from "../jwt.service.js";
import { normalizeGatePath, pathIsUnder } from "../../modules/module-registry.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("pm-api-token");

/** Public marker used to route this bearer type; it is not secret material. */
export const PM_API_PUBLIC_PREFIX = "dpm_";
/** The longest token a request may present: `dpm_` + 43 characters, with room to spare. */
const PRESENTED_MAX_LENGTH = 128;
/** WorkspaceSetting holding the box-wide switch; seeded `false`. */
export const PM_API_TOKENS_ENABLED_KEY = "workspace.api_tokens_enabled";
/** Who may hold a token. External guests never, and neither does a service principal. */
export const PM_API_TOKEN_HOLDER_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "family"]);
/** An explicit expiry may be at most this far out (a sanity bound; no expiry at all is allowed). */
export const PM_API_TOKEN_MAX_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const LAST_USED_EVERY_MS = 60_000;
const REFUSAL_AUDIT_EVERY_MS = 60 * 60_000;

// ── Scopes ──────────────────────────────────────────────────────────────────

/** The vocabulary. The same list is the CHECK in the migration. */
export const PM_API_TOKEN_SCOPES = ["pm:read", "pm:write", "support:read", "support:write"] as const;
export type PmApiTokenScope = (typeof PM_API_TOKEN_SCOPES)[number];

/** The two route prefixes a token may call, and the module that owns each. */
export type PmApiTokenArea = "pm" | "support";
const AREA_PREFIX: Record<PmApiTokenArea, string> = { pm: "/api/pm", support: "/api/support" };

export function isPmApiTokenScope(value: unknown): value is PmApiTokenScope {
  return typeof value === "string" && (PM_API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** The vocabulary members in `scopes`, once each, in vocabulary order. */
export function normalizeScopes(scopes: readonly string[]): PmApiTokenScope[] {
  return PM_API_TOKEN_SCOPES.filter((s) => scopes.includes(s));
}

/**
 * SESSION-ONLY ROUTES: under the two prefixes, but never reachable with an API
 * token, whatever its scopes and whoever it acts as. These are admin
 * configuration (they define where work data is SENT, or how a project or the
 * desk behaves for everyone), and a token is a script's credential, not an
 * admin's: a leaked `pm:write` token of an owner must not be able to point a
 * webhook at an attacker. A route that does not exist yet is listed too, so the
 * day a slice mounts it, it is session-only with no edit here (WS-16 webhooks,
 * WS-4 project settings, WS-12/14 desk setup).
 *
 * Patterns are matched segment by segment against the normalised path (lower
 * case, no trailing slash) and match as PREFIXES: `/api/pm/webhooks` covers
 * `/api/pm/webhooks/<id>/deliveries` too. `*` stands for exactly one segment.
 * To let a token reach one of these on purpose, remove it here and say why in
 * the PR; to keep a new admin surface session-only, add it here.
 */
export const SESSION_ONLY_ROUTES: readonly string[] = [
  "/api/pm/webhooks",
  "/api/pm/*/settings",
  "/api/pm/projects/*/settings",
  "/api/support/webhooks",
  "/api/support/settings",
  "/api/support/*/settings",
];

function isSessionOnly(normalizedPath: string): boolean {
  // Split WITHOUT dropping empty segments: `//api/pm/webhooks` must not read as `/api/pm/webhooks`.
  const segments = normalizedPath.split("/");
  return SESSION_ONLY_ROUTES.some((pattern) => {
    const want = pattern.split("/");
    return want.length <= segments.length && want.every((w, i) => w === "*" || w === segments[i]);
  });
}

/**
 * The area a token may call at `path`, or null when it may not call it at all:
 * outside `/api/pm` and `/api/support`, or a {@link SESSION_ONLY_ROUTES} route.
 * Segment-bounded and case-insensitive, through the SAME normaliser the module
 * gates use, so this and the `projects` gate can never disagree about what
 * `/api/pm` is: Express routes `/API/PM/x` to the PM router, and so does this.
 */
export function tokenAreaForPath(path: string): PmApiTokenArea | null {
  const p = normalizeGatePath(path);
  if (isSessionOnly(p)) return null;
  for (const area of Object.keys(AREA_PREFIX) as PmApiTokenArea[]) {
    if (pathIsUnder(p, AREA_PREFIX[area])) return area;
  }
  return null;
}

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * POSTs that only READ, because the filter they carry is too large for a query
 * string (WS-6: `POST /api/pm/work-items/query`, which the board and list read
 * through). Exact paths, normalised, and tiny on purpose: every entry is a hole
 * in "everything that is not a GET is a write", so each must be a route that
 * cannot change anything. `routes/pm/openapi.test.ts` checks that no
 * parameterised write route can be reached through one of these paths.
 */
export const READ_ONLY_POSTS: ReadonlySet<string> = new Set(["/api/pm/work-items/query"]);

/**
 * Is this request a read? GET, HEAD and OPTIONS are; so is a POST to one of
 * {@link READ_ONLY_POSTS}; every other method (an unknown verb included) is a
 * write, so it fails closed.
 */
export function isReadRequest(method: string, path = ""): boolean {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return true;
  return m === "POST" && READ_ONLY_POSTS.has(normalizeGatePath(path));
}

/** The scope a request needs: `<area>:read` for a read, `<area>:write` for anything else. */
export function requiredScope(area: PmApiTokenArea, method: string, path = ""): PmApiTokenScope {
  return `${area}:${isReadRequest(method, path) ? "read" : "write"}` as PmApiTokenScope;
}

/** Write implies read; read implies nothing more. */
export function scopeAllows(scopes: readonly string[], area: PmApiTokenArea, method: string, path = ""): boolean {
  if (scopes.includes(`${area}:write`)) return true;
  return isReadRequest(method, path) && scopes.includes(`${area}:read`);
}

// ── Shapes ──────────────────────────────────────────────────────────────────

type Status = "active" | "revoked" | "expired";

export interface PmApiTokenRow {
  id: string;
  name: string;
  /** The 8 characters after `dpm_`, for display only. */
  prefix: string;
  scopes: PmApiTokenScope[];
  status: Status;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface StoredToken {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: Status;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export function hashPmApiToken(token: string): string {
  // CodeQL's password-hash rule treats this credential as a human password.
  // Stored tokens are exclusively minted as dpm_ + 32 CSPRNG bytes (256 bits);
  // SHA-256 supports indexed lookup while offline guessing remains infeasible.
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function toRow(t: StoredToken): PmApiTokenRow {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: normalizeScopes(t.scopes),
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

// ── The box-wide switch ─────────────────────────────────────────────────────

/**
 * Strict read: only a literal `true` is on. A missing row, a malformed value
 * or an unreadable table all read as OFF — the default, and the closed side.
 */
export async function isPmApiTokensEnabled(prisma: PrismaClient): Promise<boolean> {
  try {
    const row = await prisma.workspaceSetting.findUnique({
      where: { key: PM_API_TOKENS_ENABLED_KEY },
      select: { valueJson: true },
    });
    return row?.valueJson === true;
  } catch (err) {
    logger.warn({ err }, "api token switch unreadable; treating as off");
    return false;
  }
}

/** Write the switch. Returns whether the stored value changed. */
export async function setPmApiTokensEnabled(prisma: PrismaClient, enabled: boolean): Promise<boolean> {
  const before = await isPmApiTokensEnabled(prisma);
  await prisma.workspaceSetting.upsert({
    where: { key: PM_API_TOKENS_ENABLED_KEY },
    create: { key: PM_API_TOKENS_ENABLED_KEY, section: "workspace", type: "bool", valueJson: enabled },
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
export async function listPmApiTokens(prisma: PrismaClient, userId: string): Promise<PmApiTokenRow[]>;
export async function listPmApiTokens(
  prisma: PrismaClient,
  userId: null,
): Promise<Array<PmApiTokenRow & { user: { id: string; displayName: string } }>>;
export async function listPmApiTokens(prisma: PrismaClient, userId: string | null, now = new Date()) {
  const scope = userId ? { userId } : {};
  await prisma.pmApiToken.updateMany({
    where: { ...scope, status: "active", expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  const rows = await prisma.pmApiToken.findMany({
    where: scope,
    orderBy: { createdAt: "desc" },
    include: { user: { select: { id: true, displayName: true } } },
  });
  return rows.map((r) => {
    const row = toRow(r as StoredToken);
    return userId ? row : { ...row, user: { id: r.user.id, displayName: r.user.displayName } };
  });
}

/** Mint a token for `holder`. The returned `token` is shown exactly once. */
export async function createPmApiToken(
  prisma: PrismaClient,
  holder: { id: string; role: string },
  input: { name: string; scopes: readonly string[]; expiresAt: Date | null },
  now = new Date(),
): Promise<{ token: string; row: PmApiTokenRow }> {
  if (!PM_API_TOKEN_HOLDER_ROLES.has(holder.role)) throw new Error("role_not_allowed");
  const scopes = normalizeScopes(input.scopes);
  if (scopes.length === 0 || scopes.length !== new Set(input.scopes).size) throw new Error("invalid_scopes");
  const token = PM_API_PUBLIC_PREFIX + crypto.randomBytes(32).toString("base64url");
  const row = await prisma.pmApiToken.create({
    data: {
      userId: holder.id,
      name: input.name,
      prefix: token.slice(PM_API_PUBLIC_PREFIX.length, PM_API_PUBLIC_PREFIX.length + 8),
      hash: hashPmApiToken(token),
      scopes,
      issuedRole: holder.role as "owner" | "admin" | "family",
      createdAt: now,
      expiresAt: input.expiresAt,
    },
  });
  return { token, row: toRow(row as StoredToken) };
}

/** Who is acting on a token: its holder, or an owner/admin for any. */
export interface PmApiTokenManager {
  userId: string;
  isAdmin: boolean;
}

/**
 * Revoke by hand (the row is kept). Idempotent: an already-revoked token
 * reports `already`. Someone else's token reads as absent to a member — its
 * id says nothing to them.
 */
export async function revokePmApiToken(
  prisma: PrismaClient,
  id: string,
  by: PmApiTokenManager,
  now = new Date(),
): Promise<{ userId: string; name: string } | "not_found" | "already"> {
  const found = await prisma.pmApiToken.findUnique({ where: { id } });
  if (!found || (found.userId !== by.userId && !by.isAdmin)) return "not_found";
  // The status check rides in the statement: two concurrent revokes cannot both win it.
  const updated = await prisma.pmApiToken.updateMany({
    where: { id, status: { in: ["active", "expired"] } },
    data: { status: "revoked", revokedAt: now, revokedReason: "manual", revokedById: by.userId },
  });
  return updated.count === 0 ? "already" : { userId: found.userId, name: found.name };
}

// ── Authentication (every request, no cache) ────────────────────────────────

/**
 * Who a token resolves to: the holder, as `authMiddleware` puts them on
 * `req.user`. Declared here and not borrowed from middleware/auth.ts, which
 * imports this module: a type import back would be an import cycle
 * (import-cycles.test.ts, WARP-3193 ARCH-1).
 */
export interface PmApiTokenPrincipal {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export type PmApiTokenFailure = "TOKEN_INVALID" | "TOKEN_REVOKED" | "TOKEN_EXPIRED" | "TOKEN_DISABLED";

export type PmApiTokenAuth =
  | { ok: true; principal: PmApiTokenPrincipal; tokenId: string; scopes: PmApiTokenScope[] }
  | { ok: false; code: PmApiTokenFailure };

const INVALID: PmApiTokenAuth = { ok: false, code: "TOKEN_INVALID" };

/**
 * Resolve a presented token to its holder. Side effects, all on the token's own
 * row: an active token past `expiresAt` is stamped `expired`; one whose holder
 * is deactivated, or no longer has the role it was issued under, is revoked
 * (the lifecycle hooks are best-effort, this closes the gap); and a refused
 * revoked/expired token writes one ActivityRow per token per hour.
 *
 * The lookup is by sha256 of the token (a unique column), so the database
 * compares hashes and a timing difference tells an attacker about a hash, not
 * about the token; the equality is then confirmed in constant time anyway.
 */
export async function resolvePmApiTokenPrincipal(
  prisma: PrismaClient,
  presented: unknown,
  now = new Date(),
): Promise<PmApiTokenAuth> {
  if (
    typeof presented !== "string" ||
    !presented.startsWith(PM_API_PUBLIC_PREFIX) ||
    presented.length > PRESENTED_MAX_LENGTH
  ) {
    return INVALID;
  }
  const hash = hashPmApiToken(presented);
  const [row, enabled] = await Promise.all([
    prisma.pmApiToken.findUnique({
      where: { hash },
      include: { user: { select: { id: true, username: true, displayName: true, role: true, directoryStatus: true } } },
    }),
    isPmApiTokensEnabled(prisma),
  ]);
  if (!row) return INVALID;
  const stored = Buffer.from(row.hash, "hex");
  const given = Buffer.from(hash, "hex");
  if (stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) return INVALID;

  // Off revokes nothing: the token is still `active` and works again when the
  // switch comes back on. It is not even refused-and-audited — nobody misused it.
  if (!enabled) return { ok: false, code: "TOKEN_DISABLED" };

  let status = row.status as Status;
  let reason: "revoked" | "expired" | "user_deactivated" | "role_changed" | null = null;
  if (status === "revoked") reason = "revoked";
  else if (status === "expired") reason = "expired";
  else if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    await prisma.pmApiToken.updateMany({ where: { id: row.id, status: "active" }, data: { status: "expired" } });
    status = "expired";
    reason = "expired";
  } else if (row.user.directoryStatus !== "ACTIVE") {
    await stampRevoked(prisma, row.id, "user_deactivated", now);
    status = "revoked";
    reason = "user_deactivated";
  } else if (row.user.role !== row.issuedRole) {
    // A promotion or a demotion whose lifecycle revoke did not land: finish it
    // here, or putting the role back would silently bring the token back.
    await stampRevoked(prisma, row.id, "role_changed", now);
    status = "revoked";
    reason = "role_changed";
  }
  if (status !== "active" || reason !== null) {
    await auditRefusal(prisma, row, reason ?? "revoked", now);
    return { ok: false, code: status === "expired" ? "TOKEN_EXPIRED" : "TOKEN_REVOKED" };
  }

  return {
    ok: true,
    tokenId: row.id,
    scopes: normalizeScopes(row.scopes),
    principal: {
      id: row.user.id,
      username: row.user.username,
      displayName: row.user.displayName,
      role: row.user.role as Role,
    },
  };
}

function stampRevoked(
  prisma: PrismaClient,
  id: string,
  reason: "user_deactivated" | "role_changed",
  now: Date,
): Promise<unknown> {
  return prisma.pmApiToken.updateMany({
    where: { id, status: "active" },
    data: { status: "revoked", revokedAt: now, revokedReason: reason },
  });
}

const REFUSAL_WHAT = {
  revoked: "API token refused: token revoked",
  expired: "API token refused: token expired",
  user_deactivated: "API token refused: account deactivated",
  role_changed: "API token refused: role changed",
} as const;

async function auditRefusal(
  prisma: PrismaClient,
  row: { id: string; userId: string; name: string },
  reason: keyof typeof REFUSAL_WHAT,
  now: Date,
): Promise<void> {
  // The conditional write is the claim: two concurrent refusals cannot both win it.
  const claimed = await prisma.pmApiToken.updateMany({
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
    what: REFUSAL_WHAT[reason],
    sub: row.name,
    // Never the token or any part of it — the row id is the non-secret handle.
    refs: { tokenId: row.id, userId: row.userId, reason },
    actor: { type: "system", id: null },
  });
}

// ── lastUsedAt, at most once a minute per token ─────────────────────────────

/** When THIS process last wrote each token's `lastUsedAt` (the first throttle: no statement at all). */
const lastWrite = new Map<string, number>();

/**
 * An admitted request: `lastUsedAt` at most once a minute per token. Accounting
 * only — a failed write is logged, never a refusal. The in-memory memo spares
 * the statement on every request inside the minute; the conditional write
 * keeps the once-a-minute bound across a restart.
 */
export async function recordPmApiTokenUse(prisma: PrismaClient, tokenId: string, now = new Date()): Promise<void> {
  const last = lastWrite.get(tokenId);
  if (last !== undefined && now.getTime() - last < LAST_USED_EVERY_MS) return;
  lastWrite.set(tokenId, now.getTime());
  if (lastWrite.size > 1000) {
    for (const [id, at] of lastWrite) if (now.getTime() - at >= LAST_USED_EVERY_MS) lastWrite.delete(id);
  }
  await prisma.pmApiToken
    .updateMany({
      where: {
        id: tokenId,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_EVERY_MS) } }],
      },
      data: { lastUsedAt: now },
    })
    .catch((err) => logger.warn({ err, tokenId }, "api token last-used not recorded"));
}

/** Test seam: forget the in-memory memo. */
export function resetPmApiTokenUseMemo(): void {
  lastWrite.clear();
}

// ── The prisma authMiddleware and the lifecycle hooks share ─────────────────
//
// `middleware/auth.ts` holds no database client of its own (WARP-2994 removed
// it with the Nextcloud fallback) and the rail-6 post-effects in
// role-mutation-guard.service.ts carry none either, so `createApp` binds one
// here before the first request — the extension-principal precedent. Unbound,
// every token is refused and no revoke can run (logged), which is the closed
// side for both.

let boundPrisma: PrismaClient | null = null;

export function bindPmApiTokenPrisma(prisma: PrismaClient | null): void {
  boundPrisma = prisma;
}

/** `resolvePmApiTokenPrincipal` over the bound client; unbound refuses. */
export async function resolveBoundPmApiTokenPrincipal(presented: unknown): Promise<PmApiTokenAuth> {
  if (!boundPrisma) return INVALID;
  return resolvePmApiTokenPrincipal(boundPrisma, presented);
}

/** `recordPmApiTokenUse` over the bound client; never throws, never waits for the caller. */
export function recordBoundPmApiTokenUse(tokenId: string): void {
  if (!boundPrisma) return;
  void recordPmApiTokenUse(boundPrisma, tokenId);
}

/**
 * Revoke every token `userId` holds that is not already revoked. Best-effort;
 * never throws — `resolvePmApiTokenPrincipal` refuses a deactivated holder (and a
 * holder whose role changed) on its own, so a revoke that did not land here
 * still cannot be used.
 */
export async function revokePmApiTokensForUser(
  userId: string,
  reason: "user_deactivated" | "role_changed",
  actor: ActivityActor,
): Promise<void> {
  if (!boundPrisma) {
    logger.error({ userId, reason }, "WARP-3533: API token revoke not wired (bindPmApiTokenPrisma) — API tokens were NOT revoked");
    return;
  }
  try {
    const revoked = await boundPrisma.pmApiToken.updateMany({
      where: { userId, status: { in: ["active", "expired"] } },
      data: { status: "revoked", revokedAt: new Date(), revokedReason: reason },
    });
    if (revoked.count === 0) return;
    await recordActivity({
      kind: "auth",
      severity: "warn",
      sourceIcon: "key-round",
      what: "API tokens revoked",
      sub: reason === "user_deactivated" ? "account deactivated" : "role changed",
      refs: { userId, revoked: revoked.count, reason },
      actor,
    });
  } catch (err) {
    logger.error({ err, userId, reason }, "WARP-3533: API token revoke failed (every use still re-checks the holder)");
  }
}
