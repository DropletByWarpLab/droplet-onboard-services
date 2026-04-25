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
  addresses: Array<{ ip: string; port: number; type: string }>;
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
