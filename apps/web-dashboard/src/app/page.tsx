"use client";

import Link from "next/link";
import {
  Activity,
  Cpu,
  HardDrive,
  MessageSquare,
  Network,
  Wifi,
} from "lucide-react";
import { StatusCard } from "@/components/StatusCard";
import { useDevice } from "@/lib/hooks/useDevice";
import { useModels } from "@/lib/hooks/useModels";

export default function DashboardPage() {
  const { device, health, isLoading } = useDevice();
  const { models } = useModels();

  const localModels = models.filter((m) => m.provider === "ollama");
  const cloudModels = models.filter((m) => m.provider !== "ollama");

  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <h1 className="text-2xl font-bold text-slate-100 mb-6">Dashboard</h1>

      {isLoading ? (
        <div className="text-slate-400">Loading device info...</div>
      ) : (
        <>
          {/* Device info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatusCard
              title="Hostname"
              value={device?.hostname ?? "—"}
              subtitle={device?.deviceId}
              status={device ? "ok" : "offline"}
            />
            <StatusCard
              title="IP Address"
              value={device?.ip ?? "Not assigned"}
              subtitle={device?.networkMode.toUpperCase()}
              status={device?.ip ? "ok" : "warning"}
            />
            <StatusCard
              title="Hardware"
              value={device?.hardwareRev ?? "—"}
            />
            <StatusCard
              title="Uptime"
              value={health ? formatUptime(health.uptime) : "—"}
              subtitle={`v${health?.version ?? "0.1.0"}`}
            />
          </div>

          {/* Services */}
          <h2 className="text-lg font-semibold text-slate-200 mb-4">
            Services
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <StatusCard
              title="Database"
              value={health?.services.db ? "Connected" : "Offline"}
              status={health?.services.db ? "ok" : "error"}
            />
            <StatusCard
              title="Cache (Redis)"
              value={health?.services.redis ? "Connected" : "Offline"}
              status={health?.services.redis ? "ok" : "error"}
            />
            <StatusCard
              title="AI Gateway"
              value={health?.services.aiGateway ? "Connected" : "Offline"}
              status={health?.services.aiGateway ? "ok" : "error"}
            />
          </div>

          {/* AI Models */}
          <h2 className="text-lg font-semibold text-slate-200 mb-4">
            AI Models
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <StatusCard
              title="Local Models (Jetson)"
              value={`${localModels.length} available`}
              subtitle={
                localModels.length > 0
                  ? localModels.map((m) => m.name).join(", ")
                  : "Jetson not connected"
              }
              status={localModels.length > 0 ? "ok" : "offline"}
            />
            <StatusCard
              title="Cloud Models"
              value={`${cloudModels.length} available`}
              subtitle={
                cloudModels.length > 0
                  ? "API keys configured"
                  : "Add API keys in Settings"
              }
              status={cloudModels.length > 0 ? "ok" : "warning"}
            />
          </div>

          {/* Quick actions */}
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 px-6 py-3 bg-droplet-600 text-white rounded-xl
              hover:bg-droplet-500 transition-colors font-medium"
          >
            <MessageSquare size={18} />
            Start chatting
          </Link>
        </>
      )}
    </div>
  );
}
