// --- Device categories (used by the Matter controller) ---
//
// The Home Assistant bridge has been removed from this control plane;
// Matter is the only smart-home path now. The `SmartHomeCategory` name is
// kept for the category enum because the dashboard UI and the Matter
// service both reference it directly — renaming it to `MatterCategory`
// would ripple across DeviceCard.tsx, matter.service.ts, and stored
// attribute maps, without any real clarity gain.

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
