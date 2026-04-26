// --- Camera / Frigate VMS types ---

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
  label: string;       // "person", "car", "dog", etc.
  score: number;        // 0-1 confidence
  startTime: number;    // Unix timestamp
  endTime: number | null;
  thumbnail: string;    // URL to thumbnail via orchestrator proxy
  hasClip: boolean;
  hasSnapshot: boolean;
}

/**
 * Richer event payload for the dedicated Events page. Extends the
 * lightweight DetectionEvent with the metadata needed to drive the
 * filter rail and per-event detail panel: zone hits, sub-label
 * (Frigate's secondary classifier — license plate text, recognised
 * person name, etc.), and the retain-indefinitely flag that backs the
 * "Saved" badge.
 *
 * `clipUrl` is an authenticated proxy URL — never the bare Frigate
 * media URL, so camera streams stay LAN-side.
 */
export interface EventDetail extends DetectionEvent {
  /** Frigate sub-label (e.g. detected person name from face recogniser). */
  subLabel: string | null;
  /** Highest-confidence sub-label score, [0, 1]. */
  subLabelScore: number | null;
  /** Zone names this event entered, in entry order. */
  zones: string[];
  /** True if the operator marked this event for indefinite retention.
   *  Toggling lives behind a separate route — see Phase 2.2. */
  retainIndefinitely: boolean;
  /** Authenticated clip download URL, only set when hasClip is true. */
  clipUrl: string | null;
  /** Authenticated snapshot URL, only set when hasSnapshot is true. */
  snapshotUrl: string | null;
}

/**
 * Frigate review item (0.13+). Reviews group sequential events on the
 * same camera into a single timeline entry — the operator triages
 * clusters, not individual detections. Severity is Frigate's
 * classification of how urgent the cluster is: "alert" surfaces in
 * the operator's notifications, "detection" is below the fold,
 * "significant_motion" is non-object motion that crossed a zone.
 */
export interface ReviewItem {
  id: string;
  camera: string;
  /** Unix timestamp seconds — start of the cluster. */
  startTime: number;
  /** Unix timestamp seconds — null while the cluster is still active. */
  endTime: number | null;
  severity: "alert" | "detection" | "significant_motion";
  /** Whether the operator has marked this review as viewed. */
  hasBeenReviewed: boolean;
  /** Object labels seen across the underlying events (person, car…). */
  objects: string[];
  /** Audio labels Frigate detected (speech, scream…). May be empty. */
  audio: string[];
  /** Zones the activity entered. */
  zones: string[];
  /** Underlying event IDs feeding this review item. */
  detectionIds: string[];
  /** Authenticated proxy URL for the Frigate-rendered preview clip. */
  previewUrl: string | null;
  /** Authenticated proxy URL for the cluster thumbnail. */
  thumbnailUrl: string;
}

export interface DiscoveredCamera {
  id: string;           // MAC or generated key
  name: string;
  ip: string;
  mac: string | null;
  manufacturer: string | null;
  model: string | null;
  rtspUrl: string | null;
  detectionMethod: string;
  discoveredAt: string;
}

export interface FrigateStats {
  uptime: number;
  cameras: Record<string, FrigateCameraStats>;
  detection_fps: number;
  cpu_usages: Record<string, Record<string, number>>;
  gpu_usages: Record<string, Record<string, number>>;
  storage: Record<string, { used: number; total: number; mount_type: string }>;
}

export interface FrigateCameraStats {
  camera_fps: number;
  detection_fps: number;
  capture_pid: number;
  pid: number;
  process_fps: number;
  skipped_fps: number;
}

export interface CameraNotificationPrefs {
  onPerson: boolean;
  onVehicle: boolean;
  onAnimal: boolean;
  onMotion: boolean;
}

export interface CameraSSEEvent {
  type: "connected" | "detection" | "camera_discovered" | "camera_online" | "camera_offline";
  camera?: string;
  label?: string;
  score?: number;
  thumbnail?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}
