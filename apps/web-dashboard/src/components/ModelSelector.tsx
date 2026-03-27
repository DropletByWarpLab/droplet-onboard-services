"use client";

import { useModels } from "@/lib/hooks/useModels";
import type { ModelInfo } from "@/lib/types";

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
}

const providerBadge: Record<string, string> = {
  ollama: "bg-emerald-500/20 text-emerald-400",
  anthropic: "bg-orange-500/20 text-orange-400",
  openai: "bg-blue-500/20 text-blue-400",
};

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const { models, isLoading } = useModels();

  const selected = models.find((m) => m.id === value);
  const provider = selected?.provider ?? "";

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200
          focus:outline-none focus:ring-2 focus:ring-droplet-500/50"
      >
        {isLoading && <option>Loading models...</option>}
        {!isLoading && models.length === 0 && (
          <option>No models available</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.provider})
          </option>
        ))}
      </select>

      {provider && (
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${providerBadge[provider] ?? "bg-slate-700 text-slate-400"}`}
        >
          {provider}
        </span>
      )}
    </div>
  );
}
