// Plain-language copy for time tracking (WARP-3526; design brief §6: sentence
// case, no exclamation marks, never blame the user). The orchestrator's
// snake_case codes never reach a toast verbatim.
//
// Kept here rather than in `lib/friendly-errors.ts`, which every slice edits: the
// time codes are checked first and anything else falls through to the shared
// `projects` translator, so `module_disabled`, `work_item_not_found` and the
// network fallback keep their one source of truth.

import { translateError } from "@/lib/friendly-errors";
import { MAX_ENTRY_MINUTES, MIN_ENTRY_MINUTES } from "./format";

export const DURATION_HELP =
  `Enter a time from ${MIN_ENTRY_MINUTES} minute to ${MAX_ENTRY_MINUTES / 60} hours, like 45m or 1h 30m.`;

const TIME_ERRORS: Record<string, string> = {
  worklog_not_found: "That entry isn't there anymore. Refresh and try again.",
  worklog_forbidden: "You can only change your own entries.",
  timer_not_found: "No timer is running.",
  work_item_archived: "This item is archived, so time can't be added to it.",
  started_at_in_future: "Time can't start in the future.",
  invalid_minutes: DURATION_HELP,
  user_not_found: "That person isn't in this Droplet's directory.",
  concurrent_mutation: "Your timer changed at the same moment. Nothing was applied — try again.",
  invalid_timezone: "That time zone isn't one this Droplet knows. Refresh and try again.",
  invalid_week_start: "That week isn't a valid date. Pick another and try again.",
  invalid_range: "That date range isn't valid. Pick a start date no later than the end, within a year.",
};

/** A friendly sentence for a failed time request. */
export function timeErrorCopy(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TIME_ERRORS[code]) return TIME_ERRORS[code];
  return translateError(err, "projects");
}
