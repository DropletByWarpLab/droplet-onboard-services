/**
 * WARP-3061 — the person behind an `_service:mcp` call.
 *
 * ## What the header carries
 *
 * The mcp-server stamps `X-Nextcloud-User` on every orchestrator call
 * (services/mcp-server/src/context.ts `withActingUser`), and every tools-core
 * handler that sets it by hand sends the same value: `ctx.userId`, which is
 * `claims?.sub ?? _meta.userId`. Despite the header's name it is NOT a
 * Nextcloud username:
 *
 *   - stdio (chat, the agent-run worker, the ToolSpec runner): `_meta.userId`
 *     is the orchestrator's `req.user.username`, i.e. `User.username` from
 *     the JWT (jwt.service.ts). The OCS fallback that could put a Nextcloud
 *     login there is gone (WARP-2994).
 *   - HTTP (the shipped mcp-server container runs `--transport=http`):
 *     `claims.sub`, i.e. `User.id`.
 *
 * A Nextcloud-mirror row has `username === nextcloudUsername` by convention,
 * which is why resolving by `nextcloudUsername` worked for those rows and
 * denied every SSO / SCIM row, where it is NULL.
 *
 * ## The rule
 *
 * The value is matched against `username`, `nextcloudUsername` and `id` at
 * once. Each column is unique, so each names at most one row:
 *
 *   - exactly one distinct row  → that person;
 *   - no row                    → nobody;
 *   - two or more distinct rows → ambiguous. One person's `username` being
 *     another's `nextcloudUsername` says nothing about which of them is
 *     asking, and picking one acts for the wrong person with the wrong
 *     person's reach.
 *
 * Callers deny on both failures. `nextcloudUsername` stays in the match so a
 * value that resolved before WARP-3061 still resolves (unless it is now
 * ambiguous); agreement across the columns replaces any precedence order.
 */
import type { PrismaClient } from "@prisma/client";

export interface AssertedUser {
  /** LOCAL `User.id` UUID — what every access decision is keyed on. */
  id: string;
  role: string;
}

export type AssertedUserResolution =
  | { ok: true; user: AssertedUser }
  | { ok: false; reason: "not_found" | "ambiguous" };

export async function resolveAssertedUser(
  prisma: PrismaClient,
  asserted: string,
): Promise<AssertedUserResolution> {
  // Two rows are the fewest that tell "one person" from "more than one".
  const rows = await prisma.user.findMany({
    where: { OR: [{ username: asserted }, { nextcloudUsername: asserted }, { id: asserted }] },
    select: { id: true, role: true },
    take: 2,
  });
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  if (rows.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, user: rows[0] };
}
