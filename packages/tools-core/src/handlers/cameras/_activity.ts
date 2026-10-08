/**
 * WARP-3927 — pieces shared by the camera activity tools
 * (`get_camera_motion`, `list_camera_reviews`, `get_camera_recording`,
 * `summarize_camera_activity`): argument parsing, the coverage sentence, and
 * a bounded way to build media descriptors.
 *
 * Helper file only: no HTTP call here (each handler keeps its own literal
 * `ctx.http.orchestrator.get("/api/cameras/...")` so the TOOL_ROUTES drift
 * gate can read the route off the handler source), so no TOOL_ROUTES row.
 */
import { CAMERA_NAME_RE, parseChatMedia, type ChatMedia } from "@droplet/shared-types";
import type { ToolResult } from "../../types.js";
import { humanDuration } from "./_time.js";

export { CAMERA_NAME_RE };

export function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

/** A route that answered non-2xx, mapped to a code the model can act on. */
export function routeFailure(code: string, what: string, status: number): ToolResult {
  if (status === 403) {
    return {
      ok: false,
      status: "error",
      error: { code: "CAMERA_ACCESS_DENIED", message: `You don't have access to ${what}.` },
    };
  }
  return {
    ok: false,
    status: "error",
    error: { code, message: `${what} failed — orchestrator returned ${status}` },
  };
}

/** `camera` (one name) → the route's `cameras` csv; undefined when absent. */
export function parseCameraArg(raw: unknown): { ok: true; camera?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  if (typeof raw !== "string" || !CAMERA_NAME_RE.test(raw)) {
    return { ok: false, message: "camera must be a valid camera name (letters, digits, underscores, hyphens)" };
  }
  return { ok: true, camera: raw };
}

/** csv string or string array → trimmed, de-duplicated tokens, each checked by `ok`. */
export function parseCsvArg(
  raw: unknown,
  field: string,
  ok: (token: string) => boolean,
  max: number,
): { ok: true; values: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, values: [] };
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (items === null) return { ok: false, message: `${field} must be a comma-separated string or a list of strings` };
  const values: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return { ok: false, message: `${field} must be a comma-separated string or a list of strings` };
    const token = item.trim();
    if (token === "") continue;
    if (!ok(token)) return { ok: false, message: `${field}: "${token.slice(0, 40)}" is not valid` };
    if (!values.includes(token)) values.push(token);
  }
  if (values.length > max) return { ok: false, message: `${field}: at most ${max} values` };
  return { ok: true, values };
}

export function parseBusinessHours(raw: unknown): { ok: true; value?: "inside" | "outside" } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  if (raw !== "inside" && raw !== "outside") return { ok: false, message: 'business_hours must be "inside" or "outside"' };
  return { ok: true, value: raw };
}

// ── coverage ────────────────────────────────────────────────────────────

/** A stretch this short between segments is segment rounding, not a gap. */
const COVERAGE_TOLERANCE_SECONDS = 60;

export interface CoverageSummary {
  /** One plain sentence the model can repeat; never implies an all-clear. */
  note: string;
  /** True only when every camera answered AND its footage covers the window. */
  complete: boolean;
  /** Why it is not complete, one phrase each (empty when complete). */
  reasons: string[];
}

/**
 * Turn the motion route's `coverage` object into a sentence. Motion that is
 * absent from a stretch with no footage is NOT evidence of a quiet stretch —
 * the sentence says so whenever there is a gap, so the model cannot read
 * "no motion" as "all clear".
 */
export function describeCoverage(coverage: unknown): CoverageSummary {
  const c = coverage && typeof coverage === "object" ? (coverage as Record<string, unknown>) : null;
  const after = c && typeof c.after === "number" ? c.after : NaN;
  const before = c && typeof c.before === "number" ? c.before : NaN;
  const cams = c && Array.isArray(c.cameras) ? (c.cameras as Array<Record<string, unknown>>) : null;
  if (!c || !cams || !Number.isFinite(after) || !Number.isFinite(before) || before <= after) {
    return {
      note: "Recording coverage is unknown for this period, so a lack of motion here is not an all-clear.",
      complete: false,
      reasons: ["recording coverage unknown"],
    };
  }
  if (cams.length === 0) {
    return {
      note: "No cameras were available to check for this period, so nothing can be said about what happened.",
      complete: false,
      reasons: ["no cameras available"],
    };
  }
  const windowSeconds = before - after;
  let recorded = 0;
  let missing = 0;
  const unavailable: string[] = [];
  const gapped: string[] = [];
  for (const cam of cams) {
    const name = typeof cam.camera === "string" ? cam.camera : "camera";
    if (cam.available !== true || typeof cam.recordedSeconds !== "number") {
      unavailable.push(name);
      continue;
    }
    const got = Math.min(Math.max(0, cam.recordedSeconds), windowSeconds);
    recorded += got;
    const gap = windowSeconds - got;
    missing += gap;
    if (gap > COVERAGE_TOLERANCE_SECONDS) gapped.push(name);
  }
  const answered = cams.length - unavailable.length;
  const parts: string[] = [];
  if (answered > 0) {
    const missingMinutes = Math.round(missing / 60);
    parts.push(
      `Footage covers ${humanDuration(recorded)} of the ${humanDuration(windowSeconds * answered)} asked for` +
        `${answered > 1 ? ` across ${answered} cameras` : ""}; ` +
        (missingMinutes === 0 ? "there are no gaps." : `${missingMinutes} minutes have no recording.`),
    );
  }
  if (unavailable.length > 0) {
    parts.push(`Recording data could not be read for ${unavailable.join(", ")}, so nothing can be said about ${unavailable.length > 1 ? "them" : "it"}.`);
  }
  const reasons: string[] = [];
  if (gapped.length > 0) reasons.push(`no recording for part of the period (${gapped.join(", ")})`);
  if (unavailable.length > 0) reasons.push(`recording data unavailable (${unavailable.join(", ")})`);
  if (reasons.length > 0) {
    parts.push("Activity during the missing stretches is unknown; do not treat it as quiet.");
  }
  return { note: parts.join(" "), complete: reasons.length === 0, reasons };
}

// ── media ───────────────────────────────────────────────────────────────

/** Validate descriptors with the same parser the dashboard runs; drop the unsafe. */
export function validMedia(candidates: unknown[], max: number): ChatMedia[] {
  return parseChatMedia({ media: candidates }).slice(0, max);
}
