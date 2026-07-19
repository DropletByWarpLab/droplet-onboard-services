"use client";

import { useId, useState } from "react";
import { X, Pencil, Check } from "lucide-react";
import type { MatterDevice, Room } from "@/lib/types";
import { Dialog } from "@/components/Dialog";
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

  async function saveName() {
    if (!onSetAlias) return;
    const next = nameDraft.trim();
    setRenameError(null);
    try {
      // Empty → clear the alias (revert to the product name).
      await onSetAlias(device.nodeId, { name: next.length ? next : null });
      setEditing(false);
    } catch {
      setRenameError("That didn’t save — your name is still here. Try again.");
    }
  }

  function cmd(command: string, data?: Record<string, unknown>) {
    onCommand(device.nodeId, command, data);
  }

  return (
    // `flush`: sectioned side panel — full-width dividers, sections own their
    // padding (WARP-1153).
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
                maxLength={64}
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
            <p role="alert" className="type-footnote text-system-red mt-1">
              {renameError}
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
        {/* Connection state — offline is a warning, not a saved-state */}
        {!isConnected && (
          <div className="bg-system-orange/10 border border-system-orange/20 rounded-lg p-3">
            <p className="type-caption-1 capitalize" style={{ color: "var(--text-muted)" }}>
              {device.connectionState}
            </p>
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
      </div>
    </Dialog>
  );
}
