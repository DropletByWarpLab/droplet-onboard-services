"use client";

import { useState } from "react";
import { Check, Key, Trash2 } from "lucide-react";
import { saveProviderKey, deleteProviderKey } from "@/lib/api";

interface ProviderKeyFormProps {
  provider: string;
  label: string;
  hasKey: boolean;
  onUpdate: () => void;
}

export function ProviderKeyForm({
  provider,
  label,
  hasKey,
  onUpdate,
}: ProviderKeyFormProps) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await saveProviderKey(provider, apiKey.trim());
      setApiKey("");
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteProviderKey(provider);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete key");
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <Key size={16} className="text-label-secondary" />
          <h3 className="type-headline text-label-primary">{label}</h3>
        </div>
        {hasKey && (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 type-caption-1 text-system-green">
              <Check size={14} /> Configured
            </span>
            <button
              onClick={handleDelete}
              className="p-1.5 rounded-full text-label-tertiary hover:text-system-red hover:bg-system-red/10 transition-colors"
              aria-label="Delete key"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? "Replace existing key..." : "Paste your API key..."}
          className="dp-input !rounded-sm"
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="dp-btn-primary type-subheadline !min-h-[40px]"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {error && (
        <p className="mt-2 type-footnote text-system-red">{error}</p>
      )}
    </div>
  );
}
