"use client";

import useSWR from "swr";
import { authFetch } from "@/lib/auth";

interface SwitchPort {
  port: number;
  name: string;
  enabled: boolean;
  link_up: boolean;
  speed: string | null;
  duplex: string | null;
  is_sfp: boolean;
  vlan: number | null;
}

interface SwitchPoEPort {
  port: number;
  enabled: boolean;
  delivering: boolean;
  power_mw: number;
  class: string | null;
  max_power_mw: number;
}

interface SwitchVlan {
  vlan_id: number;
  name: string;
  ports: { port: number; tagged: boolean; member: boolean }[];
}

export interface SwitchData {
  ports: SwitchPort[];
  poe: SwitchPoEPort[];
  vlans: SwitchVlan[];
}

async function fetchSwitchPorts(): Promise<SwitchPort[]> {
  const res = await authFetch("/api/switch/ports");
  if (!res.ok) throw new Error(`Switch ports: ${res.status}`);
  const data = await res.json();
  return data.ports ?? [];
}

async function fetchSwitchPoe(): Promise<SwitchPoEPort[]> {
  const res = await authFetch("/api/switch/poe");
  if (!res.ok) throw new Error(`Switch PoE: ${res.status}`);
  const data = await res.json();
  return data.ports ?? [];
}

async function fetchSwitchVlans(): Promise<SwitchVlan[]> {
  const res = await authFetch("/api/switch/vlans");
  if (!res.ok) throw new Error(`Switch VLANs: ${res.status}`);
  const data = await res.json();
  return data.vlans ?? [];
}

export function useSwitch() {
  const { data: ports, error: portsErr, isLoading: portsLoading, mutate: mutatePorts } =
    useSWR<SwitchPort[]>("/api/switch/ports", fetchSwitchPorts, {
      refreshInterval: 10_000,
    });

  const { data: poe, mutate: mutatePoe } = useSWR<SwitchPoEPort[]>(
    "/api/switch/poe",
    fetchSwitchPoe,
    { refreshInterval: 10_000 }
  );

  const { data: vlans, mutate: mutateVlans } = useSWR<SwitchVlan[]>(
    "/api/switch/vlans",
    fetchSwitchVlans,
    { refreshInterval: 30_000 }
  );

  return {
    ports: ports ?? [],
    poe: poe ?? [],
    vlans: vlans ?? [],
    isLoading: portsLoading,
    error: portsErr,
    refresh: () => {
      mutatePorts();
      mutatePoe();
      mutateVlans();
    },
  };
}
