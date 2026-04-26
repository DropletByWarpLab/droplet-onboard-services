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

// --- Phase 3: device clients + pairing ---

export interface DeviceClientInfo {
  id: string;
  deviceName: string;
  deviceType: "desktop" | "mobile";
  platform: "macos" | "windows" | "linux" | "ios" | "android" | "other";
  appVersion: string | null;
  lastSeen: string;
  status: "active" | "revoked";
  createdAt: string;
}

export interface PairingCodeInfo {
  code: string;
  expiresAt: string;
  /** `droplet://pair?server=...&code=...` URL the dashboard encodes as a QR */
  pairUrl: string;
}

export interface PairingCodeStatus {
  code: string;
  used: boolean;
  expired: boolean;
  expiresAt: string;
  claimedBy: string | null;
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

// --- Phase 2 share types ---

/** Nextcloud OCS share record as returned by /api/files/share and friends. */
export interface ShareDetail {
  id: number;
  url: string | null;
  token: string | null;
  shareType: number;          // 0=user, 1=group, 3=public link
  permissions: number;        // bitmask: 1=read, 2=update, 4=create, 8=delete, 16=share
  path: string;
  expireDate: string | null;  // "YYYY-MM-DD"
  hasPassword: boolean;
  note: string | null;
  shareWith: string | null;
  shareWithDisplayName: string | null;
  uidOwner: string | null;
  ownerDisplayName: string | null;
  stime: number | null;
}

export interface ShareCreateOptions {
  /** 0=user, 1=group, 3=public link */
  shareType: number;
  permissions?: number;
  expireDate?: string;
  password?: string;
  note?: string;
  shareWith?: string;
}

export interface ShareUpdateOptions {
  permissions?: number;
  password?: string;
  expireDate?: string;
  note?: string;
}

// --- Storage types ---

export interface StorageStats {
  used: number;       // bytes
  total: number;      // bytes
  available: number;  // bytes
  percentage: number; // 0-100
}

export interface DriveInfo {
  device: string;
  mount: string;
  label: string;
  uuid: string;
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  mounted: boolean;
}

export interface DrivesResponse {
  drives: DriveInfo[];
  count: number;
  snapshot_at?: string;
  error?: string;
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

/** Richer event payload returned by GET /api/cameras/events for the
 *  dedicated Events page. Mirrors EventDetail in the orchestrator. */
export interface EventDetail extends DetectionEvent {
  subLabel: string | null;
  subLabelScore: number | null;
  zones: string[];
  retainIndefinitely: boolean;
  /** Authenticated proxy URL for the .mp4 clip; null if has_clip=false. */
  clipUrl: string | null;
  /** Authenticated proxy URL for the saved snapshot; null if has_snapshot=false. */
  snapshotUrl: string | null;
}

/** Filter shape for the Events page UI — mirrored 1:1 onto the
 *  /api/cameras/events query string by `fetchEvents`. All fields
 *  optional; the rail starts empty (= "anything"). */
export interface EventFilter {
  cameras?: string[];
  labels?: string[];
  /** [0, 1] */
  minScore?: number;
  /** Unix-seconds upper bound (exclusive). Used as the cursor. */
  before?: number;
  /** Unix-seconds lower bound (inclusive). Used by the "since" preset. */
  after?: number;
  hasClip?: boolean;
  hasSnapshot?: boolean;
  /** Page size, [1, 200]. Defaults to 50 server-side. */
  limit?: number;
}

export interface FilteredEventsResult {
  events: EventDetail[];
  /** start_time of the oldest event returned, or null if no more pages. */
  nextCursor: number | null;
}

// --- Reviews (Frigate 0.13+) ---

export type ReviewSeverity = "alert" | "detection" | "significant_motion";

/**
 * A Frigate review item — a cluster of sequential events on the same
 * camera, classified by severity. Reviews are the operator's primary
 * triage unit on the Events page's "Alerts" + "Detections" tabs.
 */
export interface ReviewItem {
  id: string;
  camera: string;
  startTime: number;
  endTime: number | null;
  severity: ReviewSeverity;
  hasBeenReviewed: boolean;
  objects: string[];
  audio: string[];
  zones: string[];
  detectionIds: string[];
  previewUrl: string | null;
  thumbnailUrl: string;
}

export interface ReviewFilter {
  cameras?: string[];
  severity?: ReviewSeverity[];
  before?: number;
  after?: number;
  /** When set, only reviewed (true) or unreviewed (false) items. */
  reviewed?: boolean;
  limit?: number;
}

export interface FilteredReviewsResult {
  reviews: ReviewItem[];
  nextCursor: number | null;
}

// --- Recordings + timeline (Phase 3) ---

export interface RecordingHour {
  hour: number;
  events: number;
  duration: number;
  motion: number;
}

export interface RecordingDay {
  day: string;
  events: number;
  duration: number;
  hours: RecordingHour[];
}

export interface RecordingSegment {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
  motion: number;
  objects: number;
}

export interface TimelineEntry {
  timestamp: number;
  sourceId: string;
  classType: string;
  label: string;
  zone: string | null;
  score: number;
}

// --- Per-camera settings (Phase 4.1) ---

export interface ObjectFilter {
  threshold: number;
  minScore: number;
}

/** Frigate zone in the dashboard's structured shape. Coordinates are
 *  flat normalised [x1, y1, x2, y2, …] in [0, 1] image space. */
export interface CameraZone {
  name: string;
  coordinates: number[];
  objects: string[];
  inertia: number;
}

/** A single motion-mask polygon. Same coord convention as zones. */
export interface MotionMaskPolygon {
  coordinates: number[];
}

// --- PTZ (Phase 6.1) ---

export type PtzAction =
  | "MOVE_UP"
  | "MOVE_DOWN"
  | "MOVE_LEFT"
  | "MOVE_RIGHT"
  | "ZOOM_IN"
  | "ZOOM_OUT"
  | "STOP";

export interface PtzCapabilities {
  supportsPanTilt: boolean;
  supportsZoom: boolean;
  presets: string[];
}

// --- Camera system status (Phase 5) ---

export interface DetectorStat {
  name: string;
  inferenceSpeedMs: number;
  pid: number | null;
}

export interface GpuStat {
  name: string;
  gpuPct: number;
  memPct: number | null;
  tempC: number | null;
}

export interface StorageStat {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  mountType: string;
}

export interface CameraSystemStatus {
  version: string;
  uptimeSec: number;
  cameraCount: number;
  camerasLive: number;
  cameraFps: Array<{
    name: string;
    cameraFps: number;
    detectionFps: number;
    skippedFps: number;
  }>;
  detectors: DetectorStat[];
  gpus: GpuStat[];
  storage: StorageStat[];
  cpuPct: number;
}

export interface CameraSettings {
  detectEnabled: boolean;
  detectFps: number;
  trackedLabels: string[];
  objectFilters: Record<string, ObjectFilter>;
  recordEnabled: boolean;
  recordRetainDays: number;
  snapshotsEnabled: boolean;
  snapshotRetainDays: number;
  zones: CameraZone[];
  motionMasks: MotionMaskPolygon[];
}

export interface CameraSettingsPatch {
  detectEnabled?: boolean;
  detectFps?: number;
  trackedLabels?: string[];
  objectFilters?: Record<string, Partial<ObjectFilter>>;
  recordEnabled?: boolean;
  recordRetainDays?: number;
  snapshotsEnabled?: boolean;
  snapshotRetainDays?: number;
  zones?: CameraZone[];
  motionMasks?: MotionMaskPolygon[];
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

// --- Camera groups ---

export interface CameraGroupMember {
  /** Frigate-key for the camera; matches CameraInfo.name. */
  cameraName: string;
  cameraDisplayName: string;
  sortOrder: number;
}

export interface CameraGroupInfo {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  members: CameraGroupMember[];
  createdAt: string;
  updatedAt: string;
}

// --- Camera pins (per-user prefs; not shared across operators) ---

/**
 * Per-user "pinned" camera. Operators pin the cameras they actually
 * watch so they float to the top of the grid above the alphabetical
 * default order. Pins are keyed on Frigate camera NAME — not a Camera
 * FK — because they're a low-stakes pref. Dangling pins (camera was
 * removed) are filtered on the dashboard before render.
 */
export interface CameraPinInfo {
  cameraName: string;
  /** Lower sortOrder renders first. Negative numbers are normal — newly
   *  pinned cameras get `min - 1` so they jump above existing pins. */
  sortOrder: number;
  createdAt: string;
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

export interface InterfaceStatus {
  up: boolean;
  pending?: boolean;
  available?: boolean;
  autostart?: boolean;
  device?: string;
  proto?: string;
  uptime?: number;
  l3_device?: string;
  "ipv4-address"?: { address: string; mask: number }[];
  "ipv6-address"?: { address: string; mask: number }[];
  route?: unknown[];
  "dns-server"?: string[];
  data?: Record<string, unknown>;
}

export interface NetworkOverview {
  interfaces: {
    lan: InterfaceStatus;
    wan: InterfaceStatus;
  };
  wireless: Record<string, unknown>;
  system: {
    board: {
      kernel?: string;
      hostname?: string;
      system?: string;
      model?: string;
      board_name?: string;
      release?: { distribution?: string; version?: string; target?: string };
    };
    resources: {
      uptime?: number;
      localtime?: number;
      load?: number[];
      memory?: { total: number; free: number; shared: number; buffered: number };
      swap?: { total: number; free: number };
    };
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

// WARP-42: mirror the routing service's wire shape (services/routing/schemas.py).
// Fields are optional because OpenWrt omits defaults; index signatures let
// the UI read extras like `.anonymous`, `.type`, etc. without compile errors.

export interface FirewallZone {
  name?: string;
  network?: string | string[];
  input?: string;
  output?: string;
  forward?: string;
  masq?: string;
  [key: string]: unknown;
}

export interface FirewallRule {
  name?: string;
  src?: string;
  dest?: string;
  src_mac?: string;
  proto?: string | string[];
  src_port?: string;
  dest_port?: string;
  target?: string;
  enabled?: string;
  [key: string]: unknown;
}

export interface FirewallRedirect {
  name?: string;
  src?: string;
  dest?: string;
  proto?: string | string[];
  src_dport?: string;
  dest_ip?: string;
  dest_port?: string;
  target?: string;
  enabled?: string;
  [key: string]: unknown;
}

export interface FirewallCollection<T> {
  values: Record<string, T>;
}

export interface FirewallConfig {
  zones: FirewallCollection<FirewallZone>;
  rules: FirewallCollection<FirewallRule>;
  redirects: FirewallCollection<FirewallRedirect>;
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

// --- WARP-83: enriched device types for the card-grid view ---

export interface DevicePresenceDay {
  date: string;
  seenMinutes: number;
}

export interface DeviceGroupRef {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
}

export interface EnrichedNetworkDevice {
  mac: string;
  displayName: string | null;
  icon: string | null;
  notes: string | null;
  vendor: string | null;
  hostname: string | null;
  lastIp: string | null;
  firstSeen: string;
  lastSeen: string;
  isBlocked: boolean;
  online: boolean;
  signal?: number;
  groups: DeviceGroupRef[];
  presenceDays?: DevicePresenceDay[];
}

export interface DeviceGroupWithCount extends DeviceGroupRef {
  _count: { devices: number };
}

// --- WARP-95: schedule types ---

export interface ScheduleWindow {
  id: string;
  /** Day-of-week bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64. */
  daysOfWeek: number;
  /** Start minute-of-day, [0, 1440). */
  startMin: number;
  /** End minute-of-day, [0, 1440). If endMin <= startMin, window wraps past midnight. */
  endMin: number;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  windows: ScheduleWindow[];
  lastFiredAt?: string;
  nextTransitionAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleOverride {
  id: string;
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  action: "allow" | "block";
  startAt: string;
  endAt: string;
  note?: string;
  createdAt: string;
}

export interface ScheduleEvent {
  id: string;
  scheduleId?: string;
  overrideId?: string;
  subjectType: "device" | "group";
  deviceMac?: string;
  groupId?: string;
  transition: "blocked" | "unblocked";
  reason: string;
  occurredAt: string;
}
