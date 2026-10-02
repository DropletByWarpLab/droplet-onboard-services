/**
 * WARP-2897 (ADR-056 slice I-0, brief §5.4) — the two-layer tool model.
 *
 * The box's tool universe has two halves, and until this file every access
 * decision read only the first:
 *
 *   • the CATALOG layer — `TOOL_CATALOG` from `@droplet/tools-core`, compiled
 *     into the image, CI-gated for completeness, with an authored
 *     `requiresWrite` on every entry;
 *   • the RUNTIME layer — tools a remote MCP server (and, once slice H lands,
 *     an installed extension) registered at runtime into
 *     `runtime-tool-registry.service.ts`, whose privilege is NOT authored by
 *     us but recorded by the operator in `RemoteToolClassification`.
 *
 * Reachability (`access-catalog.ts` `tierReachableDomains`), the effective
 * tool-domain universe (`effective-access.service.ts`), grantability
 * (`isGrantableDomain`), scope checks (`tool-access.service.ts`) and the
 * roles surface's dead-grant marking all derive from the SAME two layers
 * through the functions below. One derivation, so the question "does domain D
 * hold a tool a family member may call?" has one answer everywhere.
 *
 * ## The runtime layer reads the record, never the wire
 *
 * A runtime tool's `requiresWrite` is its classification row's value, and a
 * tool with NO row is a write (`IMPORT_DEFAULT_CLASSIFICATION`). A `denied`
 * row removes the tool from the layer entirely. The descriptor's own hints —
 * an MCP `readOnlyHint`, the tool's name, its description — are never read: a
 * server that calls a tool `search_issues` would otherwise choose its own
 * privilege level, which is the thing WARP-2426's record exists to refuse.
 *
 * ## What this slice deliberately does NOT read
 *
 * Persisted extension state. Slice H (WARP-2900) adds the `Extension` row with
 * an install/disable/uninstall lifecycle; once it exists, `loadToolLayers`
 * should also read installed extensions' manifest tools so a grant does not
 * read "dead" for the seconds between an orchestrator restart and the
 * extension's re-attach. Until then the runtime layer is the in-memory
 * registry, which is what remote MCP servers populate today.
 *
 * ## Domains
 *
 * `LayeredTool.domain` is a plain string. The runtime registry's descriptor
 * still types its domain as the closed `ToolDomain` union, because the
 * extension-domain vocabulary (`ext:<id>` vs an operator-chosen compiled
 * domain) is slice H's decision; nothing here assumes either answer, and
 * every set below simply unions whatever domains the layers carry.
 */
import { TOOL_CATALOG, TOOL_DOMAINS } from "@droplet/tools-core";
import {
  runtimeToolRegistry,
  type RuntimeToolDescriptor,
  type RuntimeToolRegistry,
} from "./runtime-tool-registry.service.js";
import {
  IMPORT_DEFAULT_CLASSIFICATION,
  listRemoteToolClassifications,
  remoteToolClassificationCache,
  type ClassificationLookup,
  type ClassificationPrisma,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import { parseNamespacedToolName } from "./mcp-multiplexer.service.js";

/** Which layer a tool came from. `runtime:<serverId>` names the server so a
 *  readback can say where a domain's tools live. */
export type ToolLayerSource = "catalog" | `runtime:${string}`;

export interface LayeredTool {
  name: string;
  domain: string;
  requiresWrite: boolean;
  source: ToolLayerSource;
}

export interface ToolLayers {
  catalog: readonly LayeredTool[];
  runtime: readonly LayeredTool[];
}

const CATALOG_LAYER: readonly LayeredTool[] = Object.freeze(
  TOOL_CATALOG.map((entry) =>
    Object.freeze({
      name: entry.name,
      domain: entry.domain as string,
      requiresWrite: entry.requiresWrite,
      source: "catalog" as const,
    }),
  ),
);

/** The compiled catalog as a layer. Frozen and shared — it never changes at
 *  runtime. */
export function catalogLayer(): readonly LayeredTool[] {
  return CATALOG_LAYER;
}

/** The part of a runtime descriptor the layer reads. Deliberately narrow: the
 *  description, schema and any wire annotations are not in it. `domainSource`
 *  is in it because the domain now AUTHORIZES the tool (see runtimeLayer). */
export type RuntimeDescriptorFacts = Pick<
  RuntimeToolDescriptor,
  "name" | "serverId" | "domain" | "domainSource"
>;

/**
 * The runtime layer: each registered descriptor, classified by its record row
 * (keyed on `serverId` + the WIRE name, which is how the record is written).
 * Denied tools are dropped; a missing row means write.
 *
 * Only an OPERATOR-mapped domain puts a tool in the layer. A runtime tool's
 * domain decides which role grants admit it, and `resolveRuntimeToolDomain`
 * can also produce that domain from the server's own registration (a hint
 * from outside the trust boundary) or from the `data` default (which is
 * feature-ungated). Either would let a vendor choose which roles' grants
 * admit its tools, so a `"server"` or `"default"` source is left out of the
 * layer, and of the lookup built from it: unreachable for every scoped
 * principal, never a reason a domain counts as populated or grantable.
 * Owners, service principals and role-less people carry no scope, so neither
 * the layer nor the lookup narrows them. They keep every registered tool,
 * whatever its source, exactly as before.
 */
export function runtimeLayer(
  descriptors: readonly RuntimeDescriptorFacts[],
  lookup: ClassificationLookup,
): LayeredTool[] {
  const out: LayeredTool[] = [];
  for (const d of descriptors) {
    if (d.domainSource !== "operator") continue;
    const wireName = parseNamespacedToolName(d.name)?.wireName ?? d.name;
    const row = lookup(d.serverId, wireName);
    if (row?.denied) continue;
    out.push({
      name: d.name,
      domain: d.domain as string,
      requiresWrite: row ? row.requiresWrite : IMPORT_DEFAULT_CLASSIFICATION.requiresWrite,
      source: `runtime:${d.serverId}`,
    });
  }
  return out;
}

/** Both layers. `runtime` defaults to empty — the compiled-only world. */
export function toolLayers(runtime: readonly LayeredTool[] = []): ToolLayers {
  return { catalog: CATALOG_LAYER, runtime };
}

function* allTools(layers: ToolLayers): Iterable<LayeredTool> {
  yield* layers.catalog;
  yield* layers.runtime;
}

/** Domains holding at least one tool in either layer. */
export function populatedDomains(layers: ToolLayers): Set<string> {
  const out = new Set<string>();
  for (const t of allTools(layers)) out.add(t.domain);
  return out;
}

/** Domains holding at least one NON-write tool in either layer — what the
 *  family/guest write filter leaves reachable. */
export function readableDomains(layers: ToolLayers): Set<string> {
  const out = new Set<string>();
  for (const t of allTools(layers)) if (!t.requiresWrite) out.add(t.domain);
  return out;
}

const COMPILED_DOMAINS: ReadonlySet<string> = new Set<string>(TOOL_DOMAINS);

/** Runtime-layer domains the compiled vocabulary does not declare, sorted.
 *  Empty on every box today (the registry types its domain as ToolDomain);
 *  this is where extension domains appear once slice H decides them. */
export function runtimeOnlyDomains(layers: ToolLayers): Set<string> {
  const out = new Set<string>();
  for (const t of layers.runtime) if (!COMPILED_DOMAINS.has(t.domain)) out.add(t.domain);
  return new Set([...out].sort());
}

/** TOOL_DOMAINS (in declaration order) followed by the runtime-only domains.
 *  The universe effective-access filters and the owner bypass returns. */
export function toolDomainUniverse(layers: ToolLayers): string[] {
  return [...TOOL_DOMAINS, ...runtimeOnlyDomains(layers)];
}

/**
 * Load both layers. The classification table is read only when the runtime
 * registry holds a tool — a box with no remote server attached (every shipped
 * box today) pays nothing for this, and a caller whose Prisma handle has no
 * classification delegate (a test fake) keeps working.
 *
 * `prisma` may be a transaction handle, so the rows come from the caller's
 * snapshot (effective-access reads everything in one REPEATABLE READ tx).
 */
export async function loadToolLayers(
  prisma: ClassificationPrisma,
  registry: RuntimeToolRegistry = runtimeToolRegistry,
): Promise<ToolLayers> {
  const descriptors = registry.list();
  if (descriptors.length === 0) return toolLayers();
  const rows: RemoteToolClassificationRow[] = await listRemoteToolClassifications(prisma);
  const byKey = new Map(rows.map((r) => [`${r.serverId} ${r.toolName}`, r]));
  return toolLayers(
    runtimeLayer(descriptors, (serverId, toolName) => byKey.get(`${serverId} ${toolName}`)),
  );
}

// ── the synchronous lookup both LLM dispatch sites share ──────────

/** What a scope check needs to know about a runtime tool. */
export interface RuntimeToolFacts {
  domain: string;
  requiresWrite: boolean;
}

/** name → facts for a registered, non-denied runtime tool; `undefined` for
 *  anything else (compiled tools, unknown names, denied tools). */
export type RuntimeToolLookup = (name: string) => RuntimeToolFacts | undefined;

/** The lookup that knows no runtime tool — every scope check's default, so a
 *  call site that does not pass one keeps today's deny-every-runtime-tool
 *  behaviour. */
export const NO_RUNTIME_TOOLS: RuntimeToolLookup = () => undefined;

/** Build a lookup over one registry snapshot and one classification lookup. */
export function runtimeToolLookupFrom(
  registry: Pick<RuntimeToolRegistry, "list">,
  classification: ClassificationLookup,
): RuntimeToolLookup {
  const facts = new Map<string, RuntimeToolFacts>();
  for (const t of runtimeLayer(registry.list(), classification)) {
    facts.set(t.name, { domain: t.domain, requiresWrite: t.requiresWrite });
  }
  if (facts.size === 0) return NO_RUNTIME_TOOLS;
  return (name) => facts.get(name);
}

/**
 * THE runtime lookup for the chat catalog build (routes/llm.ts
 * `narrowAllowedToolsForRole`) and the agent loop (llm-agent.service.ts).
 * One helper, so the two sites cannot disagree about which runtime tools a
 * scoped person reaches — the WARP-2556 drift class. Reads the process
 * registry and the classification cache the multiplexer's policy already
 * reads (a stale cache errs toward write).
 *
 * Effective-access (`loadToolLayers`) reads the classification ROWS inside
 * its REPEATABLE READ tx, while this lookup reads
 * `remoteToolClassificationCache`; the owner's classification route writes
 * the row and refreshes the cache in the same request, so the two drift only
 * briefly.
 */
export function currentRuntimeToolLookup(): RuntimeToolLookup {
  return runtimeToolLookupFrom(runtimeToolRegistry, remoteToolClassificationCache.lookup);
}
