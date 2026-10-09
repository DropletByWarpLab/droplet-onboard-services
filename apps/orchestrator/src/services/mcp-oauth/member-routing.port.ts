/**
 * WARP-2409 — which sign-in a remote MCP call runs under.
 *
 * Sits INSIDE `createGatedRemoteMcpPort`, so the gate and the audit run once per
 * call. Order, never reordered:
 *   1. the asking member's own sign-in,
 *   2. the Workspace connection,
 *   3. the shared API token (the base session),
 *   4. otherwise a sentence asking them to sign in.
 *
 * Fail closed on identity: a failed lookup throws (the gate reports a provider
 * error) rather than falling through to a broader credential, and a member whose
 * sign-in needs renewing is told so rather than silently served as someone else.
 * Signing in never bypasses the interceptor: this port only chooses the
 * credential, the multiplexer in front of it still confirms writes.
 */
import { createLogger } from "../../lib/logger.js";
import type { McpClientPort, McpToolCallOutcome, McpToolDescriptor } from "../mcp-client.port.js";
import { McpBridgeError, type McpBridgeClient } from "../mcp-bridge.client.js";
import { remoteCallAttribution } from "../remote-call-attribution.js";
import {
  errorOutcome,
  type CredentialAttributingPort,
  type RemoteMcpCredentialKind,
  type RemoteMcpSignInRefusal,
} from "../remote-mcp-gateway.service.js";
import { mcpOAuthRefresher } from "./mcp-oauth-refresher.js";
import { openTokens } from "./mcp-oauth.service.js";

const logger = createLogger("mcp-member-routing");

/** Renew a token that stops working within this window before using it. */
export const REFRESH_AHEAD_MS = 60_000;

export interface OAuthRowLite {
  id: string;
  provider: string;
  scope: "MEMBER" | "WORKSPACE";
  memberId: string | null;
  state: string;
  tokensEnc: string | null;
  tokenExpiresAt: Date | null;
}

/** The slice of Prisma this port reads. */
export interface MemberRoutingPrisma {
  user: { findFirst(args: unknown): Promise<{ id: string } | null> };
  mcpOAuthConnection: {
    findFirst(args: unknown): Promise<OAuthRowLite | null>;
    findUnique(args: unknown): Promise<OAuthRowLite | null>;
  };
  integrationConnection: { findFirst(args: unknown): Promise<{ providerConfig: unknown } | null> };
}

export interface MemberRoutingOptions {
  serverId: string;
  /** The base bridge client: the catalog session, and the home of `callToolFor`. */
  client: Pick<McpBridgeClient, "open" | "callToolFor" | "lastAdvertisedToolNames" | "closeEpoch">;
  /** The port the multiplexer talked to before this one (the base session). */
  base: McpClientPort;
  /** What the base (catalog) session was opened with; "api-token" enables rung 3. */
  baseCredential: RemoteMcpCredentialKind;
  prisma: MemberRoutingPrisma;
  now?: () => Date;
}

const REFUSALS: Record<RemoteMcpSignInRefusal, string> = {
  REMOTE_SIGN_IN_REQUIRED:
    "You haven't signed in to Atlassian yet. Open Settings › Connected services (or Integrations › Connector credentials) and choose Sign in with Atlassian, then ask again.",
  REMOTE_SIGN_IN_EXPIRED:
    "Your Atlassian sign-in has expired. Open Settings › Connected services (or Integrations › Connector credentials) and choose Sign in with Atlassian again, then ask again.",
};

export function createMemberRoutingPort(opts: MemberRoutingOptions): CredentialAttributingPort {
  const { serverId, client, base, prisma } = opts;
  const now = opts.now ?? (() => new Date());
  /** connection id -> the sealed token blob its bridge session was opened with. */
  const openedWith = new Map<string, string>();
  const opening = new Map<string, Promise<void>>();
  let epoch = client.closeEpoch;

  const refuse = (tool: string, refusal: RemoteMcpSignInRefusal) =>
    ({ outcome: errorOutcome(refusal, tool, REFUSALS[refusal]), refusal }) as const;

  const usable = (row: OAuthRowLite) => usableConnection(prisma, row, now);

  async function cloudId| null> {
    let current: OAuthRowLite | null = row;
    const expiry = current.tokenExpiresAt?.getTime();
    if (expiry !== undefined && expiry - now().getTime() < REFRESH_AHEAD_MS) {
      const outcome = (await mcpOAuthRefresher()?.refreshNow(row.id)) ?? "unavailable";
      if (outcome === "needs_reconnect") return null;
      if (outcome === "refreshed") current = await prisma.mcpOAuthConnection.findUnique({ where: { id: row.id } });
      // Unavailable: keep the held token only while it still works.
      else if (expiry <= now().getTime()) return null;
    }
    return current && current.state === "CONNECTED" && current.tokensEnc ? current : null;
  }

  async function cloudId(): Promise<string | null> {
    const c = await prisma.integrationConnection.findFirst({ where: { provider: serverId }, select: { providerConfig: true } });
    const v = (c?.providerConfig as Record<string, unknown> | null)?.cloudId;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }

  async function ensureSession(row: OAuthRowLite): Promise<void> {
    if (client.closeEpoch !== epoch) { openedWith.clear(); opening.clear(); epoch = client.closeEpoch; }
    if (openedWith.get(row.id) === row.tokensEnc) return;
    const inflight = opening.get(row.id);
    if (inflight) return inflight;
    const p = (async () => {
      const tokens = openTokens({ id: row.id, scope: row.scope, memberId: row.memberId, tokensEnc: row.tokensEnc });
      const site = await cloudId();
      if (!site) throw new McpBridgeError("REMOTE_CALL_FAILED", `The ${serverId} connection has no site id.`, 0);
      const known = client.lastAdvertisedToolNames();
      await client.open({
        accessToken: tokens.accessToken,
        cloudId: site,
        connectionId: row.id,
        ...(known.length > 0 ? { knownTools: known } : {}),
      });
      openedWith.set(row.id, row.tokensEnc!);
    })().finally(() => opening.delete(row.id));
    opening.set(row.id, p);
    return p;
  }

  async function via(row: OAuthRowLite, name: string, args: Record<string, unknown>, kind: RemoteMcpCredentialKind) {
    const live = await usable(row);
    if (!live) return refuse(name, "REMOTE_SIGN_IN_EXPIRED");
    try {
      await ensureSession(live);
      return { outcome: await client.callToolFor(live.id, name, args), credential: kind } as const;
    } catch (err) {
      if (!(err instanceof McpBridgeError && err.code === "NO_SESSION")) throw err;
      // The bridge restarted or evicted it: open once more and retry once.
      openedWith.delete(live.id);
      await ensureSession(live);
      return { outcome: await client.callToolFor(live.id, name, args), credential: kind } as const;
    }
  }

  const port: CredentialAttributingPort = {
    get isStarted() { return base.isStarted; },
    catalogCredential: opts.baseCredential,
    listTools: (): Promise<McpToolDescriptor[]> => base.listTools(),
    callTool: async (name, args): Promise<McpToolCallOutcome> => (await port.callToolAttributed(name, args)).outcome,
    async callToolAttributed(name, args) {
      const username = remoteCallAttribution()?.userId;
      let member: OAuthRowLite | null = null;
      if (username) {
        const user = await prisma.user.findFirst({ where: { username }, select: { id: true } });
        if (user) member = await prisma.mcpOAuthConnection.findFirst({ where: { provider: serverId, scope: "MEMBER", memberId: user.id } });
      }
      // A member whose own sign-in died is told so: no silent switch to another identity.
      if (member?.state === "NEEDS_RECONNECT") return refuse(name, "REMOTE_SIGN_IN_EXPIRED");
      if (member?.state === "CONNECTED") return via(member, name, args, "member");

      const workspace = await prisma.mcpOAuthConnection.findFirst({ where: { provider: serverId, scope: "WORKSPACE" } });
      if (workspace?.state === "CONNECTED") return via(workspace, name, args, "workspace");

      if (opts.baseCredential === "api-token" && base.isStarted) {
        return { outcome: await base.callTool(name, args), credential: "api-token" } as const;
      }
      logger.info({ serverId, hasMember: !!member, hasWorkspace: !!workspace }, "remote_mcp_sign_in_required");
      return refuse(name, workspace?.state === "NEEDS_RECONNECT" ? "REMOTE_SIGN_IN_EXPIRED" : "REMOTE_SIGN_IN_REQUIRED");
    },
  };
  return port;
}

/**
 * The connection row as it can be used right now: renewed first when its token
 * stops working within {@link REFRESH_AHEAD_MS}, or null when it cannot be used
 * (needs sign-in again, no longer CONNECTED, or expired with no way to renew).
 */
export async function usableConnection(
  prisma: Pick<MemberRoutingPrisma, "mcpOAuthConnection">,
  row: OAuthRowLite,
  now: () => Date = () => new Date(),
): Promise<OAuthRowLite | null> {
  let current: OAuthRowLite | null = row;
  const expiry = current.tokenExpiresAt?.getTime();
  if (expiry !== undefined && expiry - now().getTime() < REFRESH_AHEAD_MS) {
    const outcome = (await mcpOAuthRefresher()?.refreshNow(row.id)) ?? "unavailable";
    if (outcome === "needs_reconnect") return null;
    if (outcome === "refreshed") current = await prisma.mcpOAuthConnection.findUnique({ where: { id: row.id } });
    // Unavailable: keep the held token only while it still works.
    else if (expiry <= now().getTime()) return null;
  }
  return current && current.state === "CONNECTED" && current.tokensEnc ? current : null;
}
