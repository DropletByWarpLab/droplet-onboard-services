/**
 * WARP-2972 — module gating for the LLM tool surface: the one predicate.
 *
 * A module toggle (Settings → Features) and a person's per-module grant decide
 * which tool DOMAINS exist for them. That mapping lives in the orchestrator's
 * module registry; the orchestrator turns it, per box and per person, into a
 * {@link ModuleVerdict} — the set of tool domains WITHHELD. Every consumer of
 * the tool list then asks the same question of it:
 *
 *   - the orchestrator's chat pool (llm-agent.service.ts) and
 *     `GET /api/llm/tools`, on top of the MCP client's process-lifetime
 *     `tools/list` cache;
 *   - the mcp-server's `tools/list` and `tools/call`, for both transports.
 *
 * Those two processes share nothing but this package, so the predicate lives
 * here. There is deliberately no second implementation of "is this tool
 * withheld by a module".
 *
 * ABSENT, NOT EMPTY, NOT ERRORING. A withheld tool is dropped from the list. A
 * list with nothing to drop is returned untouched, and a domain no module
 * claims (system, data, routines, …) is never withheld.
 *
 * FAIL CLOSED. When a consumer cannot obtain a verdict it uses
 * {@link FAIL_CLOSED_MODULE_VERDICT}: every module-owned domain withheld,
 * every unclaimed domain still available. That needs to know which domains
 * modules own with no orchestrator to ask — {@link MODULE_OWNED_TOOL_DOMAINS},
 * a copy of the registry's claims that the orchestrator pins to
 * `OWNERS_BY_DOMAIN` (tool-module-verdict.service.test.ts), so a module that
 * starts claiming a domain fails a test until this list agrees.
 */
import { TOOL_CATALOG } from "./catalog.js";

/**
 * The tool domains some module claims (`MODULES[].toolDomains` in the
 * orchestrator's module registry). Pinned equal to `OWNERS_BY_DOMAIN`'s keys.
 */
export const MODULE_OWNED_TOOL_DOMAINS: ReadonlySet<string> = new Set([
  "team_chat",
  "memory", // knowledge
  "files",
  "email",
  "calendar",
  "reminders",
  "notifications",
  "pm", // projects
  "business", // projects OR crm
  "crm",
  "money",
  "cameras",
  "smart-home",
  "network",
  "switch", // managed_switch
]);

/** The tool domains withheld for one box / one person. */
export interface ModuleVerdict {
  readonly withheldDomains: ReadonlySet<string>;
}

/** No verdict could be obtained: withhold everything a module owns. */
export const FAIL_CLOSED_MODULE_VERDICT: ModuleVerdict = Object.freeze({
  withheldDomains: MODULE_OWNED_TOOL_DOMAINS,
});

const DOMAIN_OF: ReadonlyMap<string, string> = new Map(
  TOOL_CATALOG.map((entry) => [entry.name, entry.domain] as const),
);
const ALL_TOOL_NAMES: readonly string[] = TOOL_CATALOG.map((entry) => entry.name);

/**
 * Is `name` withheld by `verdict`? A tool with no catalog entry (a remote
 * server's tool, WARP-2418) has no domain here and is never withheld: its own
 * gates (per-server allowlist, classification record) are a different
 * mechanism.
 */
export function isToolWithheldByModule(name: string, verdict: ModuleVerdict): boolean {
  const domain = DOMAIN_OF.get(name);
  return domain !== undefined && verdict.withheldDomains.has(domain);
}

/** Drop the withheld tools; order kept. The input is returned as-is when nothing is dropped. */
export function withholdModuleTools<T extends { name: string }>(
  tools: readonly T[],
  verdict: ModuleVerdict,
): T[] {
  if (verdict.withheldDomains.size === 0) return tools as T[];
  return tools.filter((t) => !isToolWithheldByModule(t.name, verdict));
}

/**
 * The tool set to compose tool GUIDANCE from. Guidance must never name a tool
 * the model was not given (a stripped tool named in the prompt sends a small
 * model into the hallucinated-tool guard), and `undefined` means "privileged:
 * every tool" — which stops being true once a module is off.
 *
 * `undefined` stays `undefined` when nothing is withheld, so a box with every
 * module on renders byte-for-byte what it did before.
 */
export function namesForGuidance(
  allowed: string[] | undefined,
  verdict: ModuleVerdict,
): string[] | undefined {
  if (verdict.withheldDomains.size === 0) return allowed;
  const names = allowed ?? ALL_TOOL_NAMES;
  return names.filter((n) => !isToolWithheldByModule(n, verdict));
}

/** The wire body of `GET /api/modules/tool-verdict`. Sorted, so it is stable. */
export function serializeModuleVerdict(verdict: ModuleVerdict): { withheldDomains: string[] } {
  return { withheldDomains: [...verdict.withheldDomains].sort() };
}

/** Parse the wire body. `null` for anything that is not exactly that shape. */
export function parseModuleVerdict(body: unknown): ModuleVerdict | null {
  if (typeof body !== "object" || body === null) return null;
  const domains = (body as { withheldDomains?: unknown }).withheldDomains;
  if (!Array.isArray(domains) || !domains.every((d) => typeof d === "string")) return null;
  return { withheldDomains: new Set(domains as string[]) };
}
