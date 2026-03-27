"use client";

import { useEffect, useState } from "react";
import { Server, Wifi } from "lucide-react";
import { ProviderKeyForm } from "@/components/ProviderKeyForm";
import { useDevice } from "@/lib/hooks/useDevice";
import { listProviderKeys } from "@/lib/api";

export default function SettingsPage() {
  const { device, health } = useDevice();
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
      <h1 className="text-2xl font-bold text-slate-100 mb-6">Settings</h1>

      {/* Device Info */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-200 mb-4 flex items-center gap-2">
          <Server size={18} /> Device Information
        </h2>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
          <InfoRow label="Device ID" value={device?.deviceId ?? "—"} />
          <InfoRow label="Hostname" value={device?.hostname ?? "—"} />
          <InfoRow label="Hardware" value={device?.hardwareRev ?? "—"} />
          <InfoRow label="Network Mode" value={device?.networkMode ?? "—"} />
          <InfoRow label="IP Address" value={device?.ip ?? "Not assigned"} />
        </div>
      </section>

      {/* AI Providers */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-200 mb-4 flex items-center gap-2">
          <Wifi size={18} /> AI Providers
        </h2>

        {/* Ollama / Local */}
        <div className="bg-slate-800 rounded-xl p-4 mb-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-slate-200">
                Ollama (Local — Jetson)
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Runs on your Jetson device over LAN
              </p>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                health?.services.aiGateway
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "bg-slate-700 text-slate-400"
              }`}
            >
              {health?.services.aiGateway ? "Connected" : "Offline"}
            </span>
          </div>
        </div>

        {/* Cloud providers */}
        <div className="space-y-3">
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
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-sm text-slate-200 font-mono">{value}</span>
    </div>
  );
}
