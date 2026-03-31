// --- AI Gateway types ---

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  provider?: string;
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

export interface SyncTargetInfo {
  id: string;
  path: string;
  label: string;
  intervalMin: number;
  enabled: boolean;
  lastSync: string | null;
  fileCount: number;
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
  };
}
