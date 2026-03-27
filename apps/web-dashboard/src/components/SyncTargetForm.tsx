"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { createSyncTarget } from "@/lib/api";

interface SyncTargetFormProps {
  onCreated: () => void;
}

export function SyncTargetForm({ onCreated }: SyncTargetFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [intervalMin, setIntervalMin] = useState(30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!path.trim() || !label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createSyncTarget({
        path: path.trim(),
        label: label.trim(),
        intervalMin,
      });
      setPath("");
      setLabel("");
      setIntervalMin(30);
      setIsOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create target");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="dp-btn-secondary w-full"
      >
        <Plus size={16} />
        Add Sync Target
      </button>
    );
  }

  return (
    <div className="dp-card p-5 space-y-4">
      <div>
        <label className="block type-footnote text-label-secondary mb-1.5">
          Label
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g., Documents"
          className="dp-input"
        />
      </div>
      <div>
        <label className="block type-footnote text-label-secondary mb-1.5">
          Folder Path
        </label>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="e.g., /data/files/documents"
          className="dp-input font-mono"
        />
      </div>
      <div>
        <label className="block type-footnote text-label-secondary mb-1.5">
          Sync Interval
        </label>
        <select
          value={intervalMin}
          onChange={(e) => setIntervalMin(Number(e.target.value))}
          className="dp-input"
        >
          <option value={5}>Every 5 minutes</option>
          <option value={10}>Every 10 minutes</option>
          <option value={15}>Every 15 minutes</option>
          <option value={30}>Every 30 minutes</option>
          <option value={60}>Every hour</option>
          <option value={360}>Every 6 hours</option>
          <option value={1440}>Once a day</option>
        </select>
      </div>

      {error && <p className="type-footnote text-system-red">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSubmit}
          disabled={saving || !path.trim() || !label.trim()}
          className="dp-btn-primary flex-1"
        >
          {saving ? "Creating..." : "Create"}
        </button>
        <button
          onClick={() => setIsOpen(false)}
          className="type-subheadline text-accent hover:text-accent-hover transition-colors px-3 py-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
