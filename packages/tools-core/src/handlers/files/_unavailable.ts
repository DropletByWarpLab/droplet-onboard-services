import type { ToolResult } from "../../types.js";

/**
 * WARP-3077 — the files API answers a Nextcloud outage on its read routes
 * with 200 and an empty body (so old clients don't dead-end), and marks it
 * with this header (WARP-3052, `handleFileError` in the orchestrator's
 * routes/files.ts). Without reading it, a tool hands the model an empty
 * result and the assistant tells an employee "you have no files" /
 * "that folder is empty" during an outage — a read runs with no prompt,
 * so that wrong answer reaches the user unchecked.
 */
export const DEGRADED_HEADER = "x-droplet-degraded";

export const FILES_UNAVAILABLE_MESSAGE =
  "Files are unavailable right now (the file service on this Droplet is not responding). Try again in a moment.";

/** True when the files API served this 200 from its outage fallback. */
export function isFilesDegraded(res: Response): boolean {
  return res.headers.get(DEGRADED_HEADER) !== null;
}

/** The tool result for a degraded answer — never mistakable for "empty". */
export function filesUnavailable(): ToolResult {
  return {
    ok: false,
    status: "error",
    error: { code: "FILES_UNAVAILABLE", message: FILES_UNAVAILABLE_MESSAGE },
  };
}
