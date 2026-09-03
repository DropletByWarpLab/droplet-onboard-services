/**
 * WARP-2395 — the tool multiplexer: one {@link McpClientPort} in front of the
 * local stdio child plus N remote MCP servers.
 *
 * ## What it is for
 *
 * The agent loop asks one object for "the tools" and dispatches to one object.
 * Before this, that object was the stdio child, and "the tools" was one
 * server's registry. ADR-043 adds servers we did not write, so something has
 * to answer both questions across a set — and it has to do so without the loop
 * learning that a set exists.
 *
 * ## The three rules that make it safe rather than merely convenient
 *
 * 1. **Remote names are namespaced per server** — `<serverId>__<wireName>`.
 *    Unambiguous by construction, not by hope: a server id may not contain
 *    `_` and a wire name may not contain `__`, so the first `__` is always
 *    the boundary. Namespacing is also what makes rule 2 a narrow check
 *    rather than a whole-registry comparison.
 * 2. **Collisions are rejected fail-closed, and recorded.** A remote tool
 *    whose namespaced name matches a LOCAL tool is dropped — never
 *    registered, never advertised, never dispatched. It cannot shadow the
 *    local one, and the local one is not dropped either (dropping the local
 *    tool would let a remote server disable a Droplet capability by naming
 *    it). Same for two remotes claiming one name. Every drop lands in
 *    {@link McpToolMultiplexer.rejections} — ADR-043 §1's fourth failure
 *    state says a tool that disappeared must not read as "there is nothing
 *    to do", so silence is not an option.
 * 3. **Every remote tool is DENIED at `callTool` by default.** ADR-043 §3 is
 *    binding: no remote tool may be invoked until WARP-2321's operator-owned
 *    classification table exists to say which ones are reads. Until it does,
 *    {@link DENY_ALL_REMOTE_TOOLS} is the policy and every remote dispatch
 *    returns `REMOTE_TOOL_NOT_CLASSIFIED`. WARP-2321 replaces the policy
 *    function; it does not have to find a hook, because this is the hook.
 *
 * ## What is deliberately NOT forwarded
 *
 * `McpCallContext` (`_meta`) carries the caller's Nextcloud session token,
 * their username and a confirmation token. Stdio is in-process trusted, which
 * is the entire reason those may ride along there. A remote server is not,
 * and forwarding `ncToken` to a third party would hand a customer's file-store
 * credential to a vendor — rule 19, and ADR-043 §7's "never written to a log
 * or an export" in its most literal form. The remote branch drops it.
 *
 * ## ADR-043 §5 boundary
 *
 * This file holds no socket and imports no transport. It composes ports. The
 * remote `McpClientPort` implementations are supplied by the caller and, per
 * §5, are backed by `services/mcp-bridge` out of process — never by a
 * `StreamableHTTPClientTransport` constructed here.
 */
import { createLogger } from "../lib/logger.js";
import type {
  McpClientPort,
  McpToolCallOutcome,
  McpToolDescriptor,
} from "./mcp-client.port.js";
import type { McpCallContext } from "./mcp-client.service.js";

const logger = createLogger("mcp-multiplexer");

/** Separator between a server id and a remote tool's wire name. */
export const REMOTE_TOOL_NAME_SEPARATOR = "__";

/** A server id may not contain the separator's character at all, so the first
 *  `__` in a namespaced name is always the boundary. */
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A wire tool name we are willing to namespace. Bounded to 64 characters
 * because the namespaced result is serialised into an OpenAI-style
 * `function.name`, and it may not contain the separator (see
 * {@link REMOTE_TOOL_NAME_SEPARATOR}).
 */
const WIRE_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Build the name the model sees for a remote tool. */
export function namespacedToolName(serverId: string, wireName: string): string {
  return `${serverId}${REMOTE_TOOL_NAME_SEPARATOR}${wireName}`;
}

/**
 * Split a namespaced name back into its parts, or `null` when the name is not
 * namespaced at all (every local tool name, and every hallucinated one).
 *
 * Splits on the FIRST separator: `atlassian__jira_get_issue` is
 * `atlassian` + `jira_get_issue`, and a wire name carrying its own `__` was
 * refused at registration, so this cannot mis-parse a registered tool.
 */
export function parseNamespacedToolName(
  name: string,
): { serverId: string; wireName: string } | null {
  const at = name.indexOf(REMOTE_TOOL_NAME_SEPARATOR);
  if (at <= 0) return null;
  const serverId = name.slice(0, at);
  const wireName = name.slice(at + REMOTE_TOOL_NAME_SEPARATOR.length);
  if (!serverId || !wireName) return null;
  return { serverId, wireName };
}

/** Why a remote tool (or a whole server) was refused. Machine-readable —
 *  callers and the dashboard switch on `code`, never on `message`. */
export type RemoteRejectionCode =
  /** The operator has not allowlisted this server id (WARP-2418). */
  | "SERVER_NOT_ALLOWLISTED"
  /** Two attachments claimed the same server id. */
  | "SERVER_ID_IN_USE"
  /** The server id is not a legal namespace. */
  | "INVALID_SERVER_ID"
  /** The wire name cannot be namespaced safely. */
  | "INVALID_WIRE_NAME"
  /** Its namespaced name is a LOCAL tool's name (WARP-2420). */
  | "SHADOWS_LOCAL_TOOL"
  /** Another remote already claimed the namespaced name. */
  | "DUPLICATE_REMOTE_TOOL"
  /** The server's `tools/list` failed — ADR-043 §1's fourth failure state. */
  | "REMOTE_CATALOG_UNAVAILABLE";

export interface RemoteRejection {
  code: RemoteRejectionCode;
  serverId: string;
  /** The tool the rejection is about; absent for whole-server rejections. */
  toolName?: string;
  message: string;
}

/** The dispatch-time verdict on one remote call. */
export type RemoteCallDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; message: string };

/**
 * WARP-2321's seat at the table. Called for every remote dispatch, before the
 * call leaves the box.
 */
export type RemoteCallPolicy = (input: {
  serverId: string;
  wireName: string;
  namespacedName: string;
  args: Record<string, unknown>;
}) => RemoteCallDecision;

/**
 * The shipping policy: **deny everything**.
 *
 * ADR-043 §3 forbids invoking a remote tool that is absent from the local
 * classification table, and forbids any remote write until WARP-2305's
 * interceptor (landed) AND WARP-2321's deny tier (not landed) both exist.
 * With no table, every remote tool is absent from it, so every remote tool is
 * refused. That is the correct reading of the ADR and not a placeholder: a
 * policy that allowed reads "for now" would be allowing tools nobody has
 * reviewed, which is exactly the ruling.
 */
export const DENY_ALL_REMOTE_TOOLS: RemoteCallPolicy = ({ namespacedName }) => ({
  kind: "deny",
  code: "REMOTE_TOOL_NOT_CLASSIFIED",
  message:
    `'${namespacedName}' is a remote MCP tool and no operator has classified it. ` +
    "Remote tools are denied until the classification table exists (ADR-043 §2/§3). " +
    "Do not retry; answer without it.",
});

export interface McpToolMultiplexerOptions {
  /**
   * WARP-2418 — the operator allowlist. Returns `true` only for a server the
   * operator has enabled. The DEFAULT DENIES EVERY SERVER, so a fresh box
   * advertises nothing remote no matter what is wired up around it.
   */
  isServerAllowed?: (serverId: string) => boolean;
  /** WARP-2321's hook. Defaults to {@link DENY_ALL_REMOTE_TOOLS}. */
  remoteCallPolicy?: RemoteCallPolicy;
}

interface AttachedRemote {
  client: McpClientPort;
  /** Vetted, namespaced descriptors from the last successful `listTools`.
   *  Keyed by WIRE name — the key `callTool` needs after parsing. */
  catalog: Map<string, McpToolDescriptor>;
  /** Explicit state, never inferred from `catalog.size === 0`: a server that
   *  genuinely advertises zero tools and a server whose catalog call failed
   *  are different conditions with different remedies (ADR-043 §1). */
  catalogLoaded: boolean;
}

function errorOutcome(code: string, tool: string, message: string): McpToolCallOutcome {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, tool, message }) }],
  };
}

/**
 * The local child plus N remotes, behind one {@link McpClientPort}.
 *
 * With no remote attached — the shipping state, because the allowlist is
 * empty — every method delegates straight to the local port and the observable
 * behaviour is byte-identical to talking to `McpClientService` directly. That
 * is deliberate: it makes any behaviour change on a box attributable to a
 * server the operator actually enabled, never to this indirection.
 */
export class McpToolMultiplexer implements McpClientPort {
  readonly #local: McpClientPort;
  /** Names from the last `listTools()`. Held so `callTool` can settle a
   *  local-vs-remote name collision in the LOCAL tool's favour without a
   *  round-trip. Empty until the first listing, which is the state in which
   *  no remote is attached either. */
  #localNames: ReadonlySet<string> = new Set();
  readonly #remotes = new Map<string, AttachedRemote>();
  readonly #rejections: RemoteRejection[] = [];
  readonly #isServerAllowed: (serverId: string) => boolean;
  readonly #remoteCallPolicy: RemoteCallPolicy;

  constructor(local: McpClientPort, opts: McpToolMultiplexerOptions = {}) {
    this.#local = local;
    this.#isServerAllowed = opts.isServerAllowed ?? (() => false);
    this.#remoteCallPolicy = opts.remoteCallPolicy ?? DENY_ALL_REMOTE_TOOLS;
  }

  get isStarted(): boolean {
    return this.#local.isStarted;
  }

  /** Server ids currently attached, sorted — deterministic listing order. */
  remoteServerIds(): string[] {
    return [...this.#remotes.keys()].sort();
  }

  /** Every refusal since construction, newest last. Read by the operator
   *  surface; never a silent drop. */
  rejections(): readonly RemoteRejection[] {
    return this.#rejections;
  }

  /**
   * The vetted namespaced catalog for one attached server — what the
   * registration seam writes into the runtime tool registry. Empty for a
   * server whose catalog has not loaded.
   */
  remoteCatalog(serverId: string): McpToolDescriptor[] {
    return [...(this.#remotes.get(serverId)?.catalog.values() ?? [])];
  }

  /**
   * Attach a remote server. Refused — and recorded — when the operator has
   * not allowlisted it, when the id is not a legal namespace, or when the id
   * is already in use. Returns the rejection, or `null` on success.
   */
  attachRemote(serverId: string, client: McpClientPort): RemoteRejection | null {
    if (!SERVER_ID_PATTERN.test(serverId)) {
      return this.#reject({
        code: "INVALID_SERVER_ID",
        serverId,
        message:
          `"${serverId}" is not a legal server id: lowercase letters, digits ` +
          "and hyphens only, 1-32 characters, and no underscore (the namespace " +
          "separator must stay unambiguous).",
      });
    }
    if (!this.#isServerAllowed(serverId)) {
      return this.#reject({
        code: "SERVER_NOT_ALLOWLISTED",
        serverId,
        message:
          `"${serverId}" is not in the operator's remote MCP allowlist. ` +
          "Nothing from it is advertised or callable.",
      });
    }
    if (this.#remotes.has(serverId)) {
      return this.#reject({
        code: "SERVER_ID_IN_USE",
        serverId,
        message: `"${serverId}" is already attached; detach it first.`,
      });
    }
    this.#remotes.set(serverId, { client, catalog: new Map(), catalogLoaded: false });
    logger.info({ serverId }, "remote_mcp_server_attached");
    return null;
  }

  /** Drop a remote server and everything it advertised. */
  detachRemote(serverId: string): boolean {
    const removed = this.#remotes.delete(serverId);
    if (removed) logger.info({ serverId }, "remote_mcp_server_detached");
    return removed;
  }

  /**
   * The union catalog: local tools first, then each attached server's vetted
   * tools in sorted server order.
   *
   * A remote whose `tools/list` throws does NOT fail the call — the local
   * registry is still the box's own capability and must keep working — but it
   * IS recorded as `REMOTE_CATALOG_UNAVAILABLE` and its previously-vetted
   * catalog is cleared, so a tool that has gone away stops being advertised.
   */
  async listTools(): Promise<McpToolDescriptor[]> {
    const local = await this.#local.listTools();
    const localNames = new Set(local.map((t) => t.name));
    this.#localNames = localNames;
    if (this.#remotes.size === 0) return local;

    const taken = new Set(localNames);
    const out: McpToolDescriptor[] = [...local];

    for (const serverId of this.remoteServerIds()) {
      const remote = this.#remotes.get(serverId)!;
      let advertised: McpToolDescriptor[];
      try {
        advertised = await remote.client.listTools();
      } catch (err) {
        remote.catalog.clear();
        remote.catalogLoaded = false;
        this.#reject({
          code: "REMOTE_CATALOG_UNAVAILABLE",
          serverId,
          message:
            `"${serverId}" did not answer tools/list: ` +
            (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
        continue;
      }

      remote.catalog.clear();
      remote.catalogLoaded = true;
      for (const tool of advertised) {
        const vetted = this.#vetRemoteTool(serverId, tool, localNames, taken);
        if (!vetted) continue;
        remote.catalog.set(tool.name, vetted);
        taken.add(vetted.name);
        out.push(vetted);
      }
    }
    return out;
  }

  /**
   * Dispatch.
   *
   * Routing order, and each step is load-bearing:
   *
   *   1. **A local tool name wins outright** (WARP-2420). A remote server
   *      that manages to produce a namespaced name matching a local tool
   *      cannot take the dispatch — the local handler runs, as it did before
   *      any of this existed.
   *   2. A `<attachedServerId>__<wire>` name goes to that server, subject to
   *      the catalog check and the policy below.
   *   3. Everything else — every unnamespaced name, every hallucinated one —
   *      goes to the local port exactly as before, so the loop's WARP-642
   *      unknown-tool guard keeps answering unknown names the way it always
   *      did.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    context?: McpCallContext,
  ): Promise<McpToolCallOutcome> {
    const parsed = this.#localNames.has(name) ? null : parseNamespacedToolName(name);
    const remote = parsed ? this.#remotes.get(parsed.serverId) : undefined;
    if (!parsed || !remote) {
      return this.#local.callTool(name, args, context);
    }

    // WARP-2420 — the catalog-less remote tool. A name that parses to an
    // attached server but is not in that server's VETTED catalog is refused
    // here and never reaches the wire. Without this the call would be
    // forwarded on the strength of its name alone, which is a name the model
    // produced.
    if (!remote.catalog.has(parsed.wireName)) {
      logger.warn(
        { serverId: parsed.serverId, tool: name, catalogLoaded: remote.catalogLoaded },
        "remote_tool_not_registered",
      );
      return errorOutcome(
        "REMOTE_TOOL_NOT_REGISTERED",
        name,
        remote.catalogLoaded
          ? `'${name}' is not in ${parsed.serverId}'s advertised tool list.`
          : `${parsed.serverId}'s tool list has not loaded; no tool from it can be called.`,
      );
    }

    const decision = this.#remoteCallPolicy({
      serverId: parsed.serverId,
      wireName: parsed.wireName,
      namespacedName: name,
      args,
    });
    if (decision.kind === "deny") {
      logger.warn(
        { serverId: parsed.serverId, tool: name, code: decision.code },
        "remote_tool_denied",
      );
      return errorOutcome(decision.code, name, decision.message);
    }

    // `context` is deliberately dropped: see the module header. The remote
    // server gets the arguments and nothing else.
    return remote.client.callTool(parsed.wireName, args);
  }

  #vetRemoteTool(
    serverId: string,
    tool: McpToolDescriptor,
    localNames: ReadonlySet<string>,
    taken: ReadonlySet<string>,
  ): McpToolDescriptor | null {
    if (
      !WIRE_TOOL_NAME_PATTERN.test(tool.name) ||
      tool.name.includes(REMOTE_TOOL_NAME_SEPARATOR)
    ) {
      this.#reject({
        code: "INVALID_WIRE_NAME",
        serverId,
        toolName: tool.name,
        message:
          `"${tool.name}" cannot be namespaced: 1-64 characters of ` +
          "[A-Za-z0-9_.-] starting alphanumeric, and no '__'.",
      });
      return null;
    }
    const name = namespacedToolName(serverId, tool.name);
    if (localNames.has(name)) {
      this.#reject({
        code: "SHADOWS_LOCAL_TOOL",
        serverId,
        toolName: tool.name,
        message:
          `"${name}" is the name of a tool this box implements. The remote ` +
          "one is dropped; the local one is untouched.",
      });
      return null;
    }
    if (taken.has(name)) {
      this.#reject({
        code: "DUPLICATE_REMOTE_TOOL",
        serverId,
        toolName: tool.name,
        message: `"${name}" was already claimed by an earlier server.`,
      });
      return null;
    }
    return {
      name,
      description: tool.description,
      // ADR-043 §2 — only these three fields cross. Any `annotations` the
      // server sent is discarded here, which is the one place it could
      // otherwise have leaked into a privilege decision.
      inputSchema: tool.inputSchema,
    };
  }

  #reject(rejection: RemoteRejection): RemoteRejection {
    this.#rejections.push(rejection);
    logger.warn(
      { code: rejection.code, serverId: rejection.serverId, tool: rejection.toolName },
      "remote_mcp_rejected",
    );
    return rejection;
  }
}
