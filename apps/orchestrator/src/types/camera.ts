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
  /** Frigate-genai-generated natural-language description of the
   *  event. Null when the genai feature is off or the description
   *  hasn't been generated yet (Frigate generates async on event
   *  end). Phase 7.7. */
  description: string | null;
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

// --- Recordings + timeline (Phase 3) ---

/**
 * One day's worth of recording activity for a camera, with hourly
 * buckets. The dashboard's date picker keys off these — disabled
 * dates have no `RecordingDay` entry, hovered dates show their
 * `events` count.
 */
export interface RecordingDay {
  /** YYYY-MM-DD */
  day: string;
  /** Total event count across the day. */
  events: number;
  /** Total recording duration covered (seconds). Some hours may be
   *  empty if Frigate was offline. */
  duration: number;
  /** Per-hour summary, indexed by hour-of-day [0, 23]. */
  hours: RecordingHour[];
}

export interface RecordingHour {
  hour: number; // 0-23
  events: number;
  /**
   * Seconds of footage actually retained for this hour, 0–3600.
   *
   * This — not `motion` — is what says "there is something to play here".
   * A camera recording 24/7 over a static scene reports a full 3600s with
   * `motion: 0`, so anything keyed on motion alone renders a fully-recorded
   * hour identically to an empty one (WARP-1959).
   */
  duration: number;
  /**
   * Frigate's motion activity count for the hour. **Unbounded, not a
   * percentage** — real consecutive hours on the box reported 11, 3,
   * 954, 160, 0, 774. Scale against the observed range when rendering;
   * clamping it to 0–100 flattens every busy hour into one tier.
   */
  motion: number;
  /** Tracked-object count for the hour. Frigate reports it; we kept
   *  dropping it, which cost the timeline its only object signal. */
  objects: number;
}

/**
 * A single recording segment (Frigate stores ~10s segments on disk).
 * Used by the playback layer to know what's actually contiguous and
 * to compute gaps that should be skipped on a scrub.
 */
export interface RecordingSegment {
  id: string;
  startTime: number; // Unix seconds
  endTime: number;
  duration: number;
  motion: number;   // 0-100
  objects: number;  // count of detected objects in this segment
}

/**
 * One Frigate timeline entry — an object's transition through a
 * camera (entered zone, became visible, lost). The dashboard pins a
 * dot on the timeline at `timestamp` so the operator can jump to
 * "where the person walked into frame."
 */
export interface TimelineEntry {
  timestamp: number;
  /** Source event ID — usually corresponds to a Frigate event. */
  sourceId: string;
  /** "visible" | "entered_zone" | "attribute" | "gone" | "external" … */
  classType: string;
  label: string;
  zone: string | null;
  score: number;
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
  /**
   * `detection`        — a NEW event was accepted by the per-camera gate;
   *                      the toast/notification center renders this.
   * `detection_update` — a tracker update for the currently-active event;
   *                      cameras page can render live confidence. The
   *                      toast/notification center MUST ignore this so it
   *                      does not saturate.
   * `detection_end`    — the active event's recording window closed and
   *                      the clip is being finalized. Cameras page can
   *                      flip to "clip available". Toast ignores.
   */
  type:
    | "connected"
    | "detection"
    | "detection_update"
    | "detection_end"
    | "camera_discovered"
    | "camera_online"
    | "camera_offline";
  camera?: string;
  label?: string;
  score?: number;
  thumbnail?: string;
  /** Frigate event id — populated for detection / detection_update / detection_end. */
  eventId?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}
