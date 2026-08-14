"use client";

import { useEffect, useState } from "react";
import { X, Plus, Loader2, Radar, Check, Video } from "lucide-react";
import { addCameraManual } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import type { DiscoveredCamera } from "@/lib/types";

interface AddCameraModalProps {
  onClose: () => void;
  onAdded: () => void;
  /**
   * WARP-1847 — what a discovery sweep found. "Add camera" used to open
   * straight onto an empty RTSP form, which asked the operator for an address
   * and stream path the appliance already knew. When there are candidates, the
   * list is the first thing they see.
   */
  cameras?: DiscoveredCamera[];
  discoveryOnline?: boolean;
  scanning?: boolean;
  onScan?: () => void;
  onAccept?: (camera: DiscoveredCamera) => Promise<void> | void;
  /**
   * Prefill the manual form from a camera we found but can't stream — its
   * name and address are known, only the credentials and path are missing.
   */
  prefill?: DiscoveredCamera | null;
}

/** rtsp://user:pass@host:554/path skeleton for a camera we know the address of. */
function suggestRtspUrl(camera: DiscoveredCamera): string {
  if (camera.rtspUrl) return camera.rtspUrl;
  return camera.ip ? `rtsp://${camera.ip}:554/` : "";
}

export function AddCameraModal({
  onClose,
  onAdded,
  cameras = [],
  discoveryOnline = true,
  scanning = false,
  onScan,
  onAccept,
  prefill = null,
}: AddCameraModalProps) {
  const [name, setName] = useState(prefill?.name ?? "");
  const [rtspUrl, setRtspUrl] = useState(prefill ? suggestRtspUrl(prefill) : "");
  const [manufacturer, setManufacturer] = useState(prefill?.manufacturer ?? "");
  const [model, setModel] = useState(prefill?.model ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Open on the list when there's something to pick and we weren't sent here to
  // finish a specific camera's setup.
  const [tab, setTab] = useState<"discovered" | "manual">(
    !prefill && cameras.length > 0 ? "discovered" : "manual",
  );

  // The modal stays mounted while the caller switches which camera is being set
  // up (Set up on a second row), so follow the prefill.
  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name);
    setRtspUrl(suggestRtspUrl(prefill));
    setManufacturer(prefill.manufacturer ?? "");
    setModel(prefill.model ?? "");
    setTab("manual");
  }, [prefill]);

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

  async function handleAccept(camera: DiscoveredCamera) {
    if (!onAccept) return;
    setBusyId(camera.id);
    setError(null);
    try {
      await onAccept(camera);
      onClose();
    } catch (err) {
      setError(translateError(err, "camera"));
    } finally {
      setBusyId(null);
    }
  }

  const inputStyle = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-input)",
    color: "var(--text)",
  } as const;

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
      <div
        className="card relative w-full max-w-md"
        style={{ padding: 0, maxHeight: "86vh", display: "flex", flexDirection: "column" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between p-4"
          style={{ borderBottom: "1px solid var(--card-bd)" }}
        >
          <h2 className="type-title-3" style={{ color: "var(--text)" }}>
            Add camera
          </h2>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Tabs — only worth showing when picking from the network is an option */}
        {cameras.length > 0 && (
          <div className="chiprow px-4 pt-3">
            <button
              type="button"
              onClick={() => setTab("discovered")}
              className={"chip" + (tab === "discovered" ? " on" : "")}
              aria-current={tab === "discovered" ? "true" : undefined}
            >
              <Radar size={14} />
              <span>On your network ({cameras.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setTab("manual")}
              className={"chip" + (tab === "manual" ? " on" : "")}
              aria-current={tab === "manual" ? "true" : undefined}
            >
              <Plus size={14} />
              <span>Enter details</span>
            </button>
          </div>
        )}

        <div style={{ overflowY: "auto" }}>
          {tab === "discovered" ? (
            <div className="p-4 space-y-2">
              <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                Cameras we can see on your network. Pick one to add it.
              </p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="space-y-2">
                {cameras.map((cam) => {
                  const ready = (cam.status ?? "unverified") === "ready";
                  const busy = busyId === cam.id;
                  return (
                    <li
                      key={cam.id}
                      className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Video size={15} style={{ color: "var(--brand)", flexShrink: 0 }} />
                        <div className="min-w-0">
                          <p
                            className="type-footnote font-medium truncate"
                            style={{ color: "var(--text)" }}
                          >
                            {cam.displayName || cam.name.replace(/_/g, " ")}
                          </p>
                          <p className="type-caption-2 truncate" style={{ color: "var(--text-muted)" }}>
                            {[cam.ip, cam.manufacturer].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                      </div>
                      {ready ? (
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={busy || !onAccept}
                          onClick={() => handleAccept(cam)}
                        >
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                          Add
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            setName(cam.name);
                            setRtspUrl(suggestRtspUrl(cam));
                            setManufacturer(cam.manufacturer ?? "");
                            setModel(cam.model ?? "");
                            setTab("manual");
                          }}
                        >
                          Set up
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {error && (
                <p
                  className="type-footnote rounded-lg px-3 py-2"
                  style={{ color: "var(--danger)", background: "rgba(239,68,68,0.1)" }}
                  role="alert"
                >
                  {error}
                </p>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {cameras.length === 0 && onScan && (
                // No candidates: offer the sweep here too, so the operator isn't
                // forced to guess an RTSP URL just because they opened this modal.
                <div
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                  style={{ background: "var(--brand-subtle)" }}
                >
                  <span className="type-caption-1" style={{ color: "var(--text)" }}>
                    {discoveryOnline
                      ? "Don't know the details? Look for cameras on your network."
                      : "Camera discovery isn't running, so we can't look for cameras automatically."}
                  </span>
                  {discoveryOnline && (
                    <button type="button" className="btn sm" onClick={onScan} disabled={scanning}>
                      {scanning ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Radar size={14} />
                      )}
                      Scan
                    </button>
                  )}
                </div>
              )}

              {prefill && (
                <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  We found <strong style={{ color: "var(--text)" }}>{prefill.ip}</strong> but
                  couldn't open its video. Add the camera account's username and password to the
                  address below — most cameras look like
                  {" "}
                  <code style={{ fontFamily: "var(--font-mono)" }}>
                    rtsp://user:password@{prefill.ip}:554/stream1
                  </code>
                  . Your camera's manual lists its exact stream path.
                </p>
              )}

              {/* Camera name */}
              <div>
                <label
                  className="type-footnote font-medium block mb-1"
                  style={{ color: "var(--text-muted)" }}
                  htmlFor="camera-name"
                >
                  Camera name *
                </label>
                <input
                  id="camera-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.replace(/\s/g, "_"))}
                  placeholder="front_door"
                  className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)]"
                  style={inputStyle}
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
                  htmlFor="camera-rtsp"
                >
                  Stream address (RTSP) *
                </label>
                <input
                  id="camera-rtsp"
                  type="text"
                  value={rtspUrl}
                  onChange={(e) => setRtspUrl(e.target.value)}
                  placeholder="rtsp://192.168.100.101:554/stream1"
                  className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)] font-mono text-sm"
                  style={inputStyle}
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
                    htmlFor="camera-manufacturer"
                  >
                    Manufacturer
                  </label>
                  <input
                    id="camera-manufacturer"
                    type="text"
                    value={manufacturer}
                    onChange={(e) => setManufacturer(e.target.value)}
                    placeholder="Reolink"
                    className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)]"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label
                    className="type-footnote font-medium block mb-1"
                    style={{ color: "var(--text-muted)" }}
                    htmlFor="camera-model"
                  >
                    Model
                  </label>
                  <input
                    id="camera-model"
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="RLC-810A"
                    className="w-full px-3 py-2 type-subheadline outline-none focus:border-[var(--brand)]"
                    style={inputStyle}
                  />
                </div>
              </div>

              {/* Error */}
              {error && (
                <p
                  className="type-footnote rounded-lg px-3 py-2"
                  style={{ color: "var(--danger)", background: "rgba(239,68,68,0.1)" }}
                  role="alert"
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
                  Add camera
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
