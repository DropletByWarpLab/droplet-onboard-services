/**
 * Wire types for the matter-controller sidecar HTTP API (WARP-850).
 *
 * These shapes ARE the HTTP contract the orchestrator's
 * `apps/orchestrator/src/services/matter.service.ts` client consumes —
 * they deliberately mirror `apps/orchestrator/src/types/smart-home.ts`
 * byte-for-byte so the orchestrator's `/api/matter/*` route responses
 * (and everything downstream: dashboard, mcp-server, tools-core
 * smart-home handlers) are unchanged by the WARP-850 extraction.
 * If you change a field here, change the orchestrator mirror in the
 * same commit.
 */

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

export interface MatterDiscoveredDevice {
  deviceIdentifier: string;
  discriminator: number;
  vendorId?: number;
  productId?: number;
  deviceName?: string;
  deviceType?: number;
  commissioningMode: number;
  /**
   * `type` is the transport label — "udp" | "tcp" | "ble" | "ip". It is
   * derived via matter.js's `ServerAddress.protocolOf()` and is ALWAYS a
   * non-empty string. "ip" appears from matter.js 0.17 onward, where a
   * transport-agnostic DNS-SD address record carries no explicit transport;
   * treat anything other than "ble" as an IP address.
   *
   * `peripheralAddress` is present only on BLE records, which have no
   * `ip`/`port` (those stay at "" / 0 so the shape is uniform).
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

/**
 * Error body every non-2xx sidecar response carries.
 *
 * WARP-850 requirement #4 (error-contract preservation): the
 * orchestrator's `translateCommissionError()` (routes/matter.ts)
 * pattern-matches raw matter.js error MESSAGES, and the 22 WARP-851
 * tests pin those mappings. The sidecar therefore passes the raw
 * matter.js error through structurally — `errorClass` is the matter.js
 * error constructor name (e.g. `CommissionableDeviceDiscoveryFailedError`)
 * and `errorMessage` is the untouched `err.message`. The orchestrator
 * client rethrows `new Error(errorMessage)` with `name = errorClass`,
 * so the translation layer sees exactly what it saw in-process.
 */
export interface SidecarErrorBody {
  error: string;
  errorClass: string;
  errorMessage: string;
}
