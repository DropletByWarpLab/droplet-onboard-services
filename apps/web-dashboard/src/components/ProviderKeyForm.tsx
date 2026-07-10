"use client";

import { useState } from "react";
import { Check, Key, Trash2 } from "lucide-react";
import { saveProviderKey, deleteProviderKey } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import { ConfirmDialog } from "@/components/ConfirmDialog";

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
  // WARP-291: confirm before deleting an API key. Deletion is
  // recoverable (the user re-pastes the key) but cancelling all
  // in-flight assistant turns + paying for a fresh API key call shape
  // is a real cost, so a confirm step is warranted.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await saveProviderKey(provider, apiKey.trim());
      setApiKey("");
      onUpdate();
    } catch (err) {
      // WARP-294: keep raw err out of the DOM — orchestrator can
      // return terse strings (HTTP statuses, validator codes).
      setError(translateError(err, "provider-key"));
    } finally {
      setSaving(false);
    }
  };

  const performDelete = async () => {
    try {
      await deleteProviderKey(provider);
      setConfirmingDelete(false);
      onUpdate();
    } catch (err) {
      // WARP-294: same — translate before rendering.
      setError(translateError(err, "provider-key"));
      throw err;
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <Key size={16} style={{ color: "var(--text-muted)" }} />
          <h3 className="type-headline" style={{ color: "var(--text)" }}>
            {label}
          </h3>
        </div>
        {hasKey && (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 type-caption-1 text-system-green">
              <Check size={14} /> Configured
            </span>
            <button
              onClick={() => setConfirmingDelete(true)}
              className="p-1.5 rounded-full text-[var(--text-muted)] hover:text-[#ef4444] hover:bg-[rgba(239,68,68,0.1)] transition-colors"
              aria-label="Delete key"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? "Replace existing key..." : "Paste your API key..."}
          className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--text)",
          }}
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="btn primary"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {error && (
        <p className="mt-2 type-footnote text-[#ef4444] bg-[rgba(239,68,68,0.1)] rounded-[var(--radius-input)] px-3 py-2">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        onConfirm={performDelete}
        onCancel={() => setConfirmingDelete(false)}
        title={`Remove ${label} API key?`}
        description="The assistant will stop using this provider until you paste a new key. Your saved key cannot be recovered after this."
        confirmLabel="Remove key"
        variant="destructive"
      />
    </div>
  );
}
