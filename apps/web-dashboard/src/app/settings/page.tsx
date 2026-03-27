"use client";

import { useEffect, useState } from "react";
import { FolderSync, Server, Wifi } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProviderKeyForm } from "@/components/ProviderKeyForm";
import { SyncTargetCard } from "@/components/SyncTargetCard";
import { SyncTargetForm } from "@/components/SyncTargetForm";
import { useDevice } from "@/lib/hooks/useDevice";
import { useSyncTargets } from "@/lib/hooks/useSyncTargets";
import { listProviderKeys } from "@/lib/api";

export default function SettingsPage() {
  const { device, health } = useDevice();
  const { targets, refresh: refreshTargets } = useSyncTargets();
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);

  const loadKeys = async () => {
    try {
      const providers = await listProviderKeys();
      setConfiguredProviders(providers);
    } catch {
      // Non-fatal
    }
  };

  useEffect(() => {
    loadKeys();
  }, []);

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <h1 className="type-large-title text-label-primary mb-8">Settings</h1>

      {/* Appearance */}
      <section className="mb-10">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
          Appearance
        </h2>
        <div className="dp-group">
          <div className="dp-row">
            <span className="type-body text-label-primary">Theme</span>
            <ThemeToggle />
          </div>
        </div>
      </section>

      {/* Device Info */}
      <section className="mb-10">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
          Device Information
        </h2>
        <div className="dp-group">
          <InfoRow label="Device ID" value={device?.deviceId ?? "—"} />
          <InfoRow label="Hostname" value={device?.hostname ?? "—"} />
          <InfoRow label="Hardware" value={device?.hardwareRev ?? "—"} />
          <InfoRow label="Network Mode" value={device?.networkMode ?? "—"} />
          <InfoRow label="IP Address" value={device?.ip ?? "Not assigned"} />
        </div>
      </section>

      {/* AI Providers */}
      <section className="mb-10">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
          AI Providers
        </h2>

        {/* Ollama / Local */}
        <div className="dp-group mb-3">
          <div className="dp-row">
            <div>
              <p className="type-body text-label-primary">Ollama (Local — Jetson)</p>
              <p className="type-caption-1 text-label-tertiary mt-0.5">
                Runs on your Jetson device over LAN
              </p>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full type-caption-2 font-medium ${
                health?.services.aiGateway
                  ? "bg-system-green/15 text-system-green"
                  : "bg-label-quaternary/30 text-label-tertiary"
              }`}
            >
              {health?.services.aiGateway ? "Connected" : "Offline"}
            </span>
          </div>
        </div>

        {/* Cloud providers */}
        <div className="dp-group">
          <ProviderKeyForm
            provider="anthropic"
            label="Anthropic (Claude)"
            hasKey={configuredProviders.includes("anthropic")}
            onUpdate={loadKeys}
          />
          <ProviderKeyForm
            provider="openai"
            label="OpenAI (GPT)"
            hasKey={configuredProviders.includes("openai")}
            onUpdate={loadKeys}
          />
        </div>
      </section>

      {/* File Sync */}
      <section className="mb-10">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
          File Sync
        </h2>
        <p className="type-subheadline text-label-tertiary mb-4 px-1">
          Configure folders to watch and automatically index. Files in these
          folders will be accessible from the Files browser and kept in sync.
        </p>
        <div className="space-y-3">
          {targets.map((target) => (
            <SyncTargetCard
              key={target.id}
              target={target}
              onUpdate={refreshTargets}
            />
          ))}
          <SyncTargetForm onCreated={refreshTargets} />
        </div>
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dp-row">
      <span className="type-body text-label-secondary">{label}</span>
      <span className="type-body text-label-primary font-mono">{value}</span>
    </div>
  );
}
