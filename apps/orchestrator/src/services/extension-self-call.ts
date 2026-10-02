/**
 * WARP-2900 (ADR-056 slice H3), review #2325 blocker 2 — which static tools
 * an extension may run AS ITS INSTALLING OWNER through
 * POST /api/extensions/self/call.
 *
 * AN ALLOWLIST, NOT A PREDICATE. "Neither requiresWrite nor
 * requiresConfirmation" admitted every read in TOOL_CATALOG, and a read can
 * still send the box's data out: get_weather and currency_convert query a web
 * service through the egress screen, cloud_query_dataset reads the owner's
 * Stripe / HubSpot / Xero records through a cloud connector. An extension's
 * bearer is readable by any same-uid child in the sandbox
 * (docs/security/extension-trust.md), so what this list admits, that child
 * can run as the owner.
 *
 * EMPTY IN V1: every static tool is refused. A tool joins only by an edit
 * here, which extension-self-call.test.ts pins: it must be in TOOL_CATALOG,
 * a read, and stay on the box. {@link selfCallReachesOffBox} is also checked
 * at every call, so no allowlist (the route's test seam included) can admit
 * a tool that leaves the box.
 */
import { TOOL_ROUTES, type ToolCatalogEntry } from "@droplet/tools-core";

/** The static tools an extension may call back into. Pinned by its test. */
export const EXTENSION_SELF_CALL_TOOLS: readonly string[] = Object.freeze([]);

/**
 * Tool domains whose reads reach a system outside the box: the connected
 * SaaS accounts (`cloud`) and the practice-management connector (`erp`).
 */
const OFF_BOX_DOMAINS: ReadonlySet<string> = new Set(["cloud", "erp"]);

/**
 * Orchestrator routes behind which a read leaves the box: the egress screen
 * (`/api/web/`), the connectors and cloud datasets (`/api/erp/`,
 * `/api/integrations/`), the model (`/api/llm/`: the provider may be a cloud
 * one) and mail accounts (`/api/email/`: a mail server is not the box).
 */
const OFF_BOX_ROUTE_PREFIXES: readonly string[] = [
  "/api/web/",
  "/api/erp/",
  "/api/integrations/",
  "/api/llm/",
  "/api/email/",
];

const ROUTES = new Map(TOOL_ROUTES.map((r) => [r.tool, r]));

/**
 * Why a call to `tool` reaches outside the box, or null when it stays on it.
 * A tool with no route entry is unknown reach and counts as leaving (fail
 * closed).
 */
export function selfCallReachesOffBox(tool: Pick<ToolCatalogEntry, "name" | "domain">): string | null {
  if (OFF_BOX_DOMAINS.has(tool.domain)) return `${tool.name} is in the ${tool.domain} domain (a connector)`;
  const route = ROUTES.get(tool.name);
  if (!route) return `${tool.name} has no route entry, so where it reaches is unknown`;
  for (const hop of route.hops) {
    const prefix = OFF_BOX_ROUTE_PREFIXES.find((p) => hop.pathPattern.startsWith(p));
    if (prefix) return `${tool.name} calls ${hop.pathPattern}, behind ${prefix}`;
  }
  return null;
}

export type ExtensionSelfCallRefusalCode = "write_tool_refused" | "off_box_tool_refused" | "tool_not_allowlisted";

export interface ExtensionSelfCallRefusal {
  code: ExtensionSelfCallRefusalCode;
  /** The access-denied row's `refs.reason`. */
  auditReason: string;
  message: string;
}

/**
 * Null when an extension may run `tool` as its owner; otherwise why not. The
 * order is fixed: a write, then a read that leaves the box, then anything
 * the allowlist does not name.
 */
export function extensionSelfCallRefusal(
  tool: Pick<ToolCatalogEntry, "name" | "domain" | "requiresWrite" | "requiresConfirmation">,
  allowlist: readonly string[] = EXTENSION_SELF_CALL_TOOLS,
): ExtensionSelfCallRefusal | null {
  if (tool.requiresWrite || tool.requiresConfirmation) {
    return {
      code: "write_tool_refused",
      auditReason: "extension-write-tool",
      message: "an extension may call read-only tools only",
    };
  }
  if (selfCallReachesOffBox(tool) !== null) {
    return {
      code: "off_box_tool_refused",
      auditReason: "extension-off-box-tool",
      message: "an extension may not call a tool that reaches outside the box",
    };
  }
  if (!allowlist.includes(tool.name)) {
    return {
      code: "tool_not_allowlisted",
      auditReason: "extension-tool-not-allowlisted",
      message: "this tool is not one an extension may call",
    };
  }
  return null;
}
