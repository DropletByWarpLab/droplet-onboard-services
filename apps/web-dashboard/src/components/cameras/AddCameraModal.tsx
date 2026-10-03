"use client";

import { useEffect, useState } from "react";
import { X, Plus, Loader2, Radar, Check, Video, KeyRound } from "lucide-react";
import { addCameraManual, addDiscoveredCameraWithCredentials } from "@/lib/api";
import { exampleStreamUrl, streamPathFor } from "@/lib/camera-stream-hints";
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
   * A camera we found but can't stream — its name and address are known, only
   * the credentials (and sometimes the path) are missing. A live record opens
   * the username/password form; anything else opens the manual form prefilled.
   */
  prefill?: DiscoveredCamera | null;
}

/**
 * WARP-3505 — a found camera whose stream needs a sign-in AND that
 * camera-discovery still holds a live record for can be added by typing its
 * username and password: discovery re-probes with them. A database-only row has
 * no probed stream to verify against, so it keeps the manual form.
 */
function acceptsCredentials(camera: DiscoveredCamera | null | undefined): camera is DiscoveredCamera {
  return !!camera && camera.id.startsWith("mac:") && camera.status === "needs_credentials";
}

/**
 * rtsp://host:554/path skeleton for a camera we know the address of.
 *
 * A `rtsp_port_open` URL is the prober's placeholder GUESS (`…/stream1`), not a
 * stream anything answered — wrong for the cameras that most need help (a
 * Hanwha 400s it) — so it is replaced with the manufacturer's known path, or a
 * bare address when we don't have one.
 */
function suggestRtspUrl(camera: DiscoveredCamera): string {
  if (camera.rtspUrl && camera.detectionMethod !== "rtsp_port_open") return camera.rtspUrl;
  if (!camera.ip) return "";
  return `rtsp://${camera.ip}:554${streamPathFor(camera.manufacturer) ?? "/"}`;
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
  // WARP-3505: optional camera account for the manual form, and the required
  // one for the discovered-camera form. Kept apart from the URL so the server
  // merges and encodes them — the password is never part of a visible address.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The camera the open form was started from — drives the "we found …" copy
  // and which camera the credentials are submitted for.
  const [found, setFound] = useState<DiscoveredCamera | null>(prefill);
  // Open on the list when there's something to pick and we weren't sent here to
  // finish a specific camera's setup.
  const [tab, setTab] = useState<"discovered" | "manual" | "credentials">(
    prefill
      ? acceptsCredentials(prefill)
        ? "credentials"
        : "manual"
      : cameras.length > 0
        ? "discovered"
        : "manual",
  );

  function openManualFor(cam: DiscoveredCamera) {
    setFound(cam);
    setName(cam.name);
    setRtspUrl(suggestRtspUrl(cam));
    setManufacturer(cam.manufacturer ?? "");
    setModel(cam.model ?? "");
    setError(null);
    setTab("manual");
  }

  function openCredentialsFor(cam: DiscoveredCamera) {
    setFound(cam);
    setUsername("");
    setPassword("");
    setError(null);
    setTab("credentials");
  }

  // The modal stays mounted while the caller switches which camera is being set
  // up (Set up on a second row), so follow the prefill.
  useEffect(() => {
    if (!prefill) return;
    if (acceptsCredentials(prefill)) openCredentialsFor(prefill);
    else openManualFor(prefill);
  }, [prefill]);

  const nameValid = /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  const urlValid = /^rtsps?:\/\/.+/.test(rtspUrl);
  // A password only makes sense with a username; the server refuses one without.
  const manualCredsValid = !password || !!username.trim();
  const canSubmit = nameValid && urlValid && manualCredsValid && !loading;
  const canSubmitCredentials = !!username.trim() && !!password && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setError(null);
    try {
      await addCameraManual(
        name,
        rtspUrl,
        manufacturer || undefined,
        model || undefined,
        username.trim() || undefined,
        password || undefined,
      );
      onAdded();
      onClose();
    } catch (err) {
      setError(translateError(err, "camera"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCredentialsSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!found || !canSubmitCredentials) return;

    setLoading(true);
    setError(null);
    try {
      await addDiscoveredCameraWithCredentials(found.id, username.trim(), password);
      onAdded();
      onClose();
    } catch (err) {
      // translateError maps the API's AUTH_FAILED / LOCKED / NO_STREAM_PATH /
      // UNREACHABLE codes to their own copy. The fields are kept so a typo can
      // be corrected without retyping everything.
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

  const alertBox = error && (
    <p
      className="type-footnote rounded-lg px-3 py-2"
      style={{ color: "var(--danger)", background: "rgba(239,68,68,0.1)" }}
      role="alert"
    >
      {error}
    </p>
  );

  // Example for the hint + placeholder: the manufacturer's real path, never a
  // guessed /stream1 (WARP-3505).
  const knownPath = streamPathFor(manufacturer);
  const example = exampleStreamUrl(manufacturer, found?.ip);

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
              className={"chip" + (tab === "discovered" || tab === "credentials" ? " on" : "")}
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
                          onClick={() =>
                            acceptsCredentials(cam) ? openCredentialsFor(cam) : openManualFor(cam)
                          }
                        >
                          Set up
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {alertBox}
            </div>
          ) : tab === "credentials" && found ? (
            <form onSubmit={handleCredentialsSubmit} className="p-4 space-y-4">
              <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                We found{" "}
                <strong style={{ color: "var(--text)" }}>
                  {found.displayName || found.name.replace(/_/g, " ")}
                </strong>{" "}
                at <strong style={{ color: "var(--text)" }}>{found.ip}</strong>
                {found.manufacturer ? ` (${found.manufacturer})` : ""} but it needs a sign-in
                before we can watch it. Enter the username and password you set on the camera —
                we'll use them to find its video.
              </p>

              <div>
                <label
                  className="type-footnote font-medium block mb-1"
                  style={{ color: "var(--text-muted)" }}
                  htmlFor="camera-cred-username"
                >
                  Username *
                </label>
                <input
                  id="camera-cred-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={128}
                  className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
                  style={inputStyle}
                />
              </div>

              <div>
                <label
                  className="type-footnote font-medium block mb-1"
                  style={{ color: "var(--text-muted)" }}
                  htmlFor="camera-cred-password"
                >
                  Password *
                </label>
                <input
                  id="camera-cred-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  maxLength={256}
                  className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
                  style={inputStyle}
                />
              </div>

              {alertBox}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => (cameras.length > 0 ? setTab("discovered") : onClose())}
                  className="btn ghost flex-1 type-subheadline"
                >
                  {cameras.length > 0 ? "Back" : "Cancel"}
                </button>
                <button
                  type="submit"
                  disabled={!canSubmitCredentials}
                  className="btn primary flex-1 type-subheadline disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <KeyRound size={16} />
                  )}
                  {loading ? "Checking…" : "Add camera"}
                </button>
              </div>

              <button
                type="button"
                className="type-caption-1 underline"
                style={{ color: "var(--text-muted)", background: "none", border: 0, padding: 0 }}
                onClick={() => openManualFor(found)}
              >
                Enter the stream address instead
              </button>
            </form>
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

              {found && (
                <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  We found <strong style={{ color: "var(--text)" }}>{found.ip}</strong> but
                  couldn't open its video. Enter its stream address below
                  {knownPath ? (
                    <>
                      {" "}— {manufacturer} cameras usually look like{" "}
                      <code style={{ fontFamily: "var(--font-mono)" }}>{example}</code>
                    </>
                  ) : null}
                  . Your camera's manual lists its exact stream path. If it asks for a sign-in,
                  add the username and password in the fields below — we'll add them to the
                  address for you.
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
                  className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
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
                  placeholder={example}
                  className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)] font-mono text-sm"
                  style={inputStyle}
                />
                {rtspUrl && !urlValid && (
                  <p className="type-caption-2 mt-1" style={{ color: "var(--danger)" }}>
                    Must start with rtsp:// or rtsps://
                  </p>
                )}
              </div>

              {/* Camera account (optional) — merged into the address server-side */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className="type-footnote font-medium block mb-1"
                    style={{ color: "var(--text-muted)" }}
                    htmlFor="camera-username"
                  >
                    Username
                  </label>
                  <input
                    id="camera-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={128}
                    className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label
                    className="type-footnote font-medium block mb-1"
                    style={{ color: "var(--text-muted)" }}
                    htmlFor="camera-password"
                  >
                    Password
                  </label>
                  <input
                    id="camera-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    maxLength={256}
                    className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
                    style={inputStyle}
                  />
                </div>
              </div>
              <p className="type-caption-2" style={{ color: "var(--text-muted)", marginTop: -8 }}>
                Optional. Only needed if the camera asks for a sign-in and the address above
                doesn't already include one.
              </p>
              {password && !username.trim() && (
                <p className="type-caption-2" style={{ color: "var(--danger)", marginTop: -8 }}>
                  Enter the username that goes with this password
                </p>
              )}

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
                    className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
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
                    className="w-full px-3 py-2 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
                    style={inputStyle}
                  />
                </div>
              </div>

              {/* Error */}
              {alertBox}

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
