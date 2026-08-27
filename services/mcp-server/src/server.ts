import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TOOLS,
  type PrivateEnhancement,
  type Tool,
  type ToolResult,
} from "@droplet/tools-core";
import { buildContext, type ContextDeps, type Claims } from "./context.js";
import { canCallTool, filterToolsForRole } from "./rbac.js";
import { describeThrown } from "./thrown-cause.js";

const SERVER_INFO = { name: "droplet-mcp-server", version: "0.1.0" };

/**
 * The caller's trust posture, declared explicitly by the transport that
 * constructs the server. Trust is an AFFIRMATIVE input — it is NEVER inferred
 * from the absence of a claims object (WARP-563). Two postures exist:
 *
 *   - `local-trusted` — the in-process stdio child the orchestrator spawns.
 *     This is the ONLY trusted path: every tool is available and RBAC is
 *     bypassed. It carries no principal claims by construction.
 *   - `authenticated` — the network-facing HTTP transport. Untrusted: the
 *     verified-JWT `claims` are required and RBAC is enforced on every
 *     `tools/list` / `tools/call`.
 *
 * Fail-closed: any value that is not `local-trusted` (including a future
 * transport that forgets to declare a posture) yields `trustedPrincipal =
 * false` and an undefined role, so the rbac.ts helpers deny write tools.
 */
export type TrustContext =
  | { kind: "local-trusted" }
  | { kind: "authenticated"; claims: Claims };

export function createServer(deps: ContextDeps, trust: TrustContext) {
  // Trust is derived solely from the declared posture, not from the presence
  // or absence of claims. Only `local-trusted` is trusted; everything else
  // (authenticated, or any unrecognized shape) is untrusted and RBAC-gated.
  const trustedPrincipal = trust.kind === "local-trusted";
  const claims: Claims | undefined =
    trust.kind === "authenticated" ? trust.claims : undefined;

  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Per spec §6.3 + §12 (WARP-103): tools/list is filtered by the
    // caller's role. Trusted principal (stdio in-proc agent) sees every
    // tool. owner/admin see every tool. family/guest (and any HTTP request
    // with a missing role) see read-only tools.
    const tools = filterToolsForRole(TOOLS.values(), claims?.role, {
      trustedPrincipal,
    }).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool: Tool | undefined = TOOLS.get(req.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `Unknown tool: ${req.params.name}` }) },
        ],
        isError: true,
      };
    }

    // Re-check on dispatch — tools/list cache could be stale, or a client
    // could try to call a write tool by name without listing it first.
    if (!canCallTool(tool, claims?.role, { trustedPrincipal })) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: {
                code: "forbidden_tool_for_role",
                message: `role '${claims?.role ?? "none"}' may not call '${tool.name}'`,
              },
            }),
          },
        ],
        isError: true,
      };
    }

    // Per-call session context arrives via the MCP `_meta` field
    // (reserved by the spec for protocol metadata that must NOT be
    // forwarded as tool arguments). Today this carries:
    //   - `ncToken` (since WARP-104) — Nextcloud session token for file
    //     tools to authenticate as the calling user.
    //   - `userId`  (since WARP-202) — Nextcloud username for tools that
    //     gate on the per-user RBAC boundary (e.g. `search_content`'s
    //     pgvector lookup). On the HTTP transport, `claims.sub` is the
    //     authoritative userId and `_meta.userId` is ignored to keep the
    //     trust boundary at the JWT.
    //
    // On stdio (in-process trusted), the orchestrator passes both. On
    // HTTP, claims-based RBAC is the auth surface and `_meta.*` carries
    // only ncToken.
    const meta = (req.params as { _meta?: Record<string, unknown> })._meta;
    const ncToken =
      meta && typeof meta.ncToken === "string" && meta.ncToken.length > 0
        ? meta.ncToken
        : undefined;
    const metaUserId =
      meta && typeof meta.userId === "string" && meta.userId.length > 0
        ? meta.userId
        : undefined;
    // WARP-437: orchestrator-injected query-enhancement bundle (HyDE
    // vector, paraphrase vectors, soft filename filter, search overrides)
    // arrives via `_meta._enhancement`. Trusted-stdio-only by design —
    // the HTTP transport ignores it (an attacker on HTTP could otherwise
    // smuggle precomputed vectors past the schema validator). We gate on
    // `trustedPrincipal` to make the trust boundary explicit.
    // WARP-845 — caller's role for role-scoped reads (memory_recall's
    // audience ladder). Trusted-stdio only, same posture as
    // `_enhancement`: an HTTP client could otherwise claim `owner` and
    // widen its memory read. Absent role → handlers fall back to the
    // most-restrictive guest view.
    const metaUserRole =
      trustedPrincipal &&
      meta &&
      typeof meta.userRole === "string" &&
      meta.userRole.length > 0
        ? meta.userRole
        : undefined;
    const metaEnhancement =
      trustedPrincipal &&
      meta &&
      typeof meta._enhancement === "object" &&
      meta._enhancement !== null &&
      !Array.isArray(meta._enhancement)
        ? (meta._enhancement as PrivateEnhancement)
        : undefined;
    const ctx = buildContext(
      deps,
      claims,
      extra.signal,
      ncToken,
      metaUserId,
      metaEnhancement,
      metaUserRole,
    );
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let result: ToolResult;
    try {
      result = await tool.handler(args, ctx);
    } catch (err) {
      result = {
        ok: false,
        status: "error",
        // WARP-1480 — `describeThrown` appends the CAUSE CHAIN. Taking only
        // `err.message` collapsed every undici failure to the same two words
        // ("fetch failed") and discarded the errno on `err.cause`, which is
        // the one value that tells a reset socket from a DNS failure from a
        // headers timeout. That loss is why `read_file`'s intermittent error
        // was unattributable.
        error: { code: "HANDLER_THREW", message: describeThrown(err) },
      };
    }
    return toolResultToContent(result);
  });

  return server;
}

export function toolResultToContent(result: ToolResult): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data) }],
      isError: false,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: result.status,
          error: result.error,
        }),
      },
    ],
    // confirmation_required is NOT a hard error from the model's perspective —
    // it's the expected outcome of calling a destructive tool without prior approval.
    isError: result.status === "error",
  };
}
