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
