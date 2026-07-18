import type { MatterDevice } from "@/lib/types";

/**
 * WARP-897: Matter cluster ids the control widgets gate on. A widget only
 * renders when the device actually implements the cluster its commands
 * target — capability truth comes from the commissioned endpoint list,
 * never from the category alone (a plain on/off bulb is a "light" too).
 */
export const CLUSTER = {
  ON_OFF: 0x0006,
  LEVEL_CONTROL: 0x0008,
  COLOR_CONTROL: 0x0300,
  WINDOW_COVERING: 0x0102,
  FAN_CONTROL: 0x0202,
  DOOR_LOCK: 0x0101,
  MEDIA_PLAYBACK: 0x0506,
} as const;

export function hasCluster(device: MatterDevice, clusterId: number): boolean {
  return device.endpoints.some(
    (ep) => ep.endpointId > 0 && ep.clusters.includes(clusterId),
  );
}
