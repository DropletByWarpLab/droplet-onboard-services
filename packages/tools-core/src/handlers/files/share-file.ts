/**
 * WARP-1456 — `share_file` LLM tool (Tier 2, write + handler-enforced
 * confirmation).
 *
 * Creates a PUBLIC link share (OCS shareType 3) for a file via the
 * orchestrator's WARP-861 files API (`POST /api/files/share`). Public
 * links are the classic footgun — anyone with the URL can open the file
 * — so the handler enforces the two-phase contract itself (same pattern
 * as `memory_forget`): the first call returns `confirmation_required`
 * (zero HTTP) stating that a PUBLIC link will be created, when it
 * expires, and whether it is password-protected; only a re-issue with
 * `confirmed: true` — after the user explicitly approves — mints the
 * share.
 *
 * Guardrails baked into the tool (deliberately tighter than the route):
 *   • expiry is ALWAYS set — 1..90 days, default 7 (the route would
 *     accept a never-expiring link; this tool never mints one);
 *   • optional password must be 8..64 chars;
 *   • permissions are pinned to the dashboard ShareDialog's presets:
 *     view = 1 (read), edit = 3 (read|update — file-safe, no
 *     create/delete bits, which Nextcloud rejects on single-file shares).
 *
 * The password is NEVER echoed in any response branch — not in the
 * confirmation message/details, not in success data, not in errors
 * (test-pinned via JSON.stringify, like set_wifi_password).
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";

const TOOL_NAME = "share_file";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

/** OCS public-link share type (matches the dashboard's SHARE_TYPE_LINK). */
const SHARE_TYPE_LINK = 3;
/** OCS permission bitmasks — the dashboard ShareDialog's file-safe presets. */
const PERM_VIEW = 1; // read
const PERM_EDIT = 3; // read | update

const MIN_EXPIRES_DAYS = 1;
const MAX_EXPIRES_DAYS = 90;
const DEFAULT_EXPIRES_DAYS = 7;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 64;

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Full path to the file to share.",
    },
    expires_days: {
      type: "integer",
      minimum: MIN_EXPIRES_DAYS,
      maximum: MAX_EXPIRES_DAYS,
      description: "Days until the link expires (1-90). Default 7. Every link expires.",
    },
    password: {
      type: "string",
      minLength: MIN_PASSWORD_LEN,
      maxLength: MAX_PASSWORD_LEN,
      description: "Optional password (8-64 chars) required to open the link.",
    },
    allow_edit: {
      type: "boolean",
      description: "Allow anyone with the link to EDIT the file (default false: view-only).",
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the action, and the user approves from that prompt.",
    },
  },
  required: ["path"],
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

  let expiresDays = DEFAULT_EXPIRES_DAYS;
  if (args.expires_days !== undefined) {
    if (
      typeof args.expires_days !== "number" ||
      !Number.isInteger(args.expires_days) ||
      args.expires_days < MIN_EXPIRES_DAYS ||
      args.expires_days > MAX_EXPIRES_DAYS
    ) {
      return err(
        "INVALID_ARGS",
        `expires_days must be an integer between ${MIN_EXPIRES_DAYS} and ${MAX_EXPIRES_DAYS}`,
      );
    }
    expiresDays = args.expires_days;
  }

  let password: string | undefined;
  if (args.password !== undefined) {
    // NEVER echo the supplied value — length-only complaint.
    if (
      typeof args.password !== "string" ||
      args.password.length < MIN_PASSWORD_LEN ||
      args.password.length > MAX_PASSWORD_LEN
    ) {
      return err(
        "INVALID_ARGS",
        `password must be a string of ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters`,
      );
    }
    password = args.password;
  }

  if (args.allow_edit !== undefined && typeof args.allow_edit !== "boolean") {
    return err("INVALID_ARGS", "allow_edit must be a boolean");
  }
  const allowEdit = args.allow_edit === true;

  // YYYY-MM-DD, the exact format the route's zod schema requires.
  const expireDate = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const passwordProtected = password !== undefined;

  // Confirmation gate — AFTER validation (a malformed call should fail
  // loudly, not ask the user to approve it) and BEFORE any HTTP. The
  // details block never carries the password itself.
  const fingerprint = confirmationFingerprint([TOOL_NAME, path, expireDate, passwordProtected, allowEdit]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to create a PUBLIC share link for "${path}" — anyone with the link can ${allowEdit ? "view AND EDIT" : "view"} the file. The link expires on ${expireDate} and is ${passwordProtected ? "password-protected" : "NOT password-protected"}. ` +
        "Ask the user to approve. " +
        "You cannot approve on their behalf.",
      { type: "share_file", path, expiresAt: expireDate, passwordProtected, allowEdit },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.post(
    "/share",
    {
      path,
      shareType: SHARE_TYPE_LINK,
      permissions: allowEdit ? PERM_EDIT : PERM_VIEW,
      expireDate,
      ...(password !== undefined ? { password } : {}),
    },
    { headers },
  );
  if (res.status === 404) {
    return err("NOT_FOUND", `file not found: ${path}`);
  }
  if (res.status === 400) {
    // Route-side validation passthrough (zod message or NC password
    // policy). Only the `error` string is surfaced — never the request
    // body, so the password can't leak back through this branch.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return err("INVALID_SHARE", body?.error ?? "invalid share request");
  }
  if (!res.ok) {
    return err("SHARE_FAILED", `nextcloud returned ${res.status}`);
  }
  const share = (await res.json().catch(() => null)) as {
    url?: string | null;
    expireDate?: string | null;
  } | null;
  return {
    ok: true,
    data: {
      type: "share_file",
      path,
      url: share?.url ?? null,
      expiresAt: share?.expireDate ?? expireDate,
      passwordProtected,
      allowEdit,
    },
  };
}

const tool: Tool = {
  name: "share_file",
  description:
    "Create a PUBLIC link to a file on the Droplet's Nextcloud — anyone with the link can open it (view-only unless allow_edit). The link always expires (expires_days 1-90, default 7) and can be password-protected (password 8-64 chars). Two-step: the first call returns confirmation_required stating the link is public, its expiry, and whether it has a password — relay it to the user, and only after they explicitly approve, approval is handled outside this conversation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
