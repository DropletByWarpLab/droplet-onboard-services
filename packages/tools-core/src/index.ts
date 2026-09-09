// WARP-1611: `ScoreKind` is exported so producers and consumers of a
// retrieval score can share one declaration of the scale union instead
// of each restating it.
// WARP-2472: `ConfirmationOwner` is exported so the orchestrator's drift
// gate can name the enum rather than restate its two members.
export type { Tool, ToolContext, ToolHandler, ToolResult, ToolError, Role, ScoreKind, HttpClient, MatterController, ConfirmationOwner } from "./types.js";
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
// WARP-2821 — the ONE corpus-visibility rule, called by the orchestrator's
// Files search route and by the mcp-server's chunk-owner resolver. Two copies
// of this disagreed once, and every shared document was invisible to the
// assistant while the Files page listed it.
export {
  HOUSEHOLD_INDEX_USER,
  deptSentinel,
  visibleDepartmentsFor,
  deptCorpusKeys,
  maxAclVersion,
} from "./corpus-scope.js";
export type { VisibleDept, CorpusCaller } from "./corpus-scope.js";
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
  // WARP-2472 — the single place the `"interceptor"` default is applied.
  confirmationOwnerOf,
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
