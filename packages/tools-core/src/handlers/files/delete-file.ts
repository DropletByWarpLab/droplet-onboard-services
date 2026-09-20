/**
 * WARP-2669 — `delete_file` is Write-tier **plus confirmation**.
 *
 * Deletes a file, or a directory AND EVERYTHING INSIDE IT, via the
 * orchestrator's WARP-861 files API (`DELETE /api/files?path=`). That route
 * calls `ncDeleteFile`, a WebDAV DELETE, so the target lands in the Nextcloud
 * trash rather than being unlinked — and emptying the trash is a dashboard
 * action, never a tool. Recovery is therefore real.
 *
 * ## Why it is gated anyway
 *
 * It shipped `requiresConfirmation: false` from the WARP-102 bulk port
 * (ded46016) — a port whose commit message enumerates the destructive flagging
 * it did for network, switch and smart-home, and says nothing of the kind for
 * files. The files domain was never triaged into the tier system at all:
 * `docs/llm-safety-tiers.md` had no Files section until this ticket added one.
 *
 * The rest of the tree had already decided the answer and only this descriptor
 * disagreed:
 *
 *   - `docs/tool-confirmation-contract.md` §3 uses THIS TOOL as its worked
 *     example of a challenging one — the sample challenge payload is
 *     `"tool": "delete_file"`, the sample confirming call presents a token on
 *     `_meta`, and the argument-binding rule is written as "a challenge for
 *     delete_file('/tmp/x') cannot approve delete_file('/payroll')";
 *   - `confirmation-token.test.ts` mints and redeems every token in its suite
 *     for `delete_file`; `chat-approval-roundtrip.test.ts` builds a stub of it
 *     with `requiresConfirmation: true`; `llm-confirm.route.test.ts` uses it as
 *     `WRITE_TOOL`, the thing only a privileged tier may approve. All green,
 *     all describing a tool the registry did not actually ship;
 *   - `restore_file_version`, in this same directory, is gated — and its own
 *     docblock says the operation is REVERSIBLE. A reversible single-file
 *     content change asked the user; a recursive tree delete did not;
 *   - `delete_clip` — one camera clip — is gated AND excluded from the chat
 *     pool. `delete_file` is in the chat pool.
 *
 * Recoverable is not the same as unattended-safe, and this repo has never
 * treated it as such: `unblock_network_device` is trivially reversible and
 * gated too. Tier 2 here means "a human would want to see this first", and a
 * recursive tree delete is squarely that.
 *
 * ## The shape of the gate
 *
 * Interceptor-owned — the `confirmationOwner` default, correct because
 * `DELETE /api/files` runs no Tier-2 gate of its own, so there is no route
 * challenge to stand down for (contract §13). Since WARP-2305 the flag is a
 * real generic gate: `interceptor.ts` runs BEFORE the handler at the single
 * `tool.handler(...)` call site in `services/mcp-server/src/server.ts`, which
 * both the in-process agent loop and external MCP clients reach. A refused
 * call never gets here, so this file needs no confirmation code of its own —
 * writing one is what produced the 37 duplicated copies WARP-2305 removed.
 *
 * Deliberately NO `confirmed` boolean in the schema. That would opt the tool
 * into the legacy path (contract §3), where the model can emit the approving
 * token itself against a live challenge. Without it, only a token a human
 * minted through `POST /api/llm/confirm/:challengeId` (WARP-2469, §14) gets
 * through — fail-closed, and the same shape WARP-2664 chose for `delete_files`
 * and `organize_files`.
 *
 * WHAT IS NOT CHANGED: recursion. Once a human approves the exact path, the
 * tree going with it is the thing they approved — and the token binds to that
 * path, so the approval cannot be moved to another one. Splitting file and
 * directory deletion into two tools was considered and rejected: it costs a
 * registry entry against 59 characters of chat-pool headroom, and WARP-2664
 * already set the line that deleting a folder with contents is a Files-app
 * action. Gating only when the target IS a directory was rejected as unsound —
 * that needs a listing probe, and `GET /api/files` answers 200 `[]` on an
 * upstream outage, so an outage would make a tree delete read as a file delete
 * and skip the prompt. Same failure mode WARP-2664 rejected `allow_folders`
 * over.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full path to the file or directory." },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  const v = validateNcPath(args.path);
  if (!v.ok) return err("INVALID_PATH", v.error);
  if (v.path === "/") return err("INVALID_PATH", "refusing to delete root");
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.delete(
    `/?path=${encodeURIComponent(v.path)}`,
    { headers },
  );
  if (!res.ok) return err("DELETE_FAILED", `nextcloud returned ${res.status}`);
  return { ok: true, data: { deleted: v.path } };
}

const tool: Tool = {
  name: "delete_file",
  description:
    "Delete a file, or a folder AND EVERYTHING INSIDE IT, to the Nextcloud trash (restorable from the dashboard). Asks the user to approve.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
