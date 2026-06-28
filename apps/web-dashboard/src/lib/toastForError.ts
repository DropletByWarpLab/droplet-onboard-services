/**
 * Single source of truth for mapping a typed-error `code` to friendly toast
 * copy (WARP-105). Previously this map was duplicated across the device,
 * device-block, and group mutation hooks plus the schedule/override modals —
 * adding a new `DeviceRegistryError` code meant editing five files. It now
 * lives here and every call site imports `toastForError`.
 *
 * The orchestrator returns `{ error: { code, message } }` on failures; the
 * dashboard's `apiFetch` lifts that `code` onto the thrown error (`err.code`,
 * see `apiFetch.ts`). We key on that string and fall back to a generic message
 * for anything unrecognized (network/timeout/UNKNOWN codes included).
 */
export const TOAST_COPY: Record<string, string> = {
  // Device + group registry errors (was `useDeviceMutations` / `useGroupMutations`).
  INVALID_ICON: "Pick a different icon",
  INVALID_MAC: "Device address is invalid",
  NOT_FOUND: "Device was forgotten or never seen",
  DUPLICATE_GROUP_NAME: "A group with that name already exists",
  GROUP_IN_USE: "Can't delete — group still has devices",
  // WARP-41 will wire the confirm flow; until then we want the user to know
  // why the action didn't go through rather than seeing a raw upstream error.
  REQUIRES_CONFIRMATION: "This action requires confirmation — not wired yet",

  // Schedule editor errors (was `ScheduleEditorModal`'s local map).
  SCHEDULE_INVALID_WINDOW: "Please check your schedule windows",
  SCHEDULE_TOO_MANY_WINDOWS: "A schedule can have at most 7 windows",
  SCHEDULE_SUBJECT_REQUIRED: "Pick a device or group",
  SCHEDULE_SUBJECT_MISMATCH: "Pick a device or group",
  SCHEDULE_NAME_REQUIRED: "Schedule needs a name",
  SCHEDULE_NOT_FOUND: "Schedule no longer exists",

  // Override modal errors (was `OverrideModal`'s local map).
  OVERRIDE_INVALID_RANGE: "End time must be after start time",
  OVERRIDE_NOT_FOUND: "Override no longer exists",
  INVALID_DATE: "Please enter a valid date and time",
};

export function toastForError(
  err: unknown,
  fallback = "Something went wrong",
): string {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    const code = (err as { code: string }).code;
    return TOAST_COPY[code] ?? fallback;
  }
  return fallback;
}
