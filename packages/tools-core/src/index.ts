// WARP-1611: `ScoreKind` is exported so producers and consumers of a
// retrieval score can share one declaration of the scale union instead
// of each restating it.
export type { Tool, ToolContext, ToolHandler, ToolResult, ToolError, Role, ScoreKind, HttpClient, MatterController } from "./types.js";
export type { PrivateEnhancement } from "./private-enhancement.js";
export { TOOLS, getTool } from "./registry.js";
export {
  TOOL_CATALOG,
  TOOL_DOMAINS,
  type ToolCatalogEntry,
  type ToolDomain,
} from "./catalog.js";
export { confirmationRequired, isConfirmationResponse, passThroughConfirmation } from "./confirmation.js";
export {
  TOOL_ROUTES,
  type ToolClient,
  type ToolRouteHop,
  type ToolRouteEntry,
} from "./tool-routes.js";
