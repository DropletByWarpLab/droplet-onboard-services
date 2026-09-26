// WARP-3193 SEC-INJ-2 — refusals for file writes that need a human.
//
// Replacing an existing file, or moving/copying a private file into a shared
// folder, destroys or exposes data as surely as delete_file does. tools-core
// has no argument-dependent confirmation (the interceptor keys on the static
// `requiresConfirmation` flag, and flipping it would challenge every ordinary
// move), so these calls are refused with a code the model can act on. The
// orchestrator's /files/move and /files/copy routes answer the same code
// (403) for the mcp principal, which is where the shared-folder names live.

import type { ToolResult } from "../../types.js";

export const USER_APPROVAL_REQUIRED = "USER_APPROVAL_REQUIRED";

function refusal(reason: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: USER_APPROVAL_REQUIRED,
      message:
        `${reason}. This tool cannot collect that approval, so do not retry. ` +
        "Ask the user: they can pick a different destination, or do it themselves in Files.",
    },
  };
}

export function needsUserApproval(what: string): ToolResult {
  return refusal(`${what} needs the user's approval`);
}

/** The route's refusal, if this response is one. */
export async function routeApprovalRefusal(res: Response): Promise<ToolResult | null> {
  if (res.status !== 403) return null;
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; error?: unknown };
  if (body.code !== USER_APPROVAL_REQUIRED) return null;
  return refusal(typeof body.error === "string" ? body.error : "This write needs the user's approval");
}
