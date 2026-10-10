/**
 * WARP-2416 - refresh MCP sign-ins BEFORE they expire, so no call pays a 401.
 *
 * Scheduling goes through `cron-runtime.service.ts` (one interval, one advisory
 * lock) - no timer or loop of its own. The same `refreshNow` serves dispatch
 * (member-routing.port.ts renews a token that ends within 60 s), and it is
 * single-flight per connection, so two callers never both spend the refresh
 * token (a rotating server would reject the second).
 *
 * Fail closed: a token endpoint whose host is not the one pinned at sign-in is
 * refused (state ERROR), a refresh the server rejects as `invalid_grant`
 * moves the row to NEEDS_RECONNECT (a stored state, not an inference from a
 * missing token) with an audit row, and nothing here ever logs a token.
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../lib/logger.js";
import { recordActivity } from "../activity.singleton.js";
import { McpBridgeError, OAUTH_TOKEN_ERROR, type McpBridgeOAuthClient } from "../mcp-bridge.client.js";
import type { RemoteMcpEgressDecision } from "../remote-mcp-gateway.service.js";
import type { CronRuntime } from "../cron-runtime.service.js";
import { registerMcpOAuthRefresher, type McpOAuthRefresher, type McpOAuthRefreshOutcome } from "./mcp-oauth-refresher.js";
import { openClientSecret, openTokens, sealTokens, tokenTtlSeconds } from "./mcp-oauth.service.js";

const logger = createLogger("mcp-oauth-refresh");

export const MCP_OAUTH_REFRESH_INTERVAL_MS = 60_000;
/** A token is renewed once it has less than this left. */
export const MCP_OAUTH_REFRESH_AHEAD_MS = 10 * 60_000;
export const MCP_OAUTH_REFRESH_LOCK_KEY = "droplet:mcp-oauth-refresh";
/** Bound on rows one tick works through. */
const TICK_BATCH = 100;

export interface McpOAuthRefreshDeps {
  prisma: PrismaClient;
  oauth: Pick<McpBridgeOAuthClient, "refresh">;
  now?: () => Date;
  /** Ends the connection's live bridge session after its sign-in died. Best effort. */
  closeSession?: (provider: string, connectionId: string) => Promise<void>;
  /**
   * WARP-2416 - this row just refreshed, or its sign-in just ended. If it backs a
   * server's catalog session, that session is re-opened (or re-picked, or the
   * server detached). Not awaited: a refresh on the call path must not wait for it.
   */
  catalogChanged?: (provider: string, connectionId: string) => Promise<void>;
  /**
   * The rules every remote MCP call obeys (allowlist, `remote_mcp` channel, not
   * DISABLED). A refresh is a hop to the vendor like any other, so a refusal
   * skips it WITHOUT touching the row: the token is simply not renewed while
   * remote MCP is off, and nothing is marked NEEDS_RECONNECT for that.
   */
  egress: (prisma: PrismaClient, serverId: string) => Promise<RemoteMcpEgressDecision>;
}

/** The bridge's answer for a refresh the authorization server rejected as a dead grant
 *  (502 `OAUTH_TOKEN_ERROR`, `oauthError: "invalid_grant"`). Anything else is transient. */
const isInvalidGrant = (err: unknown): boolean =>
  err instanceof McpBridgeError && err.code === OAUTH_TOKEN_ERROR && err.reason === "invalid_grant";

export function createMcpOAuthRefresher(deps: McpOAuthRefreshDeps): McpOAuthRefresher & { tick(): Promise<void> } {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<McpOAuthRefreshOutcome>>();
  const catalogChanged = (provider: string, id: string): void => {
    void deps.catalogChanged?.(provider, id).catch(() => undefined);
  };

  async function endSignIn(
    row: { id: string; provider: string; tokensEnc: string | null },
    state: "NEEDS_RECONNECT" | "ERROR",
    lastError: string,
    clearTokens: boolean,
  ): Promise<void> {
    // Conditional on the blob we read: a sign-in completed meanwhile is not clobbered.
    const res = await prisma.mcpOAuthConnection.updateMany({
      where: { id: row.id, tokensEnc: row.tokensEnc },
      data: { state, lastError, ...(clearTokens ? { tokensEnc: null, tokenExpiresAt: null } : {}) },
    });
    if (res.count !== 1) return;
    try {
      await recordActivity({
        kind: "auth", severity: "warn", sourceIcon: "cloud",
        what: state === "NEEDS_RECONNECT" ? `Sign-in to ${row.provider} needs to be done again` : `Sign-in to ${row.provider} stopped refreshing`,
        sub: lastError, actor: { type: "ai", id: null },
        refs: { connector: row.provider, connectionId: row.id, state, reason: lastError },
      });
    } catch {
      logger.warn({ provider: row.provider }, "mcp_oauth_refresh_audit_failed");
    }
    await deps.closeSession?.(row.provider, row.id).catch(() => undefined);
    // The catalog session may have been riding this row: re-pick or detach it.
    catalogChanged(row.provider, row.id);
  }

  async function run(id: string): Promise<McpOAuthRefreshOutcome> {
    const row = await prisma.mcpOAuthConnection.findUnique({ where: { id } });
    if (!row) return "unavailable";
    if (row.state === "NEEDS_RECONNECT") return "needs_reconnect";
    if (row.state !== "CONNECTED" || !row.tokensEnc || !row.clientId) return "unavailable";

    // Before anything is opened or dialled: not while remote MCP may not talk to this server.
    // The row is left exactly as it is (a read failure refuses too).
    try {
      if (!(await deps.egress(prisma, row.provider)).allowed) return "unavailable";
    } catch {
      return "unavailable";
    }

    let blob: ReturnType<typeof openTokens>;
    let clientSecret: string | undefined;
    try {
      blob = openTokens(row);
      clientSecret = openClientSecret(row);
    } catch {
      // Sealed for another row or owner, or damaged: not a credential.
      await endSignIn(row, "ERROR", "tokens_unreadable", false);
      return "unavailable";
    }
    // The pinned host (ADR-072 §1/§2): a stored endpoint on any other host is never dialled.
    let host: string | null = null;
    try {
      const u = new URL(blob.tokenEndpoint);
      host = u.protocol === "https:" ? u.host : null;
    } catch { /* host stays null */ }
    if (host === null || host !== row.tokenEndpointHost) {
      await endSignIn(row, "ERROR", "token_endpoint_host_changed", false);
      return "unavailable";
    }

    const expired = row.tokenExpiresAt !== null && row.tokenExpiresAt.getTime() <= now().getTime();
    if (!blob.refreshToken) {
      // Nothing to renew with: ask for a new sign-in once the token has actually stopped working.
      if (!expired) return "unavailable";
      await endSignIn(row, "NEEDS_RECONNECT", "no_refresh_token", true);
      return "needs_reconnect";
    }

    try {
      const out = await deps.oauth.refresh({
        tokenEndpoint: blob.tokenEndpoint,
        clientId: row.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        refreshToken: blob.refreshToken,
        resource: blob.resource,
        // Never widened: ask for what was granted.
        scope: blob.scope,
      });
      const at = now();
      const expiresAt = new Date(at.getTime() + tokenTtlSeconds(out.expiresIn) * 1000);
      const tokensEnc = sealTokens(row, {
        ...blob,
        accessToken: out.accessToken,
        // Rotating servers send a new refresh token; non-rotating ones keep the old one valid.
        refreshToken: out.refreshToken ?? blob.refreshToken,
        expiresAt: expiresAt.toISOString(),
        scope: out.scope ?? blob.scope,
      });
      const written = await prisma.mcpOAuthConnection.updateMany({
        where: { id: row.id, state: "CONNECTED", tokensEnc: row.tokensEnc },
        data: { tokensEnc, tokenExpiresAt: expiresAt, lastRefreshOkAt: at, lastError: null },
      });
      if (written.count === 1) {
        catalogChanged(row.provider, row.id);
        return "refreshed";
      }
      // Someone else changed the row while we were at the vendor; do not overwrite it.
      const now2 = await prisma.mcpOAuthConnection.findUnique({ where: { id } });
      return now2?.state === "CONNECTED" && now2.tokensEnc !== row.tokensEnc ? "refreshed" : "unavailable";
    } catch (err) {
      if (isInvalidGrant(err)) {
        await endSignIn(row, "NEEDS_RECONNECT", "refresh_rejected", true);
        return "needs_reconnect";
      }
      if (expired) {
        // It cannot be renewed and it no longer works.
        await endSignIn(row, "NEEDS_RECONNECT", "refresh_failed_after_expiry", true);
        return "needs_reconnect";
      }
      // Transient (network, 5xx): keep the sign-in, try again next tick.
      logger.warn({ provider: row.provider }, "mcp_oauth_refresh_failed");
      await prisma.mcpOAuthConnection.updateMany({ where: { id: row.id, tokensEnc: row.tokensEnc }, data: { lastError: "refresh_failed" } });
      return "unavailable";
    }
  }

  const refreshNow = (id: string): Promise<McpOAuthRefreshOutcome> => {
    const running = inFlight.get(id);
    if (running) return running;
    const p = run(id).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  };

  return {
    refreshNow,
    async tick() {
      const due = await prisma.mcpOAuthConnection.findMany({
        where: { state: "CONNECTED", tokenExpiresAt: { lt: new Date(now().getTime() + MCP_OAUTH_REFRESH_AHEAD_MS) } },
        select: { id: true },
        take: TICK_BATCH,
      });
      for (const { id } of due) {
        try {
          await refreshNow(id);
        } catch (err) {
          logger.error({ err }, "mcp_oauth_refresh_row_failed");
        }
      }
    },
  };
}

/**
 * Mount the refresh tick on the cron runtime and register the refresher dispatch
 * calls into. `lockKey` makes it one worker box-wide (an advisory lock).
 */
export function mountMcpOAuthRefresh(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  deps: McpOAuthRefreshDeps,
): McpOAuthRefresher {
  const refresher = createMcpOAuthRefresher(deps);
  registerMcpOAuthRefresher(refresher);
  cronRuntime.scheduleInterval(MCP_OAUTH_REFRESH_INTERVAL_MS, () => refresher.tick(), {
    lockKey: MCP_OAUTH_REFRESH_LOCK_KEY,
  });
  return refresher;
}
