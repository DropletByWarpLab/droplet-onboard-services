// --- Device categories (used by the Matter controller) ---
//
// `SmartHomeCategory` is the device-category enum used across the
// dashboard UI, the Matter service, and stored attribute maps. The name
// stays generic ("smart-home") rather than collapsing to `MatterCategory`
// because the same enum is what DeviceCard.tsx / DeviceGroup.tsx render
// against — a rename would ripple across the frontend without any real
// clarity gain.

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

// --- Matter types ---

export interface MatterDiscoveredDevice {
  deviceIdentifier: string;
  discriminator: number;
  vendorId?: number;
  productId?: number;
  deviceName?: string;
  deviceType?: number;
  commissioningMode: number;
  /**
   * Mirror of `services/matter-controller/src/types.ts`. `type` is the
   * transport label — "udp" | "tcp" | "ble" | "ip" — always a non-empty
   * string. "ip" appears from matter.js 0.17 onward for a transport-agnostic
   * DNS-SD record; treat anything other than "ble" as an IP address.
   * `peripheralAddress` is present only on BLE records (no ip/port).
   */
  addresses: Array<{
    ip: string;
    port: number;
    type: string;
    peripheralAddress?: string;
  }>;
}

export interface MatterCommissionedDevice {
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
  /** WARP-1396 — the household identity overlaid at the orchestrator from
   *  DeviceAlias. `name` above stays the Matter-reported product name; these
   *  are the Droplet-local alias + room. Absent when no alias row exists. */
  friendlyName?: string | null;
  roomId?: string | null;
  roomName?: string | null;
}

/** WARP-1396 — a household room (Droplet-local). */
export interface Room {
  id: string;
  name: string;
  icon: string;
  sortOrder: number;
  deviceCount: number;
}

export interface MatterEndpointInfo {
  endpointId: number;
  deviceTypes: Array<{ deviceType: number; revision: number }>;
  clusters: number[];
}

export interface MatterGrouped {
  lights: MatterCommissionedDevice[];
  switches: MatterCommissionedDevice[];
  sensors: MatterCommissionedDevice[];
  climate: MatterCommissionedDevice[];
  media: MatterCommissionedDevice[];
  covers: MatterCommissionedDevice[];
  locks: MatterCommissionedDevice[];
  other: MatterCommissionedDevice[];
}
