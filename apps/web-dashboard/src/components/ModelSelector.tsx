"use client";

import { useModels } from "@/lib/hooks/useModels";
import { isLocalProvider } from "@/lib/provider";

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
}

const providerBadge: Record<string, { className: string; label: string }> = {
  // Keyed by BOTH names: `local` is what the gateway emits now, `ollama`
  // is what pre-WARP-1926 persisted rows still carry.
  local: { className: "bg-system-green/15 text-system-green", label: "Local" },
  ollama: { className: "bg-system-green/15 text-system-green", label: "Local" },
  anthropic: { className: "bg-system-orange/15 text-system-orange", label: "Anthropic" },
  openai: { className: "bg-system-blue/15 text-system-blue", label: "OpenAI" },
};

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const { models, isLoading } = useModels();

  // Design handoff: when only one model is available there's nothing to
  // choose, so don't show the picker/pill in the input zone at all. The
  // page's auto-select already pins that single model. (Still render while
  // loading, when we don't yet know the count.)
  if (!isLoading && models.length <= 1) return null;

  const selected = models.find((m) => m.id === value);
  const provider = selected?.provider ?? "";

  return (
    <div className="flex items-center gap-2">
      {/* Design-handoff model pill: status dot + mono model name. The
          native <select> supplies the chevron + picker for free. */}
      <label className="chat-model" title="Model">
        <span className="dot" aria-hidden="true" />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Model"
        >
          {isLoading && <option>Loading models...</option>}
          {!isLoading && models.length === 0 && (
            <option>No models available</option>
          )}
          {models.map((m) => (
            // Native <option> can't render a badge, so mark vision-capable
            // models inline so they're distinguishable in the dropdown.
            <option key={m.id} value={m.id}>
              {m.name}
              {m.capabilities?.vision ? " · vision" : ""}
            </option>
          ))}
        </select>
      </label>

      {provider && !isLocalProvider(provider) && (
        <span
          className={`px-2 py-0.5 rounded-full type-caption-2 font-medium ${
            providerBadge[provider]?.className ?? "bg-surface-tertiary text-label-secondary"
          }`}
        >
          {providerBadge[provider]?.label ?? provider}
        </span>
      )}

      {/* Vision pill for the selected model — tells the user this model can
          see attached images (indigo accent, distinct from provider badges). */}
      {selected?.capabilities?.vision && (
        <span className="px-2 py-0.5 rounded-full type-caption-2 font-medium bg-accent-subtle text-accent">
          Vision
        </span>
      )}
    </div>
  );
}
