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
