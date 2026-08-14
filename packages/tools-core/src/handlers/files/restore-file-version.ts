/**
 * WARP-1456 — `restore_file_version` LLM tool (Tier 2, write +
 * handler-enforced confirmation).
 *
 * Rolls a file back to a previous version via the orchestrator's
 * WARP-861 files API (`POST /api/files/versions/restore` with
 * `{ path, versionId }`). Version ids come from `list_file_versions`.
 *
 * Neither the MCP server nor the agent loop enforces the
 * `requiresConfirmation` flag generically, so the handler enforces the
 * two-phase contract itself (same pattern as `memory_forget`): the
 * first call returns `confirmation_required` (zero HTTP) naming the
 * file and version; only a re-issue with `confirmed: true` — after the
 * user explicitly approves — performs the restore.
 *
 * Undo story (verified against `ncRestoreVersion` in the orchestrator's
 * nextcloud.client.ts): the pre-restore current content automatically
 * becomes the most-recent version, so a restore is itself reversible.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";

const TOOL_NAME = "restore_file_version";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Full path to the file to roll back.",
    },
    version: {
      type: "string",
      description:
        "The versionId to restore, as returned by list_file_versions for this path.",
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the action, and the user approves from that prompt.",
    },
  },
  required: ["path", "version"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) {
    // The message is surfaced verbatim to the chat model, which relays it
    // to the user — say how to RECOVER, not just that auth is missing.
    // Sessions minted without a password (passkey/SSO), or whose stored
    // Nextcloud credential was lost (cache restart) or revoked (logout
    // elsewhere), can only be re-provisioned by a password sign-in.
    return {
      ok: false,
      status: "error",
      error: {
        code: "AUTH_REQUIRED",
        message:
          "File access isn't connected for this session. Ask the user to sign out of the Droplet dashboard and sign back in with their password — that reconnects file access and file tools will work again.",
      },
    };
  }
  const v = validateNcPath(args.path);
  if (!v.ok) return err("INVALID_PATH", v.error);
  const path = v.path;
  const version = typeof args.version === "string" ? args.version.trim() : "";
  if (version.length === 0) {
    return err("INVALID_ARGS", "version is required (a versionId from list_file_versions)");
  }

  // Confirmation gate — AFTER validation (a malformed call should fail
  // loudly, not ask the user to approve it) and BEFORE any HTTP.
  const fingerprint = confirmationFingerprint([TOOL_NAME, path, version]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to restore "${path}" to version ${version}. This will replace the file's current content with that version — Nextcloud keeps the current content as the newest version, so it stays recoverable. ` +
        "Ask the user to approve. " +
        "You cannot approve on their behalf.",
      { type: "restore_file_version", path, version },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.post(
    "/versions/restore",
    { path, versionId: version },
    { headers },
  );
  if (res.status === 404) {
    // The route 404s when the FILE path can't be resolved; a bad version
    // id surfaces as a non-404 restore failure below.
    return err("NOT_FOUND", `file not found: ${path}`);
  }
  if (!res.ok) {
    return err("RESTORE_FAILED", `nextcloud returned ${res.status}`);
  }
  return { ok: true, data: { type: "restore_file_version", path, version, restored: true } };
}

const tool: Tool = {
  name: "restore_file_version",
  description:
    "Roll a file on the Droplet's Nextcloud back to a previous version (versionId from list_file_versions). The current content is replaced but Nextcloud keeps it as the newest version, so the restore is reversible. Two-step: the first call returns confirmation_required naming the file and version — relay it to the user, and only after they explicitly approve, approval is handled outside this conversation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
