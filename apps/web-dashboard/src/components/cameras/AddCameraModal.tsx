"use client";

import { useState } from "react";
import { X, Plus, Loader2 } from "lucide-react";
import { addCameraManual } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";

interface AddCameraModalProps {
  onClose: () => void;
  onAdded: () => void;
}

export function AddCameraModal({ onClose, onAdded }: AddCameraModalProps) {
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  const urlValid = /^rtsps?:\/\/.+/.test(rtspUrl);
  const canSubmit = nameValid && urlValid && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setError(null);
    try {
      await addCameraManual(name, rtspUrl, manufacturer || undefined, model || undefined);
      onAdded();
      onClose();
    } catch (err) {
      setError(translateError(err, "camera"));
    } finally {
      setLoading(false);
    }
  }

  return (
    // WARP-1153: p-6 backdrop inset (matches the shared Dialog backdrop) so
    // the card never sits flush against the screen edge on phones.
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-[var(--color-surface-primary)] dp-material rounded-2xl shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-separator">
          <h2 className="type-title-3 text-label-primary">Add Camera</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-surface-secondary transition-colors"
          >
            <X size={20} className="text-label-secondary" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Camera name */}
          <div>
            <label className="type-footnote text-label-secondary font-medium block mb-1">
              Camera Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s/g, "_"))}
              placeholder="front_door"
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary text-label-primary type-subheadline border border-separator focus:border-accent focus:outline-none"
              maxLength={64}
            />
            {name && !nameValid && (
              <p className="type-caption-2 text-system-red mt-1">
                Letters, numbers, underscores, hyphens only
              </p>
            )}
          </div>

          {/* RTSP URL */}
          <div>
            <label className="type-footnote text-label-secondary font-medium block mb-1">
              RTSP URL *
            </label>
            <input
              type="text"
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              placeholder="rtsp://192.168.100.101:554/stream1"
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary text-label-primary type-subheadline border border-separator focus:border-accent focus:outline-none font-mono text-sm"
            />
            {rtspUrl && !urlValid && (
              <p className="type-caption-2 text-system-red mt-1">
                Must start with rtsp:// or rtsps://
              </p>
            )}
          </div>

          {/* Optional fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="type-footnote text-label-secondary font-medium block mb-1">
                Manufacturer
              </label>
              <input
                type="text"
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder="Reolink"
                className="w-full px-3 py-2 rounded-lg bg-surface-secondary text-label-primary type-subheadline border border-separator focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="type-footnote text-label-secondary font-medium block mb-1">
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="RLC-810A"
                className="w-full px-3 py-2 rounded-lg bg-surface-secondary text-label-primary type-subheadline border border-separator focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="type-footnote text-system-red bg-system-red/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="dp-btn-secondary flex-1 py-2.5 rounded-lg type-subheadline"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="dp-btn-primary flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg type-subheadline disabled:opacity-50"
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              Add Camera
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
