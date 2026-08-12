/**
 * WARP-1893 — `rename_camera` LLM tool.
 *
 * Changes a camera's household-facing display name via
 * `PATCH /api/cameras/:name`. It does NOT touch `Camera.name`, the Frigate
 * config key that owns the recording paths and event history — see that
 * route's comment for why renaming the key is not on the table.
 *
 * Write, but deliberately NOT `requiresConfirmation`. A display name is
 * trivially reversible and destroys nothing, and renaming is the one camera
 * operation a user is most likely to do casually and in passing ("call that
 * one the driveway"). A confirmation round-trip on every rename would make
 * the assistant tedious for no safety gain. Contrast `set_camera_detection`,
 * which stops recording and so earns its handshake.
 *
 * Resolution is the interesting part: people say "the driveway camera", not
 * "xnv_c8083r_e43022502afd". The handler resolves the argument against BOTH
 * the config key and the current display name, and refuses to guess when
 * more than one camera matches — `displayName` is intentionally not unique,
 * so ambiguity is reachable, not theoretical.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Mirrors MAX_DISPLAY_NAME_LEN on the orchestrator route — validate
 *  client-side so the model gets a precise error, not a proxied 400. */
const MAX_DISPLAY_NAME = 64;

/** How many camera names to list back when resolution fails. Enough to be
 *  actionable, bounded so a large install can't flood the context. */
const MAX_SUGGESTIONS = 12;

interface KnownCamera {
  name: string;
  displayName: string | null;
}

const inputSchema = {
  type: "object",
  properties: {
    camera: {
      type: "string",
      description:
        'Which camera to rename. Accepts either the id from list_cameras (e.g. front_door) or the camera\'s CURRENT display name (e.g. "Front Door"). If the user was vague and several cameras could match, the tool will say so rather than pick one.',
    },
    display_name: {
      type: "string",
      description:
        'The new household-facing name, e.g. "Driveway". 1-64 characters; spaces and accents are fine. This is a label only — the camera\'s underlying id is unchanged and existing recordings are unaffected.',
    },
  },
  required: ["camera", "display_name"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

function failed(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/** Best-effort extraction of `{ error: "…" }` from an orchestrator reply. */
async function serverError(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return body && typeof body.error === "string" ? body.error : null;
}

/** Render a camera for an error message: `front_door ("Front Door")`. */
function describe(c: KnownCamera): string {
  return c.displayName && c.displayName !== c.name ? `${c.name} ("${c.displayName}")` : c.name;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const camera = typeof args.camera === "string" ? args.camera.trim() : "";
  if (camera.length === 0) return invalidArgs("camera is required");

  const displayName = typeof args.display_name === "string" ? args.display_name.trim() : "";
  if (displayName.length === 0) {
    return invalidArgs("display_name is required and cannot be blank");
  }
  if (displayName.length > MAX_DISPLAY_NAME) {
    return invalidArgs(`display_name must be ${MAX_DISPLAY_NAME} characters or fewer`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(displayName)) {
    return invalidArgs("display_name cannot contain control characters");
  }

  // Resolve the user's phrasing to a config key. Same endpoint list_cameras
  // reads, so the model's mental model and this lookup cannot diverge.
  const listRes = await ctx.http.orchestrator.get("/api/cameras", {
    headers: { Accept: "application/json" },
  });
  if (!listRes.ok) {
    return failed("CAMERAS_UNAVAILABLE", `cameras service returned ${listRes.status}`);
  }
  const body = (await listRes.json().catch(() => null)) as { cameras?: unknown } | null;
  const rows = Array.isArray(body?.cameras) ? (body.cameras as Array<Record<string, unknown>>) : [];
  const known: KnownCamera[] = rows.flatMap((r) =>
    typeof r.name === "string" && r.name.length > 0
      ? [{ name: r.name, displayName: typeof r.displayName === "string" ? r.displayName : null }]
      : [],
  );

  if (known.length === 0) {
    return failed("CAMERA_NOT_FOUND", "no cameras are configured on this Droplet");
  }

  const needle = camera.toLowerCase();
  // An exact config-key hit wins outright — `name` is unique, so it can
  // never be ambiguous, and it must beat a display name that happens to
  // collide with some other camera's id.
  let matches = known.filter((c) => c.name.toLowerCase() === needle);
  if (matches.length === 0) {
    matches = known.filter((c) => (c.displayName ?? "").toLowerCase() === needle);
  }

  if (matches.length === 0) {
    const listed = known.slice(0, MAX_SUGGESTIONS).map(describe).join(", ");
    const more = known.length > MAX_SUGGESTIONS ? `, and ${known.length - MAX_SUGGESTIONS} more` : "";
    return failed(
      "CAMERA_NOT_FOUND",
      `no camera matches "${camera}". Configured cameras: ${listed}${more}.`,
    );
  }
  if (matches.length > 1) {
    // Reachable because displayName is deliberately not unique — a household
    // may have two "Side Gate" cameras. Guessing would rename the wrong one.
    return failed(
      "CAMERA_AMBIGUOUS",
      `"${camera}" matches ${matches.length} cameras: ${matches.map(describe).join(", ")}. ` +
        "Ask the user which one they mean, then call again with that camera's exact id.",
    );
  }

  const target = matches[0];
  const res = await ctx.http.orchestrator.patch(
    `/api/cameras/${encodeURIComponent(target.name)}`,
    { displayName },
  );

  if (res.status === 404) {
    return failed("CAMERA_NOT_FOUND", `camera "${target.name}" not found`);
  }
  if (!res.ok) {
    const msg = await serverError(res);
    return failed("RENAME_FAILED", msg ?? `orchestrator returned ${res.status}`);
  }

  return {
    ok: true,
    data: {
      type: "rename_camera",
      camera: target.name,
      previousDisplayName: target.displayName,
      displayName,
    },
  };
}

const tool: Tool = {
  name: "rename_camera",
  description:
    'Rename a security camera to something the household actually calls it, e.g. turn "Xnv C8083r E43022502afd" into "Driveway". Accepts either the camera id or its current display name. This changes the label only — the camera\'s underlying id, its recordings, and its event history are all unaffected, and the change is instant and reversible. Use whenever the user asks to rename, re-label, or "call" a camera something.',
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
