// --- Smart Home types ---

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

export interface SmartHomeDevice {
  entityId: string;
  category: SmartHomeCategory;
  name: string;
  state: string;
  attributes: Record<string, unknown>;
  lastChanged: string;
  lastUpdated: string;
}

export interface SmartHomeGrouped {
  lights: SmartHomeDevice[];
  switches: SmartHomeDevice[];
  sensors: SmartHomeDevice[];
  climate: SmartHomeDevice[];
  media: SmartHomeDevice[];
  covers: SmartHomeDevice[];
  other: SmartHomeDevice[];
}

export interface SmartHomeCommand {
  service: string;
  data?: Record<string, unknown>;
}

export interface DiscoveredDevice {
  flowId: string;
  handler: string;
  name: string;
  description: string;
}

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
