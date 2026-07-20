"use client";

import { useState } from "react";
import { Plus, MoreHorizontal, Pencil, Trash2, Shapes, X } from "lucide-react";
import type { MatterDevice, Room } from "@/lib/types";
import { DeviceCard } from "./DeviceCard";
import { RoomGlyph } from "./RoomGlyph";
import { RoomModal } from "./RoomModal";
import { ToggleSwitch } from "./ToggleSwitch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { RoomLayout, RoomBucket } from "./rooms-model";
import { bulkLights, anyLightOn } from "./rooms-model";
import { usePopover, POPOVER_SHEET } from "./usePopover";

interface RoomActions {
  create: (name: string, icon: string) => Promise<unknown>;
  rename: (id: string, patch: { name?: string; icon?: string }) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
}

interface RoomSectionsProps {
  layout: RoomLayout;
  /** True when devices exist but no rooms do — shows the §5.3 nudge banner. */
  showNudge: boolean;
  onCommand: (nodeId: string, command: string, data?: Record<string, unknown>) => void;
  onDeviceClick: (device: MatterDevice) => void;
  /** Turn every reachable light/switch in the room on/off (Tier-1). */
  onBulkLights: (room: Room, devices: MatterDevice[], on: boolean) => void;
  actions: RoomActions;
}

function DeviceGrid({
  devices,
  onCommand,
  onDeviceClick,
}: {
  devices: MatterDevice[];
  onCommand: RoomSectionsProps["onCommand"];
  onDeviceClick: RoomSectionsProps["onDeviceClick"];
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {devices.map((device) => (
        <DeviceCard
          key={device.nodeId}
          device={device}
          onCommand={onCommand}
          onClick={() => onDeviceClick(device)}
        />
      ))}
    </div>
  );
}

function RoomHeader({
  bucket,
  onBulkLights,
  onRename,
  onChooseIcon,
  onDelete,
}: {
  bucket: RoomBucket;
  onBulkLights: RoomSectionsProps["onBulkLights"];
  onRename: () => void;
  onChooseIcon: () => void;
  onDelete: () => void;
}) {
  const { open: menuOpen, setOpen: setMenuOpen, close: closeMenu, triggerRef, panelRef, onKeyDown } = usePopover();
  const { room, devices } = bucket;
  const lights = bulkLights(devices);
  const headingId = `room-h-${room.id}`;

  return (
    <div className="flex items-center gap-3 mb-4">
      <span
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-none"
        style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
      >
        <RoomGlyph icon={room.icon} size={18} />
      </span>
      <h2 id={headingId} className="type-title-3 truncate" style={{ color: "var(--text)" }}>
        {room.name}
      </h2>
      <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
        &middot; {devices.length} {devices.length === 1 ? "device" : "devices"}
      </span>
      <span className="flex-1" />
      {lights.length > 0 && (
        <ToggleSwitch
          on={anyLightOn(devices)}
          ariaLabel={`All ${room.name} lights`}
          onToggle={() => onBulkLights(room, devices, !anyLightOn(devices))}
        />
      )}
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${room.name} options`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)]
            hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-[var(--brand)]"
        >
          <MoreHorizontal size={18} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={closeMenu} aria-hidden="true" />
            <div
              ref={panelRef}
              role="menu"
              onKeyDown={onKeyDown}
              className={`absolute right-0 top-9 z-20 min-w-[168px] py-1 rounded-lg shadow-lg ${POPOVER_SHEET}`}
              style={{ background: "var(--card)", border: "1px solid var(--card-bd)" }}
            >
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onRename();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 type-subheadline text-left
                  text-[var(--text)] hover:bg-[var(--hover)]"
              >
                <Pencil size={15} /> Rename room
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onChooseIcon();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 type-subheadline text-left
                  text-[var(--text)] hover:bg-[var(--hover)]"
              >
                <Shapes size={15} /> Choose icon
              </button>
              <div className="my-1 h-px" style={{ background: "var(--card-bd)" }} />
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 type-subheadline text-left
                  text-system-red hover:bg-system-red/10"
              >
                <Trash2 size={15} /> Delete room
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function RoomSections({
  layout,
  showNudge,
  onCommand,
  onDeviceClick,
  onBulkLights,
  actions,
}: RoomSectionsProps) {
  // null = closed; otherwise the room being edited (null = create) + which
  // face of the dialog to open — rename shows the name field, icon jumps
  // straight to the glyph picker.
  const [modal, setModal] = useState<
    { room: Room | null; mode: "create" | "rename" | "icon" } | null
  >(null);
  const [deleting, setDeleting] = useState<Room | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      {showNudge && !nudgeDismissed && (
        <div
          className="card flex items-start gap-3 p-4"
          style={{ background: "var(--brand-subtle)" }}
        >
          <div className="flex-1">
            <p className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
              Group devices into rooms
            </p>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              Rooms keep this page tidy — and let you say things like &ldquo;movie
              time in the living room.&rdquo;
            </p>
          </div>
          <button
            type="button"
            onClick={() => setModal({ room: null, mode: "create" })}
            className="flex-none flex items-center gap-1.5 type-subheadline px-3 py-2 rounded-lg
              bg-[var(--brand)] text-white hover:bg-[var(--brand-hover)]
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <Plus size={15} /> Create a room
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNudgeDismissed(true)}
            className="flex-none w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)]
              hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Add-room affordance when rooms already exist. */}
      {!showNudge && (
        <div className="flex justify-end -mb-4">
          <button
            type="button"
            onClick={() => setModal({ room: null, mode: "create" })}
            className="flex items-center gap-1.5 type-caption-1 px-2.5 py-1.5 rounded-lg
              text-[var(--text-muted)] hover:bg-[var(--hover)]
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            <Plus size={14} /> New room
          </button>
        </div>
      )}

      {layout.rooms.map((bucket) => (
        <section key={bucket.room.id} role="region" aria-labelledby={`room-h-${bucket.room.id}`}>
          <RoomHeader
            bucket={bucket}
            onBulkLights={onBulkLights}
            onRename={() => setModal({ room: bucket.room, mode: "rename" })}
            onChooseIcon={() => setModal({ room: bucket.room, mode: "icon" })}
            onDelete={() => setDeleting(bucket.room)}
          />
          {bucket.devices.length === 0 ? (
            <div
              className="card flex items-center justify-center text-center p-6 type-caption-1"
              style={{ color: "var(--text-muted)" }}
            >
              Nothing in here yet — assign a device from its detail panel.
            </div>
          ) : (
            <DeviceGrid
              devices={bucket.devices}
              onCommand={onCommand}
              onDeviceClick={onDeviceClick}
            />
          )}
        </section>
      ))}

      {layout.unassigned.length > 0 && (
        <section role="region" aria-label="No room yet">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="type-title-3" style={{ color: "var(--text)" }}>
              No room yet
            </h2>
            <span className="badge muted">{layout.unassigned.length}</span>
          </div>
          <DeviceGrid
            devices={layout.unassigned}
            onCommand={onCommand}
            onDeviceClick={onDeviceClick}
          />
        </section>
      )}

      {modal && (
        <RoomModal
          room={modal.room}
          mode={modal.mode}
          onSave={(name, icon) =>
            modal.room
              ? actions.rename(modal.room.id, { name, icon })
              : actions.create(name, icon)
          }
          onClose={() => setModal(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open
          title={`Delete ${deleting.name}?`}
          description={`Its ${deleting.deviceCount} devices keep working — they just move back to “No room yet”.`}
          confirmLabel="Delete room"
          onConfirm={async () => {
            await actions.remove(deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
