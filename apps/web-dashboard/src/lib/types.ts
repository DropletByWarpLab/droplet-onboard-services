export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  provider?: string;
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
  messages: SessionMessageInfo[];
}

export interface SessionMessageInfo {
  role: string;
  content: string;
  timestamp: number;
}

export interface SessionChatRequest {
  message: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  provider?: string;
}

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

// --- Auth types ---

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
}

export interface ShareInfo {
  id?: number;
  url: string;
  token: string;
  shareType?: number;
  permissions?: number;
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
