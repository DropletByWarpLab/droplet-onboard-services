import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TOOLS,
  confirmationOwnerOf,
  defaultToolCallInterceptor,
  interceptOutcomeToToolResult,
  type PrivateEnhancement,
  isToolWithheldByModule,
  withholdModuleTools,
  type Tool,
  type ToolCallInterceptor,
  type ToolResult,
} from "@droplet/tools-core";
import { buildContext, type ContextDeps, type Claims } from "./context.js";
import { canCallTool, isWithheldOffBox, filterToolsForRole } from "./rbac.js";
import { describeThrown } from "./thrown-cause.js";
import { FAIL_CLOSED_MODULE_SOURCE, type ModuleVerdictSource } from "./module-verdict.js";

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
  /**
   * WARP-2972 — which tool domains a module toggle (the box) or the acting
   * person's own grants withhold. Asked of the orchestrator, the only process
   * that knows the module registry (module-verdict.ts).
   *
   *   - `tools/list` on the AUTHENTICATED transport (an external MCP client):
   *     withheld tools are absent, for the JWT's subject.
   *   - `tools/call` on BOTH transports: a withheld tool is refused before its
   *     handler runs. The person is the JWT subject over HTTP and `_meta.userId`
   *     over stdio (the orchestrator is the trust boundary for that channel).
   *
   * `tools/list` on the stdio child is deliberately NOT filtered: the
   * orchestrator's client caches that list for the process lifetime, and a
   * verdict baked into it would outlive the toggle. The orchestrator applies
   * the same predicate to its pool at list time, on top of the cache.
   *
   * Absent → FAIL CLOSED (`FAIL_CLOSED_MODULE_SOURCE`): module-owned tools are
   * withheld and unclaimed domains kept. A server built without a source used
   * to withhold nothing, so a construction site that forgot the option was a
   * silent fail-open; now forgetting is safe and withholding nothing is an
   * explicit opt-out (module-verdict.ts, for tests and embedders). Both
   * production construction sites (index.ts) pass a real one, pinned by
   * server-module-gate.test.ts.
   */
  moduleVerdict?: ModuleVerdictSource;
}

export function createServer(
  deps: ContextDeps,
  trust: TrustContext,
  options: ServerOptions = {},
) {
  const additionalTools = options.additionalTools;
  const interceptor = options.interceptor ?? defaultToolCallInterceptor;
  const moduleVerdict: ModuleVerdictSource = options.moduleVerdict ?? FAIL_CLOSED_MODULE_SOURCE;
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
    const permitted = filterToolsForRole(advertised, claims?.role, { trustedPrincipal });
    // WARP-2972 — an external client's list drops what a module toggle or its
    // person's grants withhold. Not the stdio child's (see ServerOptions).
    const visible = trustedPrincipal
      ? permitted
      : withholdModuleTools(permitted, await moduleVerdict(claims?.sub));
    const tools = visible.map((t) => ({
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

    // A domain withheld off the box is refused before any role check or
    // handler: a client that calls it by name without listing it first gets
    // nothing from it.
    if (!trustedPrincipal && isWithheldOffBox(tool)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: {
                code: "withheld_off_box",
                message: "This tool is only available to Droplet's own chat on this box.",
              },
            }),
          },
        ],
        isError: true,
      };
    }

    // WARP-2972 — a tool whose domain a module toggle or this person's grants
    // withhold is refused before any role check or handler, on both transports.
    // ABSENT, so it reads like "this part of Droplet is off", not like a role
    // refusal. Over HTTP the JWT names the person and `_meta` cannot; over
    // stdio `_meta.userId` does, and a call that sends none is the box (a
    // scheduled run used to; it now carries its owner's username).
    const callMeta = (req.params as { _meta?: Record<string, unknown> })._meta;
    const asserted = trustedPrincipal
      ? typeof callMeta?.userId === "string" && callMeta.userId.length > 0
        ? callMeta.userId
        : undefined
      : claims?.sub;
    if (isToolWithheldByModule(tool.name, await moduleVerdict(asserted))) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: {
                code: "module_disabled",
                message:
                  "This part of Droplet is switched off, or is not available to this person.",
              },
            }),
          },
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
    // WARP-2180 — the durable run this dispatch belongs to. Trusted-stdio
    // only, like userRole: an HTTP client cannot claim to be a run.
    const metaAgentRunId =
      trustedPrincipal &&
      meta &&
      typeof meta.agentRunId === "string" &&
      meta.agentRunId.length > 0
        ? meta.agentRunId
        : undefined;
    // WARP-2896 — the run's workshop workspace. Same posture.
    const metaWorkspaceId =
      trustedPrincipal &&
      meta &&
      typeof meta.workspaceId === "string" &&
      meta.workspaceId.length > 0
        ? meta.workspaceId
        : undefined;
    // WARP-3299 — the chat turn (conversation, assistant message, tool
    // call) this dispatch belongs to. Same posture: an HTTP client cannot
    // attach a run it starts to someone else's conversation.
    const metaString = (key: string): string | undefined =>
      trustedPrincipal && meta && typeof meta[key] === "string" && (meta[key] as string).length > 0
        ? (meta[key] as string)
        : undefined;
    const metaTurn = {
      conversationId: metaString("conversationId"),
      messageId: metaString("messageId"),
      toolCallId: metaString("toolCallId"),
    };
    const metaEnhancement =
      trustedPrincipal &&
      meta &&
      typeof meta._enhancement === "object" &&
      meta._enhancement !== null &&
      !Array.isArray(meta._enhancement)
        ? (meta._enhancement as PrivateEnhancement)
        : undefined;
    // WARP-3116 — the pages the calling dashboard can open. Same trusted-
    // stdio posture: over HTTP a client could hand the navigation tools a
    // list of its own choosing. Passed through as-is; the handlers parse it
    // with the shared schema before it becomes a navigation target.
    const metaDashboardPages =
      trustedPrincipal && meta && Array.isArray(meta.dashboardPages)
        ? (meta.dashboardPages as unknown[])
        : undefined;
    const ctx = buildContext(
      deps,
      claims,
      extra.signal,
      ncToken,
      metaUserId,
      metaEnhancement,
      metaUserRole,
      metaAgentRunId,
      metaWorkspaceId,
      metaTurn,
      metaDashboardPages,
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
    // handler spy, not just on the response. The one exception is a tool's
    // read-only `precheck` (WARP-3349, below): an unconfirmed call the
    // interceptor is about to challenge may run it; a denied call never does.
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
    // WARP-3349 — a call that can never succeed is refused here, before the
    // person is asked to approve it (team_chat_send_message: a recipient who
    // is not a member). Only a call the interceptor is about to CHALLENGE
    // runs it: no token, a confirming tool whose confirmation the
    // interceptor owns, and not denied — the deny tier's answer wins, so a
    // denied call makes no reads and the model sees TOOL_DENIED (§8). Only
    // an error result replaces the challenge; anything else, or a throw
    // (logged, tool name only), leaves the gate below to ask, and the
    // handler validates again after approval.
    if (
      tool.precheck &&
      !confirmationToken &&
      tool.requiresConfirmation &&
      confirmationOwnerOf(tool) === "interceptor" &&
      !interceptor.denyTier.evaluate(tool, args)
    ) {
      const precheck = tool.precheck;
      const early = await Promise.resolve()
        .then(() => precheck(args, ctx))
        .catch(() => {
          console.warn("tool.precheck_threw", { tool: tool.name });
          return null;
        });
      if (early && early.ok === false && early.status === "error") {
        return toolResultToContent(early);
      }
    }
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
