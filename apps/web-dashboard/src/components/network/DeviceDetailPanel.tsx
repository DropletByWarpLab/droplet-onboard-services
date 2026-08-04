"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import * as Icons from "lucide-react";
import type {
  EnrichedNetworkDevice,
  DevicePresenceDay,
  Schedule,
  ScheduleOverride,
} from "@/lib/types";
import { DeviceSparkline } from "./DeviceSparkline";
import { IconPicker, type DeviceIconName } from "./IconPicker";
import { GroupTypeahead } from "./GroupTypeahead";
import { useDeviceMutations } from "@/lib/hooks/useDeviceMutations";
import { translateError } from "@/lib/friendly-errors";
import { useDeviceBlockMutation } from "@/lib/hooks/useDeviceBlockMutation";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { useActiveOverrides } from "@/lib/hooks/useActiveOverrides";
import { useOverrideMutations } from "@/lib/hooks/useOverrideMutations";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { isWindowActive, nextTransitionFor } from "@/lib/scheduleEval";
import { OverrideModal } from "./OverrideModal";
import { ScheduleEditorModal } from "./ScheduleEditorModal";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { authFetch } from "@/lib/auth";

const fetcher = async (url: string) => {
  const r = await authFetch(url);
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
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);
  const blockTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [displayName, setDisplayName] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [icon, setIcon] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const nameDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingId = useId();

  // Seed local edit state whenever the device identity changes.
  useEffect(() => {
    if (data?.device) {
      setDisplayName(data.device.displayName ?? "");
      setNotes(data.device.notes ?? "");
      setIcon(data.device.icon);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.device?.mac]);

  // ESC close + initial focus are handled by the shared <Dialog>
  // primitive that wraps this panel — see WARP-289.

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

  async function handleBlockConfirm() {
    if (!data?.device) return;
    try {
      await toggleBlock(data.device);
    } catch (err) {
      setToast(toastForError(err));
      // Re-throw so ConfirmDialog stays open and the user can retry.
      throw err;
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
    // `flush`: sectioned side panel — full-width dividers, sections own their
    // padding (WARP-1153).
    <Dialog open onClose={onClose} labelledBy={headingId} placement="right" flush>
      {/*
        Off-screen heading provides the aria-labelledby target. The
        visible "title" is the editable display-name input, which
        carries its own aria-label="Display name" and would conflict
        with using it as the dialog name.
      */}
      <h2 id={headingId} className="sr-only">
        Device details
      </h2>
      <div className="p-4 flex items-center justify-between">
        <input
          className="type-headline text-[color:var(--text)] bg-transparent border-0 focus:outline-none focus:ring-2 focus:ring-[var(--brand)] rounded px-1 flex-1 min-w-0"
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
          className="ml-2 p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
        >
          <Icons.X className="w-5 h-5" />
        </button>
      </div>

      {/* Icon picker toggle */}
      <div className="px-4 pb-2">
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          className="type-footnote text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
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
      <div className="px-4 py-3 border-t border-[var(--card-bd)]">
        <p className="type-footnote text-[color:var(--text-muted)] mb-2">Groups</p>
        <div className="flex flex-wrap gap-1.5">
          {(data?.device.groups ?? []).map((g) => (
            <span
              key={g.id}
              className="type-caption-1 px-2 py-0.5 rounded-full bg-[var(--card-inner)] text-[color:var(--text-muted)] inline-flex items-center gap-1.5"
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
                className="text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
              >
                <Icons.X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <GroupTypeahead
            mac={mac}
            currentGroups={data?.device.groups ?? []}
            onError={setToast}
          />
        </div>
      </div>

      {/* Schedule (WARP-98) */}
      <ScheduleSection
        mac={mac}
        deviceGroups={data?.device.groups ?? []}
        onError={setToast}
      />

      {/* Notes */}
      <div className="px-4 py-3 border-t border-[var(--card-bd)]">
        <label className="type-footnote text-[color:var(--text-muted)] block mb-2">Notes</label>
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
          className="w-full p-2 type-body outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--text)",
          }}
          placeholder="Add a note..."
          aria-label="Notes"
        />
      </div>

      {/* 30-day activity */}
      <div className="px-4 py-3 border-t border-[var(--card-bd)]">
        <p className="type-footnote text-[color:var(--text-muted)] mb-2">30-day activity</p>
        <DeviceSparkline days={data?.presence ?? []} size="lg" />
        <p className="type-caption-1 text-[color:var(--text-muted)] mt-2">Seen {seenDays}/30 days</p>
      </div>

      {/* Advanced */}
      <div className="px-4 py-3 border-t border-[var(--card-bd)]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="type-footnote text-[color:var(--text-muted)]"
        >
          {advancedOpen ? "Hide advanced" : "Show advanced"}
        </button>
        {advancedOpen && data?.device && (
          <dl className="mt-2 text-sm space-y-1">
            <div className="flex justify-between">
              <dt className="text-[color:var(--text-muted)]">MAC</dt>
              <dd className="font-mono text-[color:var(--text-muted)]">{data.device.mac}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[color:var(--text-muted)]">Vendor</dt>
              <dd className="text-[color:var(--text-muted)]">{data.device.vendor ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[color:var(--text-muted)]">First seen</dt>
              <dd className="text-[color:var(--text-muted)]">
                {new Date(data.device.firstSeen).toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[color:var(--text-muted)]">Last seen</dt>
              <dd className="text-[color:var(--text-muted)]">
                {new Date(data.device.lastSeen).toLocaleString()}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[var(--card-bd)] flex gap-2">
        <button
          ref={blockTriggerRef}
          type="button"
          onClick={() => setBlockConfirmOpen(true)}
          disabled={!data?.device}
          className={`type-footnote px-3 py-1.5 rounded ${data?.device.isBlocked ? "bg-system-green/10 text-system-green" : "bg-system-red/10 text-system-red"}`}
        >
          {data?.device.isBlocked ? "Unblock" : "Block"}
        </button>
        {data?.device && blockConfirmOpen && (
          <ConfirmDialog
            open={blockConfirmOpen}
            triggerRef={blockTriggerRef}
            onConfirm={handleBlockConfirm}
            onCancel={() => setBlockConfirmOpen(false)}
            title={
              data.device.isBlocked
                ? `Unblock ${data.device.displayName ?? data.device.hostname ?? data.device.vendor ?? "this device"}?`
                : `Block ${data.device.displayName ?? data.device.hostname ?? data.device.vendor ?? "this device"}?`
            }
            description={
              data.device.isBlocked
                ? "This device will regain internet access."
                : "This device won't be able to reach the internet until you unblock it."
            }
            confirmLabel={data.device.isBlocked ? "Unblock" : "Block"}
            variant={data.device.isBlocked ? "neutral" : "destructive"}
          />
        )}
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
            <span className="type-footnote text-[color:var(--text-muted)] self-center">
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
              className="type-footnote px-3 py-1.5 rounded bg-[var(--card-inner)] text-[color:var(--text)]"
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
    </Dialog>
  );
}

// --- WARP-98: Inline Schedule section for the device detail panel ---

interface ScheduleSectionProps {
  mac: string;
  deviceGroups: EnrichedNetworkDevice["groups"];
  onError: (message: string) => void;
}

function formatHHMM(d: Date): string {
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function ScheduleSection({ mac, deviceGroups, onError }: ScheduleSectionProps) {
  const router = useRouter();
  const schedulesSwr = useSchedules();
  const overridesSwr = useActiveOverrides({ deviceMac: mac });
  const groupsSwr = useNetworkGroups();
  const { cancelOverride } = useOverrideMutations();

  const [overrideModalOpen, setOverrideModalOpen] = useState<
    { action: "allow" | "block"; durationMin?: number } | null
  >(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

  const schedules: Schedule[] = schedulesSwr.data?.schedules ?? [];
  const overrides: ScheduleOverride[] = overridesSwr.data?.overrides ?? [];
  const activeOverride = overrides[0];

  // Resolve the effective schedule for this device. Device-level schedules
  // take precedence (matching the backend) — if none match, fall back to the
  // first group-level schedule that applies to one of the device's groups.
  const effective = useMemo(() => {
    const lower = mac.toLowerCase();
    const deviceSchedules = schedules.filter(
      (s) =>
        s.enabled &&
        s.subjectType === "device" &&
        (s.deviceMac ?? "").toLowerCase() === lower,
    );
    if (deviceSchedules.length > 0) {
      return { schedule: deviceSchedules[0], source: "device" as const };
    }
    const groupIds = new Set(deviceGroups.map((g) => g.id));
    const groupSchedule = schedules.find(
      (s) =>
        s.enabled &&
        s.subjectType === "group" &&
        s.groupId &&
        groupIds.has(s.groupId),
    );
    if (groupSchedule) {
      const viaGroup = deviceGroups.find((g) => g.id === groupSchedule.groupId);
      return {
        schedule: groupSchedule,
        source: "group" as const,
        groupName:
          viaGroup?.name ??
          groupsSwr.data?.groups.find((g) => g.id === groupSchedule.groupId)
            ?.name ??
          "group",
      };
    }
    return null;
  }, [schedules, deviceGroups, mac, groupsSwr.data]);

  // Derive the current state string. When any window of the effective
  // schedule is active right now, we're "Blocked by <name>"; otherwise
  // "Allowed". Transition time comes from nextTransitionFor.
  const now = new Date();
  const scheduleActiveNow = effective
    ? effective.schedule.windows.some((w) => isWindowActive(w, now))
    : false;
  const nextTransition = effective
    ? nextTransitionFor([effective.schedule], now)
    : null;

  let stateLine: string | null = null;
  if (effective) {
    if (scheduleActiveNow) {
      stateLine = `Blocked by ${effective.schedule.name}`;
      if (nextTransition)
        stateLine += ` · ends ${formatHHMM(nextTransition.at)}`;
    } else {
      stateLine = nextTransition
        ? `Allowed until ${formatHHMM(nextTransition.at)}`
        : "Allowed";
    }
  }

  async function handleCancelOverride() {
    if (!activeOverride) return;
    try {
      await cancelOverride(activeOverride.id);
    } catch (err) {
      onError(translateError(err, "network"));
    }
  }

  function jumpToSchedulesTab(scheduleId: string) {
    // WARP-100: the Network page reads `?tab` from the URL, so navigating to
    // `/network?tab=schedules#schedule-<id>` switches the page to the
    // Schedules tab (mounting SchedulesTab) and, via the hash, scrolls the
    // matching ScheduleRow into view. Previously this set location.hash only,
    // which silently dead-linked when the Schedules tab wasn't mounted.
    const href = `/network?tab=schedules#schedule-${scheduleId}`;
    router.push(href);
    // PR #720 review (blocker): App Router's router.push goes through
    // history.pushState, which does NOT fire `hashchange`. When the user is
    // ALREADY on the Schedules tab, the page's `activeTab` doesn't change, so
    // the deps-keyed scroll effect never re-runs and the second jump silently
    // doesn't scroll. Dispatch a synthetic `hashchange` so the page's listener
    // re-fires the bounded retry-scroll for the new #schedule-<id> target. The
    // cross-tab case (Schedules not yet mounted) is still handled by the
    // effect's tab-change dependency; this only adds the same-tab path.
    //
    // router.push commits the live hash a tick later, so carry the intended
    // target in `newURL` — the page reads it off the event rather than the
    // not-yet-committed window.location.hash, landing on the right row.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new HashChangeEvent("hashchange", {
          newURL: new URL(href, window.location.href).href,
          oldURL: window.location.href,
        }),
      );
    }
  }

  return (
    <div className="px-4 py-3 border-t border-[var(--card-bd)]">
      <p className="type-footnote text-[color:var(--text-muted)] mb-2">Schedule</p>

      {activeOverride && (
        <div
          role="status"
          data-testid="schedule-override-banner"
          className="mb-2 flex items-center justify-between gap-2 rounded border border-[var(--brand)] bg-[var(--brand-subtle)] px-3 py-2"
        >
          <span className="type-footnote text-[color:var(--text)]">
            Override: {activeOverride.action} until{" "}
            {formatHHMM(new Date(activeOverride.endAt))}
          </span>
          <button
            type="button"
            onClick={() => void handleCancelOverride()}
            className="type-footnote text-system-red hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {!effective ? (
        // No schedule applies — split button.
        <div className="flex items-center">
          <button
            type="button"
            onClick={() =>
              setOverrideModalOpen({ action: "allow", durationMin: 30 })
            }
            className="type-footnote px-3 py-1.5 rounded-l border border-[var(--card-bd)] text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:bg-[var(--hover)]"
          >
            + Schedule
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setSplitOpen((o) => !o)}
              aria-label="Schedule options"
              className="px-2 py-1.5 rounded-r border border-l-0 border-[var(--card-bd)] text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:bg-[var(--hover)]"
            >
              <Icons.ChevronDown className="w-4 h-4" />
            </button>
            {splitOpen && (
              <div
                role="menu"
                className="card absolute right-0 mt-1 w-52 z-10"
                style={{
                  padding: "4px 0",
                  background: "var(--glass)",
                  backdropFilter: "blur(20px) saturate(150%)",
                  WebkitBackdropFilter: "blur(20px) saturate(150%)",
                  border: "1px solid var(--card-bd)",
                  borderRadius: "var(--radius-card)",
                  boxShadow: "var(--lift)",
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSplitOpen(false);
                    setEditorOpen(true);
                  }}
                  className="w-full text-left px-3 py-2 type-footnote text-[color:var(--text)] hover:bg-[var(--hover)]"
                >
                  Create recurring schedule…
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => jumpToSchedulesTab(effective.schedule.id)}
              className="type-subheadline text-[color:var(--brand)] hover:underline"
            >
              {effective.schedule.name}
            </button>
            <span
              data-testid="schedule-source-badge"
              className="type-caption-1 px-2 py-0.5 rounded-full bg-[var(--card-inner)] text-[color:var(--text-muted)]"
            >
              {effective.source === "device"
                ? "own schedule"
                : `via ${effective.groupName ?? "group"}`}
            </span>
          </div>

          {stateLine && (
            <p className="type-footnote text-[color:var(--text-muted)]">{stateLine}</p>
          )}

          {/* Quick allow/block actions — suppressed while an override is
              live (one override at a time is clearer). */}
          {!activeOverride && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setOverrideModalOpen({ action: "allow", durationMin: 30 })
                }
                className="type-footnote px-3 py-1 rounded bg-system-green/10 text-system-green"
              >
                Allow for 30 min
              </button>
              <button
                type="button"
                onClick={() =>
                  setOverrideModalOpen({ action: "block", durationMin: 120 })
                }
                className="type-footnote px-3 py-1 rounded bg-system-red/10 text-system-red"
              >
                Block for 2h
              </button>
            </div>
          )}
        </div>
      )}

      {overrideModalOpen && (
        <OverrideModal
          subject={{ type: "device", deviceMac: mac }}
          defaultAction={overrideModalOpen.action}
          defaultDurationMin={overrideModalOpen.durationMin}
          onClose={() => setOverrideModalOpen(null)}
        />
      )}

      {editorOpen && (
        <ScheduleEditorModal
          scheduleId="new"
          initialSubject={{ type: "device", deviceMac: mac }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
