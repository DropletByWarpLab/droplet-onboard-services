"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import * as Icons from "lucide-react";
import type { EnrichedNetworkDevice, DevicePresenceDay } from "@/lib/types";
import { DeviceSparkline } from "./DeviceSparkline";
import { IconPicker, type DeviceIconName } from "./IconPicker";
import { useDeviceMutations } from "@/lib/hooks/useDeviceMutations";
import { useDeviceBlockMutation } from "@/lib/hooks/useDeviceBlockMutation";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

interface Props {
  mac: string;
  onClose: () => void;
}

export function DeviceDetailPanel({ mac, onClose }: Props) {
  const { data, error } = useSWR<{ device: EnrichedNetworkDevice; presence: DevicePresenceDay[] }>(
    mac ? `/api/network/devices/${encodeURIComponent(mac)}` : null,
    fetcher,
    { refreshInterval: 10_000 },
  );
  const { patchDevice, forgetDevice, assignGroups, toastForError } = useDeviceMutations();
  const { toggleBlock } = useDeviceBlockMutation();
  const [blockPending, setBlockPending] = useState(false);

  const [displayName, setDisplayName] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [icon, setIcon] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const nameDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Seed local edit state whenever the device identity changes.
  useEffect(() => {
    if (data?.device) {
      setDisplayName(data.device.displayName ?? "");
      setNotes(data.device.notes ?? "");
      setIcon(data.device.icon);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.device?.mac]);

  // ESC to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Minimal focus management: pull focus into the dialog on mount.
  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>(
      "input, textarea, button",
    );
    first?.focus();
  }, []);

  async function save(field: "displayName" | "icon" | "notes", value: string | null) {
    // Snapshot server-truth (pre-edit) so rollback on error restores the
    // real original, not the in-flight optimistic local value.
    const serverValue = data?.device
      ? field === "displayName"
        ? (data.device.displayName ?? null)
        : field === "notes"
          ? (data.device.notes ?? null)
          : data.device.icon
      : null;
    try {
      await patchDevice(mac, { [field]: value } as Partial<
        Pick<EnrichedNetworkDevice, "displayName" | "icon" | "notes">
      >);
    } catch (err) {
      if (field === "displayName") setDisplayName(String(serverValue ?? ""));
      if (field === "notes") setNotes(String(serverValue ?? ""));
      if (field === "icon") setIcon(serverValue as string | null);
      setToast(toastForError(err));
    }
  }

  function scheduleSave(field: "displayName" | "notes", value: string) {
    const ref = field === "displayName" ? nameDebounce : notesDebounce;
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => void save(field, value), 500);
  }

  async function handleIconSelect(next: DeviceIconName) {
    setIcon(next);
    setPickerOpen(false);
    await save("icon", next);
  }

  async function handleRemoveGroup(groupId: string) {
    const remaining = (data?.device.groups ?? [])
      .filter((g) => g.id !== groupId)
      .map((g) => g.id);
    try {
      await assignGroups(mac, remaining);
    } catch (err) {
      setToast(toastForError(err));
    }
  }

  async function handleBlockToggle() {
    if (!data?.device) return;
    // TODO(WARP-41): run tier-2 token-bound confirm here before hitting the
    // firewall endpoint. The hook doesn't exist on this branch yet.
    setBlockPending(true);
    try {
      await toggleBlock(data.device);
    } catch (err) {
      setToast(toastForError(err));
    } finally {
      setBlockPending(false);
    }
  }

  async function handleForget() {
    try {
      await forgetDevice(mac);
      onClose();
    } catch (err) {
      setToast(toastForError(err));
      setConfirmForget(false);
    }
  }

  const seenDays = (data?.presence ?? []).filter((p) => p.seenMinutes > 0).length;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Device details"
      className="fixed top-0 right-0 h-full w-[440px] bg-surface-primary border-l border-separator shadow-xl overflow-y-auto z-40"
    >
      <div className="p-4 flex items-center justify-between">
        <input
          className="type-headline text-label-primary bg-transparent border-0 focus:outline-none focus:ring-2 focus:ring-accent rounded px-1 flex-1 min-w-0"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            scheduleSave("displayName", e.target.value);
          }}
          onBlur={() => {
            if (nameDebounce.current) {
              clearTimeout(nameDebounce.current);
              nameDebounce.current = null;
            }
            void save("displayName", displayName);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder={data?.device.hostname ?? data?.device.vendor ?? "Device"}
          aria-label="Display name"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-2 p-1 text-label-secondary hover:text-label-primary"
        >
          <Icons.X className="w-5 h-5" />
        </button>
      </div>

      {/* Icon picker toggle */}
      <div className="px-4 pb-2">
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          className="type-footnote text-label-secondary hover:text-label-primary"
        >
          Change icon
        </button>
        {pickerOpen && (
          <div className="mt-2">
            <IconPicker value={icon} onSelect={handleIconSelect} />
          </div>
        )}
      </div>

      {/* Groups */}
      <div className="px-4 py-3 border-t border-separator">
        <p className="type-footnote text-label-tertiary mb-2">Groups</p>
        <div className="flex flex-wrap gap-1.5">
          {(data?.device.groups ?? []).map((g) => (
            <span
              key={g.id}
              className="type-caption-1 px-2 py-0.5 rounded-full bg-surface-secondary text-label-secondary inline-flex items-center gap-1.5"
            >
              {g.color && (
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: g.color }}
                  aria-hidden="true"
                />
              )}
              {g.name}
              <button
                type="button"
                onClick={() => void handleRemoveGroup(g.id)}
                aria-label={`Remove from ${g.name}`}
                className="text-label-tertiary hover:text-label-primary"
              >
                <Icons.X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <span className="type-caption-1 px-2 py-0.5 rounded-full border border-dashed border-separator text-label-tertiary">
            + Add to group (WARP-85)
          </span>
        </div>
      </div>

      {/* Notes */}
      <div className="px-4 py-3 border-t border-separator">
        <label className="type-footnote text-label-tertiary block mb-2">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            scheduleSave("notes", e.target.value);
          }}
          onBlur={() => {
            if (notesDebounce.current) {
              clearTimeout(notesDebounce.current);
              notesDebounce.current = null;
            }
            void save("notes", notes);
          }}
          rows={3}
          className="w-full bg-surface-secondary border border-separator rounded p-2 type-body text-label-primary"
          placeholder="Add a note..."
          aria-label="Notes"
        />
      </div>

      {/* 30-day activity */}
      <div className="px-4 py-3 border-t border-separator">
        <p className="type-footnote text-label-tertiary mb-2">30-day activity</p>
        <DeviceSparkline days={data?.presence ?? []} size="lg" />
        <p className="type-caption-1 text-label-secondary mt-2">Seen {seenDays}/30 days</p>
      </div>

      {/* Advanced */}
      <div className="px-4 py-3 border-t border-separator">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="type-footnote text-label-secondary"
        >
          {advancedOpen ? "Hide advanced" : "Show advanced"}
        </button>
        {advancedOpen && data?.device && (
          <dl className="mt-2 text-sm space-y-1">
            <div className="flex justify-between">
              <dt className="text-label-tertiary">MAC</dt>
              <dd className="font-mono text-label-secondary">{data.device.mac}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-label-tertiary">Vendor</dt>
              <dd className="text-label-secondary">{data.device.vendor ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-label-tertiary">First seen</dt>
              <dd className="text-label-secondary">
                {new Date(data.device.firstSeen).toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-label-tertiary">Last seen</dt>
              <dd className="text-label-secondary">
                {new Date(data.device.lastSeen).toLocaleString()}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-separator flex gap-2">
        <button
          type="button"
          onClick={() => void handleBlockToggle()}
          disabled={blockPending || !data?.device}
          className={`type-footnote px-3 py-1.5 rounded ${data?.device.isBlocked ? "bg-system-green/10 text-system-green" : "bg-system-red/10 text-system-red"}`}
        >
          {blockPending ? "..." : data?.device.isBlocked ? "Unblock" : "Block"}
        </button>
        {!confirmForget ? (
          <button
            type="button"
            onClick={() => setConfirmForget(true)}
            className="type-footnote px-3 py-1.5 rounded text-system-red hover:bg-system-red/10"
          >
            Forget device
          </button>
        ) : (
          <div className="flex gap-2">
            <span className="type-footnote text-label-secondary self-center">
              Forget this device?
            </span>
            <button
              type="button"
              onClick={() => void handleForget()}
              className="type-footnote px-3 py-1.5 rounded bg-system-red text-white"
            >
              Yes, forget
            </button>
            <button
              type="button"
              onClick={() => setConfirmForget(false)}
              className="type-footnote px-3 py-1.5 rounded bg-surface-secondary text-label-primary"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {error && <p className="px-4 py-2 text-system-red">Failed to load device</p>}
      {toast && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 bg-system-red text-white px-3 py-2 rounded shadow"
        >
          {toast}
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss toast"
            className="ml-2"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
