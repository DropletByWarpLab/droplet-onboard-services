export type { Tool, ToolContext, ToolHandler, ToolResult, ToolError, Role, HttpClient, MatterController } from "./types.js";
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
