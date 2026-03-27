"use client";

import { useModels } from "@/lib/hooks/useModels";

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
}

const providerBadge: Record<string, string> = {
  ollama: "bg-system-green/15 text-system-green",
  anthropic: "bg-system-orange/15 text-system-orange",
  openai: "bg-system-blue/15 text-system-blue",
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
        className="bg-surface-tertiary border border-separator rounded-sm px-3 py-1.5
          type-subheadline text-label-primary
          focus:outline-none focus:ring-2 focus:ring-accent/40
          transition-all duration-200 ease-smooth"
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
          className={`px-2 py-0.5 rounded-full type-caption-2 font-medium ${
            providerBadge[provider] ?? "bg-surface-tertiary text-label-secondary"
          }`}
        >
          {provider}
        </span>
      )}
    </div>
  );
}
