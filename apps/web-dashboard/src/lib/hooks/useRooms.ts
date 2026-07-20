"use client";

import useSWR, { mutate as globalMutate } from "swr";
import {
  fetchRooms,
  createRoom as apiCreateRoom,
  updateRoom as apiUpdateRoom,
  deleteRoom as apiDeleteRoom,
  setDeviceAlias as apiSetDeviceAlias,
} from "../api";
import type { Room } from "../types";

const ROOMS_KEY = "/api/matter/rooms";
const DEVICES_KEY = "/api/matter/devices";

/**
 * WARP-1396 — rooms + device-alias state. Reads the room list (SWR) and
 * exposes the mutations, each of which revalidates both the rooms list AND the
 * device list (a rename/assign changes what the device grid shows).
 */
export function useRooms() {
  const { data: rooms, error, isLoading, mutate } = useSWR<Room[]>(
    ROOMS_KEY,
    fetchRooms,
    { refreshInterval: 30000 },
  );

  const revalidate = async () => {
    await Promise.all([mutate(), globalMutate(DEVICES_KEY)]);
  };

  return {
    rooms: rooms ?? [],
    error,
    isLoading,
    async createRoom(name: string, icon: string) {
      const room = await apiCreateRoom(name, icon);
      await revalidate();
      return room;
    },
    async renameRoom(id: string, patch: { name?: string; icon?: string }) {
      const room = await apiUpdateRoom(id, patch);
      await revalidate();
      return room;
    },
    async removeRoom(id: string) {
      await apiDeleteRoom(id);
      await revalidate();
    },
    async setAlias(
      nodeId: string,
      patch: { name?: string | null; roomId?: string | null },
    ) {
      const res = await apiSetDeviceAlias(nodeId, patch);
      await revalidate();
      return res;
    },
  };
}
