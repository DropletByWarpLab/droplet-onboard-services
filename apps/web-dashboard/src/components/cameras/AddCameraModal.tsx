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
      <div
        className="absolute inset-0 backdrop-blur-sm"
        style={{ background: "var(--scrim)" }}
        onClick={onClose}
      />

      {/* Modal */}
      <div className="card relative w-full max-w-md" style={{ padding: 0 }}>
        {/* Header */}
        <div
          className="flex items-center justify-between p-4"
          style={{ borderBottom: "1px solid var(--card-bd)" }}
        >
          <h2 className="type-title-3" style={{ color: "var(--text)" }}>
            Add Camera
          </h2>
          <button onClick={onClose} className="icon-btn">
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Camera name */}
          <div>
            <label
              className="type-footnote font-medium block mb-1"
              style={{ color: "var(--text-muted)" }}
            >
              Camera Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s/g, "_"))}
              placeholder="front_door"
              className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              maxLength={64}
            />
            {name && !nameValid && (
              <p className="type-caption-2 mt-1" style={{ color: "var(--danger)" }}>
                Letters, numbers, underscores, hyphens only
              </p>
            )}
          </div>

          {/* RTSP URL */}
          <div>
            <label
              className="type-footnote font-medium block mb-1"
              style={{ color: "var(--text-muted)" }}
            >
              RTSP URL *
            </label>
            <input
              type="text"
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              placeholder="rtsp://192.168.100.101:554/stream1"
              className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)] font-mono text-sm"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
            {rtspUrl && !urlValid && (
              <p className="type-caption-2 mt-1" style={{ color: "var(--danger)" }}>
                Must start with rtsp:// or rtsps://
              </p>
            )}
          </div>

          {/* Optional fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                className="type-footnote font-medium block mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Manufacturer
              </label>
              <input
                type="text"
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder="Reolink"
                className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
              />
            </div>
            <div>
              <label
                className="type-footnote font-medium block mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="RLC-810A"
                className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <p
              className="type-footnote rounded-lg px-3 py-2"
              style={{ color: "var(--danger)", background: "rgba(239,68,68,0.1)" }}
            >
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn ghost flex-1 type-subheadline"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="btn primary flex-1 type-subheadline disabled:opacity-50"
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
