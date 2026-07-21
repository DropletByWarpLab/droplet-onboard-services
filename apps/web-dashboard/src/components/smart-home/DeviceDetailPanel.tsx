"use client";

import { useId, useState } from "react";
import { X, Pencil, Check, Trash2, RefreshCw } from "lucide-react";
import type { MatterDevice, Room } from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ToggleSwitch } from "./ToggleSwitch";
import { BrightnessSlider } from "./BrightnessSlider";
import { ClimateControl } from "./ClimateControl";
import { SensorReading } from "./SensorReading";
import { ColorControls } from "./ColorControls";
import { CoverControls } from "./CoverControls";
import { FanControls } from "./FanControls";
import { LockControl } from "./LockControl";
import { MediaControls } from "./MediaControls";
import { CLUSTER, hasCluster } from "./clusters";
import { RoomAssignRow } from "./RoomAssignRow";
import { displayName } from "./rooms-model";
import { useToast } from "@/components/Toast";

interface DeviceDetailPanelProps {
  device: MatterDevice;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
  onClose: () => void;
  /** WARP-1396 — rooms + alias plumbing. Optional so existing callers/tests
   *  that only exercise controls keep working. */
  rooms?: Room[];
  onSetAlias?: (
    nodeId: string,
    patch: { name?: string | null; roomId?: string | null },
  ) => Promise<unknown>;
  onCreateRoom?: (name: string, icon: string) => Promise<Room>;
  /** Other devices' display names — for the §4.2 duplicate-name warning. */
  takenNames?: string[];
  /**
   * WARP-1469 — device lifecycle. All optional so control-only callers/tests
   * are unaffected; each action only renders when its handler is supplied.
   */
  /** Unpair the device from the Droplet (backend force-removes even offline). */
  onRemove?: (nodeId: string) => Promise<void>;
  /** Nudge an offline device to reconnect now (matter.js triggerReconnect). */
  onReconnect?: (nodeId: string) => Promise<unknown>;
  /** Remove the stale entry and route into the add-device flow to re-pair. */
  onRepair?: (nodeId: string) => Promise<void>;
}

// WARP-897: covers get real motion controls, not an onOff toggle a
// WindowCovering never implements.
const TOGGLEABLE = new Set(["light", "switch", "fan"]);

/**
 * Smart-home device detail side-panel.
 *
 * WARP-289: rebuilt on the shared `<Dialog placement="right">` primitive
 * — full role="dialog" + aria-modal + aria-labelledby + Escape close +
 * focus restore come from there.
 */
export function DeviceDetailPanel({
  device,
  onCommand,
  onClose,
  rooms,
  onSetAlias,
  onCreateRoom,
  takenNames = [],
  onRemove,
  onReconnect,
  onRepair,
}: DeviceDetailPanelProps) {
  const isOn = device.state === "on" || device.state === "playing";
  const isConnected = device.connectionState === "connected";
  const isToggleable = TOGGLEABLE.has(device.category);
  const brightness = device.attributes.currentLevel as number | undefined;
  const brightnessPct = brightness != null ? Math.round((brightness / 254) * 100) : undefined;

  const headingId = useId();

  // WARP-1396 — rename flow. The visible title is the friendly alias, then the
  // product name; editing writes the alias (never the Matter nodeLabel).
  const shown = displayName(device);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(shown);
  const [renameError, setRenameError] = useState<string | null>(null);
  const canRename = !!onSetAlias;
  const { toast } = useToast();

  const trimmedDraft = nameDraft.trim();
  const tooLong = trimmedDraft.length > 32;
  // §4.2: duplicate names are allowed but warned (never blocked).
  const isDuplicate =
    trimmedDraft.length > 0 &&
    trimmedDraft.toLowerCase() !== shown.toLowerCase() &&
    takenNames.some((n) => n.toLowerCase() === trimmedDraft.toLowerCase());

  async function saveName() {
    if (!onSetAlias || tooLong) return;
    const next = trimmedDraft;
    setRenameError(null);
    try {
      // Empty → clear the alias (revert to the product name).
      await onSetAlias(device.nodeId, { name: next.length ? next : null });
      setEditing(false);
      toast(next.length ? `Renamed to ${next}` : "Name cleared");
    } catch {
      setRenameError("That didn’t save — your name is still here. Try again.");
    }
  }

  function cmd(command: string, data?: Record<string, unknown>) {
    onCommand(device.nodeId, command, data);
  }

  // WARP-1469 — lifecycle actions. `confirm` drives the destructive
  // Remove / Re-pair dialog (rendered as a SIBLING of the panel Dialog, not
  // nested, so the two focus traps never fight). `reconnecting` guards the
  // reconnect button; `reconnectTried` reveals the re-pair fallback once an
  // attempt hasn't brought the device back.
  const [confirm, setConfirm] = useState<null | "remove" | "repair">(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectTried, setReconnectTried] = useState(false);

  async function handleReconnect() {
    if (!onReconnect) return;
    setReconnecting(true);
    try {
      await onReconnect(device.nodeId);
      // The device list carries the real outcome via the SSE bridge + poll;
      // this just acknowledges the nudge and unlocks the re-pair fallback.
      toast("Trying to reconnect… this can take a moment.");
      setReconnectTried(true);
    } catch {
      toast("Couldn't start a reconnect. Please try again.");
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <>
    {/* `flush`: sectioned side panel — full-width dividers, sections own their
        padding (WARP-1153). */}
    <Dialog open onClose={onClose} labelledBy={headingId} placement="right" flush>
      {/* Header */}
      <div className="flex items-start justify-between p-5 gap-3" style={{ borderBottom: "1px solid var(--card-bd)" }}>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                aria-label="Device name"
                value={nameDraft}
                maxLength={32}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") {
                    setEditing(false);
                    setNameDraft(shown);
                  }
                }}
                className="type-title-3 flex-1 min-w-0 rounded-md px-2 py-0.5 bg-[var(--card-inner)]
                  text-[var(--text)] border border-[var(--card-bd)]
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              />
              <button
                type="button"
                aria-label="Save name"
                onClick={() => void saveName()}
                className="p-1.5 rounded-md text-[var(--brand)] hover:bg-[var(--hover)]
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                <Check size={18} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h2 id={headingId} className="type-title-3 truncate" style={{ color: "var(--text)" }}>
                {shown}
              </h2>
              {canRename && (
                <button
                  type="button"
                  aria-label="Rename device"
                  onClick={() => {
                    setNameDraft(shown);
                    setEditing(true);
                  }}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] flex-none
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  <Pencil size={15} />
                </button>
              )}
            </div>
          )}
          <p className="type-caption-1 capitalize" style={{ color: "var(--text-muted)" }}>
            {device.category.replace("_", " ")} &middot; {device.state}
          </p>
          {renameError && (
            <p role="status" className="type-footnote text-system-red mt-1">
              {renameError}
            </p>
          )}
          {editing && isDuplicate && !renameError && (
            <p role="status" className="type-footnote mt-1" style={{ color: "var(--color-system-orange, #ff9500)" }}>
              Another device is already called this — voice commands may ask you to pick.
            </p>
          )}
          {editing && (
            <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }}>
              This is also the name you’ll use when you ask Droplet out loud.
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:ring-[var(--brand)] flex-none"
        >
          <X size={20} />
        </button>
      </div>

      {/* WARP-1396 — room assignment */}
      {onSetAlias && rooms && (
        <RoomAssignRow
          device={device}
          rooms={rooms}
          onSetAlias={onSetAlias}
          onCreateRoom={onCreateRoom}
        />
      )}

      {/* Controls */}
      <div className="p-5 space-y-6">
        {/* Connection state — offline is a warning, not a saved-state.
            WARP-1469: give the user a way to act on it — force a reconnect,
            and (once that hasn't helped) re-pair from scratch. */}
        {!isConnected && (
          <div className="bg-system-orange/10 border border-system-orange/20 rounded-lg p-3 space-y-2.5">
            <div>
              <p className="type-subheadline font-semibold" style={{ color: "var(--text)" }}>
                This device is offline
              </p>
              <p className="type-caption-1 capitalize" style={{ color: "var(--text-muted)" }}>
                {device.connectionState}
              </p>
            </div>
            {(onReconnect || onRepair) && (
              <div className="flex flex-wrap items-center gap-2">
                {onReconnect && (
                  <button
                    type="button"
                    className="btn"
                    disabled={reconnecting}
                    onClick={() => void handleReconnect()}
                    aria-busy={reconnecting || undefined}
                  >
                    <RefreshCw
                      size={14}
                      className={reconnecting ? "animate-spin" : ""}
                      aria-hidden="true"
                    />
                    {reconnecting ? "Reconnecting…" : "Try to reconnect"}
                  </button>
                )}
                {reconnectTried && onRepair && (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setConfirm("repair")}
                  >
                    Re-pair&hellip;
                  </button>
                )}
              </div>
            )}
            {reconnectTried && (
              <p className="type-caption-2" style={{ color: "var(--text-muted)" }}>
                Still offline? It may be unplugged or out of range. If it was
                reset, re-pair it from scratch.
              </p>
            )}
          </div>
        )}

        {/* Toggle */}
        {isToggleable && isConnected && (
          <div className="flex items-center justify-between">
            <span className="type-subheadline" style={{ color: "var(--text)" }}>Power</span>
            <ToggleSwitch on={isOn} onToggle={() => cmd("toggle")} />
          </div>
        )}

        {/* Brightness */}
        {device.category === "light" && isConnected && brightnessPct != null && (
          <div>
            <span className="type-caption-1 mb-2 block" style={{ color: "var(--text-muted)" }}>
              Brightness
            </span>
            <BrightnessSlider
              brightness={brightnessPct}
              onBrightnessChange={(v) => cmd("set_brightness", { brightness: v })}
            />
          </div>
        )}

        {/* WARP-897: color for ColorControl-capable lights */}
        {device.category === "light" &&
          isConnected &&
          hasCluster(device, CLUSTER.COLOR_CONTROL) && (
            <div>
              <span className="type-caption-1 mb-2 block" style={{ color: "var(--text-muted)" }}>
                Color
              </span>
              <ColorControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} size="lg" />
            </div>
          )}

        {/* WARP-897: cover motion + position */}
        {device.category === "cover" && isConnected && (
          <CoverControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
        )}

        {/* WARP-897: fan speed + mode */}
        {device.category === "fan" &&
          isConnected &&
          hasCluster(device, CLUSTER.FAN_CONTROL) && (
            <FanControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
          )}

        {/* WARP-897: lock / unlock (Tier-2 confirm flows via the page) */}
        {device.category === "lock" && isConnected && (
          <LockControl device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
        )}

        {/* WARP-897: media playback */}
        {device.category === "media_player" && isConnected && (
          <MediaControls device={device} onCommand={(_nodeId, c, d) => cmd(c, d)} />
        )}

        {/* Climate */}
        {device.category === "climate" && isConnected && (
          <ClimateControl device={device} onCommand={cmd} />
        )}

        {/* Sensor */}
        {(device.category === "sensor" ||
          device.category === "binary_sensor") && isConnected && (
          <SensorReading device={device} />
        )}

        {/* Device info */}
        <div className="pt-4 space-y-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
          <div>
            <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>
              Node ID
            </span>
            <code
              className="type-caption-1 px-2 py-1 rounded"
              style={{ color: "var(--text-muted)", background: "var(--card-inner)" }}
            >
              {device.nodeId}
            </code>
          </div>
          {device.vendorName && (
            <div>
              <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>Vendor</span>
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>{device.vendorName}</span>
            </div>
          )}
          {device.productName && (
            <div>
              <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>Product</span>
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>{device.productName}</span>
            </div>
          )}
          {device.serialNumber && (
            <div>
              <span className="type-caption-1 block mb-1" style={{ color: "var(--text-muted)" }}>Serial</span>
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>{device.serialNumber}</span>
            </div>
          )}
        </div>

        {/* Attributes (collapsible) */}
        <details className="pt-2">
          <summary
            className="type-caption-1 cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            All Attributes
          </summary>
          <pre
            className="mt-2 type-caption-2 rounded-lg p-3 overflow-x-auto max-h-60"
            style={{ color: "var(--text-muted)", background: "var(--card-inner)" }}
          >
            {JSON.stringify(device.attributes, null, 2)}
          </pre>
        </details>

        {/* WARP-1469 — remove (decommission). Destructive, confirm-gated.
            Works even for an offline device: the backend force-removes it
            from the local fabric when the device can't be reached. */}
        {onRemove && (
          <div className="pt-4" style={{ borderTop: "1px solid var(--card-bd)" }}>
            <button
              type="button"
              className="btn danger w-full justify-center"
              onClick={() => setConfirm("remove")}
            >
              <Trash2 size={15} aria-hidden="true" />
              Remove device
            </button>
            <p
              className="type-caption-2 mt-1.5 text-center"
              style={{ color: "var(--text-muted)" }}
            >
              Unpairs this device from your Droplet. You can add it back later.
            </p>
          </div>
        )}
      </div>
      </Dialog>

      {/* WARP-1469 — destructive confirm rendered as a SIBLING of the panel
          Dialog (not nested) so the two focus traps don't fight, mirroring
          how the Devices page hangs its Tier-2 confirm beside this panel. */}
      {confirm === "remove" && onRemove && (
        <ConfirmDialog
          open
          title="Remove this device?"
          description={`This unpairs ${shown} from your Droplet and removes it from every room and routine. You can add it back later with its pairing code.`}
          confirmLabel="Remove device"
          variant="destructive"
          onConfirm={() => onRemove(device.nodeId)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "repair" && onRepair && (
        <ConfirmDialog
          open
          title="Re-pair this device?"
          description={`This removes ${shown} and takes you to the add-device screen so you can pair it again — use this if it was factory-reset or won’t come back online.`}
          confirmLabel="Remove & re-pair"
          variant="destructive"
          onConfirm={() => onRepair(device.nodeId)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
