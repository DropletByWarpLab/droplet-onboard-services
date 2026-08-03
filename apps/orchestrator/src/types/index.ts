// --- AI Gateway types ---

// OpenAI-compatible tool call shape — LiteLLM forwards this unchanged
// between the ai-gateway, Ollama, and any remote provider, so we model
// it exactly as the upstream spec.
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

// Multimodal content blocks (image vision). A message's content is either a
// plain string (the common case, unchanged) or an OpenAI-style list of typed
// blocks. The orchestrator builds the block form only for image-bearing user
// turns just before dispatch; everything else stays a string.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Flatten a message's content to plain text. Assistant/tool responses are
 * always strings; this is for the handful of internal consumers that read a
 * message's text and must tolerate the multimodal union (image blocks
 * contribute their text parts only, joined by newlines).
 */
export function contentToText(
  content: string | ContentBlock[] | null | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  // Only populated on assistant messages that request tool execution.
  tool_calls?: ToolCall[];
  // Set on tool-role messages to correlate the result with the request.
  tool_call_id?: string;
  /**
   * WARP-458 — concatenated deep-reasoning trace (`<reasoning>` segments
   * joined by blank line; or the provider-native reasoning field, when
   * surfaced separately). Only set on assistant messages where the model
   * produced a reasoning trace; nullable everywhere else. The route layer
   * persists this verbatim to `ChatMessage.reasoning` (regardless of the
   * per-request `captureReasoning` flag — that flag gates EMISSION on the
   * wire, not PERSISTENCE, so the dashboard can lazy-load reasoning on
   * demand).
   */
  reasoning?: string;
  /**
   * WARP-458 — provider-native reasoning field, used by ai-gateway when
   * the upstream provider surfaces reasoning separately (LiteLLM's
   * `reasoning_content` for OpenAI o-series, Anthropic extended-thinking
   * when exposed). The agent loop reads this off the response and folds
   * it into the parsed trace alongside any inline `<reasoning>` segments
   * in `content`. Not part of the request side — only the response.
   */
  reasoning_content?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  provider?: string;
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  // WARP-1442 — optional gpt-oss reasoning-effort control, forwarded to the
  // ai-gateway which sets a top-level `reasoning_effort` on the Ollama
  // /v1/chat/completions request for the gpt-oss family (a no-op for other
  // models). Unset → current behavior byte-for-byte. The orchestrator route
  // defaults it to "low" for the `_service:voice` principal, server-side, so
  // voice-io sends nothing new.
  reasoning_effort?: "low" | "medium" | "high";
  // The ai-gateway is a pure provider router as of WARP-104 — it never
  // dispatches tools itself. The orchestrator owns the agent loop
  // end-to-end (MCP-backed); see services/ai-gateway/router.py and
  // spec §8 (orchestrator agent rewire) / §9 (ai-gateway slimming).
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatResponse {
  id: string;
  object: string;
  model: string;
  choices: ChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * WARP-1442 — one OpenAI-compatible streaming chunk from the ai-gateway's
 * `/ai/chat` SSE (`stream:true`). The gateway passes Ollama's
 * `/v1/chat/completions` stream through verbatim, so each chunk carries a
 * `choices[0].delta` with an INCREMENTAL slice of the turn:
 *
 *   - `delta.content`          — a fragment of the user-visible answer.
 *   - `delta.reasoning_content`— a fragment of the gpt-oss reasoning channel
 *                                (harmony "analysis"); never user-visible.
 *   - `delta.tool_calls[]`     — tool-call fragments keyed by `index`; the
 *                                function `arguments` arrive as partial JSON
 *                                strings that the CONSUMER concatenates per
 *                                index into one valid call.
 *   - `finish_reason`          — set on the terminal chunk of the turn
 *                                (`stop` | `length` | `tool_calls`).
 *
 * This is the RESPONSE side only; the request shape stays `ChatRequest`.
 */
export interface ChatStreamChunk {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

export interface ModelCapabilities {
  vision?: boolean;
  tools?: boolean;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  context_window: number | null;
  // Additive (optional for back-compat): modalities the model supports.
  // Populated by the ai-gateway; drives vision routing + the dashboard badge.
  capabilities?: ModelCapabilities;
}

export interface ModelsResponse {
  models: ModelInfo[];
  // Additive (optional for back-compat) — WARP-1284.
  //
  // `degraded_providers`: set by the ai-gateway — names providers whose
  // list_models() raised during the listing fan-out (empty when all
  // answered). Without it an unreachable Ollama was indistinguishable
  // from "no model pulled yet".
  //
  // `degraded`: stamped by the orchestrator's GET /llm/models on the
  // forwarded response when the models list can't be trusted as complete
  // (gateway unreachable, or the gateway reported its ollama provider
  // degraded). Drives the setup wizard's honest "can't reach your AI
  // service" state instead of the WARP-849 "still downloading" copy.
  degraded_providers?: string[];
  degraded?: boolean;
  // WARP-1112 (additive, optional for back-compat): the installed local
  // model the box answers with by default (`ai.model.chat` setting), or null
  // when unset / no longer installed. Stamped by the orchestrator's
  // GET /llm/models so the dashboard chat can default its picker to the
  // active model instead of just "the first one in the list".
  defaultModel?: string | null;
}

// WARP-311: legacy SessionInfo / SessionDetail / SessionListResponse /
// SessionChatRequest types were removed alongside the
// `/api/llm/sessions/*` proxy routes. Persistent conversation state
// now lives in the orchestrator's own Postgres (see
// `services/chat-persistence.service.ts`).

// --- Device types ---

export interface DeviceInfo {
  id: string;
  deviceId: string;
  hostname: string;
  hardwareRev: string;
  networkMode: string;
  ip: string | null;
  lastSeen: string;
}

// --- File types ---

export interface FileEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mimeType: string | null;
  modifiedAt: string;
  /**
   * WARP-1683 — Nextcloud numeric fileId (oc:fileid). The listing PROPFIND
   * has always requested it; it is now surfaced so pickers (team-chat file
   * forwarding) can address a file by the same stable id the registry gate
   * (`resolveFileDepartment`) keys on. Optional: absent when the PROPFIND
   * response omits the prop.
   */
  ncFileId?: number;
}

export interface TrashItemInfo {
  /** Nextcloud trashbin filename, e.g. "photo.jpg.d1712860391" (unique key for restore/delete) */
  name: string;
  /** Original name before deletion, e.g. "photo.jpg" */
  originalName: string;
  /** Original parent path, e.g. "/Photos" */
  originalLocation: string;
  size: number;
  /** ISO timestamp of when the item was trashed */
  deletedAt: string;
  isDirectory: boolean;
}

export interface FileVersionInfo {
  /** Opaque identifier used for restore (trailing segment of Nextcloud versions URL) */
  versionId: string;
  size: number;
  modifiedAt: string;
}

export interface BulkOperationResult {
  path: string;
  ok: boolean;
  error?: string;
}

// --- Storage types ---

export interface StorageStats {
  used: number;       // bytes
  total: number;      // bytes
  available: number;  // bytes
  percentage: number; // 0-100
}

// --- Health types ---

export interface HealthResponse {
  status: "ok" | "degraded";
  uptime: number;
  version: string;
  services: {
    db: boolean;
    redis: boolean;
    aiGateway: boolean;
    matter: boolean;
    router: boolean;
    frigate: boolean;
    switch: boolean;
    // Status display screen (services/oled-display). `true` when the
    // service is up — note this stays `true` even in "simulated" mode
    // (no physical USB device); query /display/status for the backend.
    display: boolean;
  };
}

// --- Smart Home / Matter (re-export) ---
// Matter is the smart-home integration. The category enum stays shared
// because the dashboard UI uses it verbatim.
export type { SmartHomeCategory } from "./smart-home.js";

// --- Camera / Frigate (re-export) ---
export type {
  CameraInfo,
  DetectionEvent,
  DiscoveredCamera,
  FrigateStats,
  CameraNotificationPrefs,
  CameraSSEEvent,
} from "./camera.js";

// --- Managed Switch (re-export) ---
export type {
  SwitchPortStatus,
  SwitchPoEPortStatus,
  SwitchVlanInfo,
  SwitchSystemInfo,
  WanDetectionResult,
  CameraSetupResult,
} from "./switch.js";
