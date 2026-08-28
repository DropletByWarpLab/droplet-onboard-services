// WARP-1611: `ScoreKind` is exported so producers and consumers of a
// retrieval score can share one declaration of the scale union instead
// of each restating it.
export type { Tool, ToolContext, ToolHandler, ToolResult, ToolError, Role, ScoreKind, HttpClient, MatterController } from "./types.js";
export type { PrivateEnhancement } from "./private-enhancement.js";
export { TOOLS, getTool } from "./registry.js";
// WARP-2497 — the cloud_query_dataset vocabulary. Re-exported so the
// orchestrator's route can be drift-tested against the tool's enum from a
// package boundary away; two hand-kept lists is exactly how the two sides
// would silently diverge.
export { CLOUD_QUERY_DATASETS } from "./handlers/cloud/query-dataset.js";
export {
  TOOL_CATALOG,
  TOOL_DOMAINS,
  type ToolCatalogEntry,
  type ToolDomain,
} from "./catalog.js";
export { confirmationRequired, isConfirmationResponse, passThroughConfirmation } from "./confirmation.js";
// WARP-2305 — generic enforcement of `requiresConfirmation` at dispatch,
// plus the runtime deny tier. `docs/tool-confirmation-contract.md`.
export {
  createConfirmationTokenStore,
  canonicalizeToolArgs,
  confirmationBindingHash,
  CONFIRMATION_CONTROL_KEYS,
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_MAX_PENDING_CONFIRMATIONS,
  type ConfirmationTokenStore,
  type ConfirmationRedeemFailure,
  type ConfirmationRedeemResult,
  type MintedConfirmation,
} from "./confirmation-token.js";
export {
  createToolCallInterceptor,
  createRuntimeDenyTier,
  defaultToolCallInterceptor,
  declaresConfirmedFlag,
  interceptOutcomeToToolResult,
  interceptorAuditEvent,
  type InterceptableTool,
  type InterceptMeta,
  type InterceptOutcome,
  type InterceptorAuditEvent,
  type DenyReason,
  type DenyRule,
  type RuntimeDenyTier,
  type ToolCallInterceptor,
} from "./interceptor.js";
export {
  TOOL_ROUTES,
  type ToolClient,
  type ToolRouteHop,
  type ToolRouteEntry,
} from "./tool-routes.js";
