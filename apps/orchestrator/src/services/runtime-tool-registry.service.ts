/**
 * WARP-2443 / WARP-2444 — the dynamic half of the tool universe.
 *
 * Until now every tool the agent could reach was known at compile time:
 * `registry.ts` holds a frozen literal array, `catalog.ts` derives
 * `TOOL_CATALOG` from it, and `tool-selection.service.ts` keys per-turn
 * selection off that catalog's domains. That was correct while the universe
 * was static. It stops being correct the moment a remote MCP server registers
 * tools at runtime (WARP-2300), because such a tool has NO catalog entry —
 * and the two places that read the catalog both fail closed on its absence:
 *
 *   • `tool-selection.service.ts` — a name with no domain is never selected.
 *     It does not error. The tool simply never runs, which from the outside
 *     is indistinguishable from a model that chose not to use it.
 *   • `tool-access.service.ts` `toolAllowedInScope` — no entry ⇒ denied.
 *
 * This module is the seam that gives a runtime-registered tool the ONE thing
 * selection needs from it: a domain. It deliberately does not touch
 * `TOOL_CATALOG`, which is registry-derived and CI-gated for completeness
 * (`catalog.test.ts`) — a remote tool must never be written into it, or the
 * completeness invariant would start lying about what is installed on the box.
 *
 * SCOPE BOUNDARY: this file owns the descriptor shape, the domain assignment
 * and the in-memory registry. It does NOT own the transport — no MCP client,
 * no multiplexer, no OAuth. WARP-2300 owns those and will call
 * `registerServerTools` / `unregisterServer` from them. Everything here is
 * exercised today by fixture catalogs (`__fixtures__/remote-tool-catalog.ts`),
 * which is what lets the selection behaviour be proven before the transport
 * exists.
 */
import type { ToolDomain } from "@droplet/tools-core";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("runtime-tool-registry");

/**
 * Where a runtime tool's domain came from. Recorded per tool rather than
 * inferred, because the three cases have very different confidence and an
 * operator debugging "why did the agent ignore my Jira connection" needs to
 * see which one applied (WARP-2444: "the domain source is explicit … and
 * recorded, not implicit").
 */
export type RuntimeToolDomainSource =
  /** An operator explicitly mapped this server (or tool) to a domain. Wins. */
  | "operator"
  /** The server's own registration declared the domain. The normal case. */
  | "server"
  /** Neither was supplied — {@link DEFAULT_RUNTIME_TOOL_DOMAIN} applied. */
  | "default";

/**
 * A tool that exists only at runtime. Mirrors the fields selection and
 * serialisation need from a `Tool`, plus the domain stamp that a registry
 * tool gets from `TOOL_CATALOG` and a remote one cannot.
 */
export interface RuntimeToolDescriptor {
  /** Wire name the model calls. Namespaced by the server in practice. */
  name: string;
  /** Which registered server advertised it — the unregistration key. */
  serverId: string;
  /** Selection domain. Always present by construction; that is the point. */
  domain: ToolDomain;
  /** Which of the three assignment routes produced {@link domain}. */
  domainSource: RuntimeToolDomainSource;
  /** Agent-facing description, serialised into `tools[]`. */
  description: string;
  /** JSON Schema for the tool's arguments, serialised into `tools[]`. */
  inputSchema: Record<string, unknown>;
}

/**
 * The fallback domain for a runtime tool whose server declared none and whom
 * no operator mapped.
 *
 * `data` is the taxonomy's generic-utility bucket, so a defaulted tool lands
 * somewhere coherent rather than being wedged into a household surface it has
 * nothing to do with. It is nonetheless a DEGRADED outcome: the `data` keyword
 * rule matches time/date/convert/calculate vocabulary, so a defaulted Jira
 * tool is reachable in principle but will rarely be advertised for the turns
 * that actually want it. That is why every default is logged and the source is
 * recorded — a box full of `domainSource: "default"` tools is a registration
 * bug, not a working configuration.
 *
 * The alternative — leaving the domain undefined — is what this whole story
 * exists to eliminate, because it is silent. A poor domain is diagnosable; no
 * domain is not.
 */
export const DEFAULT_RUNTIME_TOOL_DOMAIN: ToolDomain = "data";

/**
 * Decide a runtime tool's domain and record which route decided it.
 *
 * Precedence is operator > server > default, deliberately: the operator is
 * the only party who can see how their own box is organised, and a server's
 * self-declared domain is a hint from outside the trust boundary. A server
 * cannot override an operator's mapping.
 */
export function resolveRuntimeToolDomain(input: {
  toolName: string;
  serverId: string;
  /** Operator-configured mapping for this server or tool, if any. */
  operatorDomain?: ToolDomain;
  /** Domain the server declared for itself at registration, if any. */
  serverDomain?: ToolDomain;
}): { domain: ToolDomain; source: RuntimeToolDomainSource } {
  if (input.operatorDomain) {
    return { domain: input.operatorDomain, source: "operator" };
  }
  if (input.serverDomain) {
    return { domain: input.serverDomain, source: "server" };
  }
  logger.warn(
    {
      tool: input.toolName,
      serverId: input.serverId,
      domain: DEFAULT_RUNTIME_TOOL_DOMAIN,
    },
    "runtime_tool_domain_defaulted",
  );
  return { domain: DEFAULT_RUNTIME_TOOL_DOMAIN, source: "default" };
}

/**
 * In-memory, per-process registry of runtime tools, keyed by server.
 *
 * A class rather than loose module state so tests get an isolated instance
 * and never have to unpick a shared singleton — the process-wide one is
 * exported separately below for the agent loop to read.
 */
export class RuntimeToolRegistry {
  readonly #byServer = new Map<string, RuntimeToolDescriptor[]>();

  /**
   * Replace the tool set advertised by one server. Replace rather than merge:
   * a server's `tools/list` response is the whole truth about that server, so
   * a tool that has disappeared from it must disappear here too. Merging would
   * leave a removed tool advertised forever.
   */
  registerServerTools(
    serverId: string,
    tools: readonly RuntimeToolDescriptor[],
  ): void {
    const owned = tools.map((t) => ({ ...t, serverId }));
    this.#byServer.set(serverId, owned);
    const defaulted = owned.filter((t) => t.domainSource === "default").length;
    logger.info(
      { serverId, count: owned.length, defaultedDomains: defaulted },
      "runtime_tools_registered",
    );
  }

  /** Drop every tool from one server — the disconnect path. */
  unregisterServer(serverId: string): void {
    if (this.#byServer.delete(serverId)) {
      logger.info({ serverId }, "runtime_tools_unregistered");
    }
  }

  /**
   * Every runtime tool currently registered, in stable server-then-declaration
   * order so selection over this universe is deterministic (WARP-2443: "the
   * same input yields the same subset").
   */
  list(): RuntimeToolDescriptor[] {
    return [...this.#byServer.keys()]
      .sort()
      .flatMap((id) => this.#byServer.get(id) ?? []);
  }

  /** Server ids with at least one registered tool, sorted. */
  serverIds(): string[] {
    return [...this.#byServer.keys()].sort();
  }

  /** Test/reset hook — drops every server. */
  clear(): void {
    this.#byServer.clear();
  }
}

/**
 * The process-wide registry the agent loop reads. WARP-2300's client writes
 * into this; until then it is empty in production, which is exactly why the
 * local-only selection path must stay byte-identical when it is.
 */
export const runtimeToolRegistry = new RuntimeToolRegistry();
