/**
 * WARP-2900 (ADR-056 slice H4) — how a runtime tool is SHOWN: the one
 * read-model the `/tools` Extensions section (`GET /api/llm/tools/runtime`)
 * and the tool inspector (`tool-inspect.service.ts`) both render.
 *
 * ── What it carries, and what it refuses to ────────────────────────────────
 *
 * A runtime tool's descriptor holds the wire DESCRIPTION the server sent.
 * For a promoted extension that is its author's words, and for a vendor
 * server it is the vendor's. Neither is a statement this box has checked, so
 * this view never carries it: a surface built on {@link RuntimeToolView} can
 * only render the name, where the tool came from, the domain the operator
 * chose, and what dispatch will do with a call. A tool whose description says
 * "read-only, harmless" cannot say so on any page, because the field is not
 * here to render.
 *
 * ── The classification column is the shipped predicate, called ─────────────
 *
 * The same rule `tool-inspect.service.ts` lives by: nothing here decides
 * whether a call would run. {@link describeRuntimeTool} hands the tool to the
 * {@link RemoteCallPolicy} the multiplexer dispatches through (the
 * process-wide `remoteCallPolicy` in production) and reports what it
 * answered. A second copy of that rule on a page would be a second access
 * model, and the first time the two disagreed the page would be confidently
 * wrong about whether an extension can act.
 *
 * The policy is synchronous and reads by NAME only (neither the record nor
 * the Atlassian table looks at args), so calling it with empty args is the
 * whole answer, not an approximation of it.
 */
import type {
  RuntimeToolDescriptor,
  RuntimeToolDomainSource,
} from "./runtime-tool-registry.service.js";
import { parseNamespacedToolName, type RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import { EXTENSION_SERVER_PREFIX } from "./extension-token.js";

/** `extension:<slug>@<version>` — the shape `extensionProvenance` writes. */
export const EXTENSION_PROVENANCE_PREFIX = "extension:";

export interface RuntimeToolClassificationView {
  /** What dispatch does with a call to this tool right now. */
  decision: "allow" | "deny";
  /** The policy's machine code on a deny (REMOTE_WRITE_NOT_PERMITTED, …). Null on allow. */
  code: string | null;
}

export interface RuntimeToolView {
  /** The namespaced name the model calls: `<serverId>__<wireName>`. */
  name: string;
  /** What the server calls it. */
  wireName: string;
  serverId: string;
  /**
   * Where the tool came from, for a person: the provenance
   * (`extension:<slug>@<version>`) when the box knows it and it agrees with
   * the server id, else `remote:<serverId>`.
   */
  source: string;
  /** Set only for a promoted extension whose provenance matches its server id. */
  extension: { id: string; version: string } | null;
  domain: string;
  domainSource: RuntimeToolDomainSource;
  classification: RuntimeToolClassificationView;
}

/** Split `extension:<slug>@<version>`, or null for anything else. */
export function parseExtensionProvenance(
  provenance: string | undefined,
): { id: string; version: string } | null {
  if (!provenance?.startsWith(EXTENSION_PROVENANCE_PREFIX)) return null;
  const rest = provenance.slice(EXTENSION_PROVENANCE_PREFIX.length);
  const at = rest.indexOf("@");
  if (at <= 0 || at === rest.length - 1) return null;
  return { id: rest.slice(0, at), version: rest.slice(at + 1) };
}

/**
 * The extension a runtime tool belongs to — only when its provenance names
 * the SAME extension its server id does. Provenance is stamped by our own
 * attach path, so a mismatch is a bug, not an attack; but a surface that
 * trusted the stamp over the server id would then attribute one extension's
 * tool to another, and the server id is what dispatch routes on.
 */
export function extensionOfRuntimeTool(
  tool: Pick<RuntimeToolDescriptor, "serverId" | "provenance">,
): { id: string; version: string } | null {
  if (!tool.serverId.startsWith(EXTENSION_SERVER_PREFIX)) return null;
  const parsed = parseExtensionProvenance(tool.provenance);
  if (!parsed) return null;
  if (`${EXTENSION_SERVER_PREFIX}${parsed.id}` !== tool.serverId) return null;
  return parsed;
}

/** `extension:<slug>@<version>`, or `remote:<serverId>` when that is all the box knows. */
export function runtimeToolSource(
  tool: Pick<RuntimeToolDescriptor, "serverId" | "provenance">,
): string {
  const ext = extensionOfRuntimeTool(tool);
  return ext ? `${EXTENSION_PROVENANCE_PREFIX}${ext.id}@${ext.version}` : `remote:${tool.serverId}`;
}

/** The wire half of a registered runtime name. */
export function wireNameOf(tool: Pick<RuntimeToolDescriptor, "name" | "serverId">): string {
  const parsed = parseNamespacedToolName(tool.name);
  return parsed && parsed.serverId === tool.serverId ? parsed.wireName : tool.name;
}

/** Ask the shipped dispatch policy what it would do with a call to this tool. */
export function classifyRuntimeTool(
  tool: Pick<RuntimeToolDescriptor, "name" | "serverId">,
  policy: RemoteCallPolicy,
): RuntimeToolClassificationView {
  const decision = policy({
    serverId: tool.serverId,
    wireName: wireNameOf(tool),
    namespacedName: tool.name,
    args: {},
  });
  return decision.kind === "allow"
    ? { decision: "allow", code: null }
    : { decision: "deny", code: decision.code };
}

/**
 * One runtime tool as a surface may show it. Built field by field, never by
 * spreading the descriptor: a spread is how `description` would reach a page
 * the day somebody adds it to the descriptor's consumers.
 */
export function describeRuntimeTool(
  tool: RuntimeToolDescriptor,
  policy: RemoteCallPolicy,
): RuntimeToolView {
  return {
    name: tool.name,
    wireName: wireNameOf(tool),
    serverId: tool.serverId,
    source: runtimeToolSource(tool),
    extension: extensionOfRuntimeTool(tool),
    domain: tool.domain,
    domainSource: tool.domainSource,
    classification: classifyRuntimeTool(tool, policy),
  };
}
