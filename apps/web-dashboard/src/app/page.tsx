"use client";

import useSWR from "swr";
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { StatusCard } from "@/components/StatusCard";
import { StorageGauge } from "@/components/StorageGauge";
import { useDevice } from "@/lib/hooks/useDevice";
import { useModels } from "@/lib/hooks/useModels";
import { useStorage } from "@/lib/hooks/useStorage";
import { fetchSystemHealth, type SystemHealth } from "@/lib/api";

// WARP-43: aggregate status → { label, pill classes } used by the banner.
const SYSTEM_HEALTH_COPY: Record<
  SystemHealth["status"],
  { label: string; pillClass: string; dotClass: string }
> = {
  ok: {
    label: "All systems operational",
    pillClass: "border-system-green bg-system-green/5 text-system-green",
    dotClass: "bg-system-green",
  },
  degraded: {
    label: "Degraded — some components offline",
    pillClass: "border-system-orange bg-system-orange/5 text-system-orange",
    dotClass: "bg-system-orange",
  },
  down: {
    label: "Down — critical dependency unreachable",
    pillClass: "border-system-red bg-system-red/5 text-system-red",
    dotClass: "bg-system-red",
  },
};

export default function DashboardPage() {
  const { device, health, isLoading } = useDevice();
  const { models } = useModels();
  const { storage, isLoading: storageLoading } = useStorage();
  // WARP-43: rolled-up system health. Polls every 15s to match the
  // orchestrator's probe cadence.
  const { data: systemHealth } = useSWR<SystemHealth>(
    "/api/orchestrator/health",
    fetchSystemHealth,
    { refreshInterval: 15_000 },
  );

  const localModels = models.filter((m) => m.provider === "ollama");
  const cloudModels = models.filter((m) => m.provider !== "ollama");

  function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <h1 className="type-large-title text-label-primary mb-8">Dashboard</h1>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="dp-card p-5 h-[100px] animate-shimmer" />
          ))}
        </div>
      ) : (
        <>
          {/* Device info */}
          <section className="mb-10">
            <h2 className="type-title-3 text-label-primary mb-4">Device</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
          </section>

          {/* WARP-43: rolled-up system-health pill */}
          {systemHealth && (
            <section className="mb-10" aria-labelledby="system-health-title">
              <h2 id="system-health-title" className="type-title-3 text-label-primary mb-4">
                System health
              </h2>
              <div
                className={`dp-card flex flex-col gap-3 ${SYSTEM_HEALTH_COPY[systemHealth.status].pillClass}`}
                role={systemHealth.status === "ok" ? "status" : "alert"}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${SYSTEM_HEALTH_COPY[systemHealth.status].dotClass}`}
                  />
                  <span className="type-subheadline font-medium">
                    {SYSTEM_HEALTH_COPY[systemHealth.status].label}
                  </span>
                </div>
                <ul className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {systemHealth.components.map((c) => (
                    <li
                      key={c.name}
                      className="flex items-center gap-2 type-caption-1 text-label-secondary"
                      title={c.error ?? `${c.latencyMs}ms @ ${new Date(c.lastCheckedAt).toLocaleTimeString()}`}
                    >
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${
                          c.status === "ok" ? "bg-system-green" : "bg-system-red"
                        }`}
                      />
                      <span className="capitalize">{c.name.replace("-", " ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* Storage */}
          <section className="mb-10">
            <h2 className="type-title-3 text-label-primary mb-4">Storage</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <StorageGauge storage={storage} isLoading={storageLoading} />
              <div className="flex flex-col gap-4">
                <StatusCard
                  title="Files Backend"
                  value={storage ? "Nextcloud" : "Local"}
                  subtitle="WebDAV storage"
                  status="ok"
                />
                <StatusCard
                  title="Used Space"
                  value={storage && storage.total > 0
                    ? `${Math.round(storage.percentage)}%`
                    : "---"}
                  subtitle={storage && storage.total > 0
                    ? `${formatBytes(storage.available)} free`
                    : "Checking..."}
                  status={
                    !storage ? "offline"
                    : storage.percentage > 90 ? "error"
                    : storage.percentage > 75 ? "warning"
                    : "ok"
                  }
                />
              </div>
            </div>
          </section>

          {/* Services */}
          <section className="mb-10">
            <h2 className="type-title-3 text-label-primary mb-4">Services</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatusCard
                title="Database"
                value={health?.services.db ? "Connected" : "Offline"}
                status={health?.services.db ? "ok" : "error"}
              />
              <StatusCard
                title="Cache"
                value={health?.services.redis ? "Connected" : "Offline"}
                status={health?.services.redis ? "ok" : "error"}
              />
              <StatusCard
                title="AI Gateway"
                value={health?.services.aiGateway ? "Connected" : "Offline"}
                status={health?.services.aiGateway ? "ok" : "error"}
              />
            </div>
          </section>

          {/* AI Models */}
          <section className="mb-10">
            <h2 className="type-title-3 text-label-primary mb-4">AI Models</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <StatusCard
                title="Local Models"
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
          </section>

          {/* Quick action */}
          <Link href="/chat" className="dp-btn-primary">
            <MessageSquare size={18} />
            Start chatting
          </Link>
        </>
      )}
    </div>
  );
}
