import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TOOLS,
  defaultToolCallInterceptor,
  interceptOutcomeToToolResult,
  type PrivateEnhancement,
  type Tool,
  type ToolCallInterceptor,
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

/**
 * WARP-2305 / WARP-2340 — dispatch-path options.
 *
 * `additionalTools` is the seam for tools we did NOT author: a remote MCP
 * server's tools under WARP-320 are not in the compile-time `registry.ts`
 * array, and for that class handler-side enforcement cannot work even in
 * principle because there is no handler of ours. Anything supplied here
 * goes through the SAME RBAC check and the SAME interceptor as a registry
 * tool. Registry tools win a name collision, so a remote server cannot
 * shadow one of ours.
 *
 * `interceptor` is injectable for tests only; production uses the shared
 * `defaultToolCallInterceptor` so the local agent loop and external MCP
 * clients cannot drift onto two different gates.
 */
export interface ServerOptions {
  additionalTools?: ReadonlyMap<string, Tool>;
  interceptor?: ToolCallInterceptor;
}

export function createServer(
  deps: ContextDeps,
  trust: TrustContext,
  options: ServerOptions = {},
) {
  const additionalTools = options.additionalTools;
  const interceptor = options.interceptor ?? defaultToolCallInterceptor;
  const resolveTool = (name: string): Tool | undefined =>
    TOOLS.get(name) ?? additionalTools?.get(name);
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
    const advertised = additionalTools
      ? [...TOOLS.values(), ...additionalTools.values()]
      : [...TOOLS.values()];
    const tools = filterToolsForRole(advertised, claims?.role, {
      trustedPrincipal,
    }).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool: Tool | undefined = resolveTool(req.params.name);
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

    // WARP-2305 — THE GENERIC CONFIRMATION GATE + RUNTIME DENY TIER.
    //
    // This is the only site in the repo that calls `tool.handler(...)`,
    // and every dispatch path reaches it: the in-process agent loop
    // (llm-agent.service.ts → McpClientService → stdio), ToolSpec runs,
    // and external MCP clients over HTTP. Enforcing here is what makes
    // `requiresConfirmation` a mechanism instead of a convention, and it
    // covers tools we did not author, which have no handler of ours to do
    // it (WARP-320).
    //
    // It runs BEFORE the handler, so an unconfirmed or denied call never
    // reaches handler code and performs no write — asserted with a
    // handler spy, not just on the response.
    //
    // The token arrives on `_meta`, the transport's channel for protocol
    // metadata that must not become a tool argument (same channel as
    // ncToken / userId / _enhancement). That keeps it clear of every
    // tool's `additionalProperties: false` schema and keeps the binding
    // hash over untouched arguments.
    const confirmationToken =
      meta && typeof meta.confirmationToken === "string" && meta.confirmationToken.length > 0
        ? meta.confirmationToken
        : undefined;
    const outcome = interceptor.intercept(tool, args, { confirmationToken });
    const refusal = interceptOutcomeToToolResult(tool, outcome);
    if (refusal) {
      return toolResultToContent(refusal);
    }
    // `outcome.args` — not `args`. On a call whose token verified, the
    // interceptor sets `confirmed: true` for tools whose schema declares
    // it, which is what stops the 16 hand-rolled `args.confirmed !== true`
    // gates from raising a SECOND prompt (WARP-2322).
    const effectiveArgs =
      outcome.kind === "proceed" ? outcome.args : args;

    let result: ToolResult;
    try {
      result = await tool.handler(effectiveArgs, ctx);
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
