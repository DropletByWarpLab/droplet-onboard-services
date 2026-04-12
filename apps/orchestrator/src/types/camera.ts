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
