"use client";

import Link from "next/link";
import { MessageSquare } from "lucide-react";
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
