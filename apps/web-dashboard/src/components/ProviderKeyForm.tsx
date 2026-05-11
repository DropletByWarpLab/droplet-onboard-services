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
          <Key size={16} className="text-label-secondary" />
          <h3 className="type-headline text-label-primary">{label}</h3>
        </div>
        {hasKey && (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 type-caption-1 text-system-green">
              <Check size={14} /> Configured
            </span>
            <button
              onClick={() => setConfirmingDelete(true)}
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
        <p className="mt-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
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
