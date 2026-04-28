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

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Only populated on assistant messages that request tool execution.
  tool_calls?: ToolCall[];
  // Set on tool-role messages to correlate the result with the request.
  tool_call_id?: string;
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

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  context_window: number | null;
}

export interface ModelsResponse {
  models: ModelInfo[];
}

// --- Session types ---

export interface SessionInfo {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  system_prompt: string | null;
}

export interface SessionDetail extends SessionInfo {
  messages: SessionMessage[];
}

export interface SessionMessage {
  role: string;
  content: string;
  timestamp: number;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
}

export interface SessionChatRequest {
  message: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  provider?: string;
}

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
