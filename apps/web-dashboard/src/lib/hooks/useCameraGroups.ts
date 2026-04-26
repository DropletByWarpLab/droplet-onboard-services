"use client";

import useSWR from "swr";
import {
  addCameraGroupMembers,
  createCameraGroup,
  deleteCameraGroup,
  fetchCameraGroups,
  removeCameraGroupMember,
  updateCameraGroup,
} from "@/lib/api";
import type { CameraGroupInfo } from "@/lib/types";

const KEY = "/api/cameras/groups";

/**
 * Camera-group state. Mutations call the orchestrator and then mutate
 * SWR's cache so the rail rerenders without a full refetch — the
 * orchestrator returns the updated DTO on each write so we have the
 * authoritative shape immediately.
 *
 * Errors bubble out to the caller; the hook itself doesn't toast or
 * dialog — that's the component's call (the Cameras page surfaces a
 * one-line message; the AddGroupModal blocks the submit button).
 */
export function useCameraGroups() {
  const { data, error, isLoading, mutate } = useSWR<CameraGroupInfo[]>(
    KEY,
    fetchCameraGroups,
    { refreshInterval: 30_000 },
  );

  const groups = data ?? [];

  return {
    groups,
    isLoading,
    error,
    refresh: () => mutate(),

    create: async (input: { name: string; icon?: string | null; cameraNames?: string[] }) => {
      const created = await createCameraGroup(input);
      await mutate();
      return created;
    },
    rename: async (id: string, name: string) => {
      const updated = await updateCameraGroup(id, { name });
      await mutate();
      return updated;
    },
    setIcon: async (id: string, icon: string | null) => {
      const updated = await updateCameraGroup(id, { icon });
      await mutate();
      return updated;
    },
    setSortOrder: async (id: string, sortOrder: number) => {
      const updated = await updateCameraGroup(id, { sortOrder });
      await mutate();
      return updated;
    },
    remove: async (id: string) => {
      await deleteCameraGroup(id);
      await mutate();
    },
    addMembers: async (id: string, cameraNames: string[]) => {
      const updated = await addCameraGroupMembers(id, cameraNames);
      await mutate();
      return updated;
    },
    removeMember: async (id: string, cameraName: string) => {
      const updated = await removeCameraGroupMember(id, cameraName);
      await mutate();
      return updated;
    },
  };
}
