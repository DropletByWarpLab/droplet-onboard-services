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

export interface TrashItemInfo {
  /** Nextcloud-assigned name used as restore key (e.g. "photo.jpg.d1712860391") */
  name: string;
  /** Original filename before deletion */
  originalName: string;
  /** Original parent directory (e.g. "/Photos") */
  originalLocation: string;
  size: number;
  /** ISO timestamp of when the item was trashed */
  deletedAt: string;
  isDirectory: boolean;
}

export interface FileVersionInfo {
  versionId: string;
  size: number;
  modifiedAt: string;
}

export interface BulkOperationResult {
  path: string;
  ok: boolean;
  error?: string;
}

/** View mode for the file manager — list or grid */
export type FileViewMode = "list" | "grid";

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
    homeAssistant: boolean;
    router: boolean;
    frigate: boolean;
  };
}

// --- Matter / Smart Home types ---

export type SmartHomeCategory =
  | "light"
  | "switch"
  | "sensor"
  | "binary_sensor"
  | "climate"
  | "media_player"
  | "cover"
  | "fan"
  | "lock"
  | "camera"
  | "vacuum";

export interface MatterDevice {
  nodeId: string;
  name: string;
  category: SmartHomeCategory;
  state: string;
  connectionState: "connected" | "disconnected" | "reconnecting" | "waiting";
  vendorName?: string;
  vendorId?: number;
  productName?: string;
  productId?: number;
  serialNumber?: string;
  endpoints: MatterEndpointInfo[];
  attributes: Record<string, unknown>;
}

export interface MatterEndpointInfo {
  endpointId: number;
  deviceTypes: Array<{ deviceType: number; revision: number }>;
  clusters: number[];
}

export interface MatterGrouped {
  lights: MatterDevice[];
  switches: MatterDevice[];
  sensors: MatterDevice[];
  climate: MatterDevice[];
  media: MatterDevice[];
  covers: MatterDevice[];
  locks: MatterDevice[];
  other: MatterDevice[];
}

export interface MatterDiscoveredDevice {
  deviceIdentifier: string;
  discriminator: number;
  vendorId?: number;
  productId?: number;
  deviceName?: string;
  deviceType?: number;
  commissioningMode: number;
  addresses: Array<{ ip: string; port: number; type: string }>;
}

// --- Camera / Frigate types ---

export interface CameraInfo {
  name: string;
  displayName: string;
  manufacturer: string | null;
  model: string | null;
  ipAddress: string;
  macAddress: string | null;
  enabled: boolean;
  autoDiscovered: boolean;
  status: "recording" | "detecting" | "idle" | "offline";
  lastSeen: string;
  lastDetection: DetectionEvent | null;
}

export interface DetectionEvent {
  id: string;
  camera: string;
  label: string;
  score: number;
  startTime: number;
  endTime: number | null;
  thumbnail: string;
  hasClip: boolean;
  hasSnapshot: boolean;
}

export interface DiscoveredCamera {
  id: string;
  name: string;
  ip: string;
  mac: string | null;
  manufacturer: string | null;
  model: string | null;
  discoveredAt: string;
}

export interface CameraSSEEvent {
  type: "connected" | "detection" | "camera_discovered" | "camera_online" | "camera_offline";
  camera?: string;
  label?: string;
  score?: number;
  thumbnail?: string;
  timestamp?: number;
}

// --- Network / Router types ---

export interface NetworkOverview {
  interfaces: {
    lan: Record<string, unknown>;
    wan: Record<string, unknown>;
  };
  wireless: Record<string, unknown>;
  system: {
    board: Record<string, unknown>;
    resources: Record<string, unknown>;
  };
  connectedDeviceCount: number;
  routerConnected: boolean;
}

export interface ConnectedDevice {
  hostname: string;
  ipaddr: string;
  macaddr: string;
  expire: number;
  isWireless: boolean;
  signal?: number;
  rxRate?: number;
  txRate?: number;
}

export interface WirelessScanResult {
  ssid: string;
  bssid: string;
  channel: number;
  signal: number;
  quality: number;
  quality_max: number;
  encryption: {
    enabled: boolean;
    wpa?: number[];
    authentication?: string[];
  };
}

export interface FirewallConfig {
  zones: Record<string, unknown>;
  rules: Record<string, unknown>;
  redirects: Record<string, unknown>;
}

export interface NetworkCommandResult {
  status: string;
  tier?: number;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
  reason?: string;
  expiresIn?: number;
  operation?: string;
}
