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
    <div className="bg-slate-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Key size={16} className="text-slate-400" />
          <h3 className="text-sm font-medium text-slate-200">{label}</h3>
        </div>
        {hasKey && (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <Check size={14} /> Configured
            </span>
            <button
              onClick={handleDelete}
              className="p-1 text-slate-500 hover:text-red-400 transition-colors"
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
          className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm
            text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-droplet-500/50"
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="px-4 py-2 bg-droplet-600 text-white text-sm rounded-lg hover:bg-droplet-500
            disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
