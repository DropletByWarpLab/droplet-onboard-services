/**
 * WARP-2002 — test helper for the two-phase confirmation flow.
 *
 * Before WARP-2002 a suite could execute a Tier-2 tool by passing
 * `confirmed: true`, because that was the whole gate. It no longer is: the
 * handler now demands a server-minted, single-use, target-bound token that the
 * caller can only obtain from the tool's OWN first response.
 *
 * `runApproved` keeps the existing `confirmed: true` call sites readable while
 * exercising the real mechanism underneath — first call to obtain the token,
 * second call to execute. It deliberately does NOT reach into the token store
 * or recompute a fingerprint: a test that mints its own token would pass even
 * if the handler's gate were deleted.
 *
 * Calls without `confirmed: true` pass straight through, so first-call /
 * refusal assertions are unaffected.
 */
import type { Tool, ToolContext, ToolResult } from "../../src/types.js";

export async function runApproved(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (args.confirmed !== true) return tool.handler(args, ctx);

  // `confirmed` is dead as an input. Drop it so the handler sees the call the
  // model would actually make, and so a handler that still honoured the flag
  // would fail these tests rather than sail through them.
  const { confirmed: _ignored, ...rest } = args;

  const first = await tool.handler(rest, ctx);

  // Reached no gate — either it succeeded outright or it failed validation
  // before the gate. Both are the answer the caller is asserting on.
  if (first.ok) return first;
  const details = first.error.details as { confirmationToken?: string } | undefined;
  if (typeof details?.confirmationToken !== "string") return first;

  return tool.handler(
    { ...rest, confirmation_token: details.confirmationToken },
    ctx,
  );
}
