/**
 * WARP-1450 — `apply_update` LLM tool.
 *
 * Apply the single pending verified OTA update via the orchestrator's
 * `POST /api/updates/apply-now` (routes/updates.ts, WARP-540 → the
 * WARP-539 apply pipeline). The highest-blast-radius tool in the
 * catalog: services are recreated during apply and the assistant
 * itself may go quiet mid-apply.
 *
 * ROLE GATE (WARP-845 / WARP-1450): only `ctx.role` owner or admin may
 * proceed — the ROLE_RANK ladder mirrors
 * handlers/network/list-threat-events.ts. The updates routes are
 * owner/admin-gated too, but on this call path they only ever see the
 * mcp-server's SERVICE principal, so the route guard says nothing
 * about the human in the chat. THIS check is the human-role defense,
 * and it runs BEFORE any HTTP leaves the handler.
 *
 * Two-phase confirmation, enforced BY THE HANDLER (remove_device /
 * memory_forget idiom): the first call fetches `/api/updates/status`
 * and returns `confirmation_required` naming the pending version plus
 * the restart/quiet-period warning — zero side effects.
 *
 * WARP-2002: the second call must carry a SERVER-MINTED single-use token
 * bound to THIS pending update's id. That binding matters here more than
 * anywhere else in the catalog — note directly below that this route's 202
 * is terminal success, not a confirmation, so there is NO server-side gate
 * behind this tool. The token is the only thing between the model and a
 * whole-appliance update.
 *
 * FIRE-ONCE SEMANTICS (do not weaken):
 *   - The route answers 202 the moment the apply is DISPATCHED — the
 *     apply then runs minutes and may end by swapping the orchestrator
 *     (and this MCP server) out from under us. 202 is terminal success
 *     here: never wait, poll, or re-request after it. NOTE this is why
 *     confirmation.ts's isConfirmationResponse/passThroughConfirmation
 *     (which read 202 as "confirmation required") are deliberately NOT
 *     used on this POST.
 *   - A thrown fetch after the dispatch attempt (timeout / dropped
 *     connection — e.g. services already restarting) maps to
 *     APPLY_DISPATCH_UNCONFIRMED, NOT a retry: the apply may already
 *     be in motion, and a second POST could double-fire into the 409
 *     guard or worse. The user is told to check get_update_status.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const TOOL_NAME = "apply_update";

/** WARP-845 — audience ladder (same table as handlers/network/list-threat-events.ts). */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1,
  guest: 0,
};
const ADMIN_RANK = 2;

/** The DeviceUpdate slice `/api/updates/status` serializes (ROW_SELECT
 *  in routes/updates.ts). Dates arrive as ISO strings over JSON. */
interface UpdateRowView {
  id: string;
  status: string;
  releaseTag: string | null;
  gitSha: string;
}

const inputSchema = {
  type: "object",
  properties: {
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required naming the pending version, and the user approves from that prompt.",
    },
  },
  additionalProperties: false,
} as const;

function toolError(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/** Same version label the route uses in activity rows. */
function versionLabel(row: UpdateRowView): string {
  return row.releaseTag ?? row.gitSha.slice(0, 10);
}

const NOTHING_PENDING = toolError(
  "NOTHING_PENDING",
  "no verified update is pending — there is nothing to apply (use get_update_status to check again later)",
);

/** Matches the setup-gate deferral vocabulary from the update agent
 *  (`deferred_setup_in_progress` in services/update-agent/apply.ts)
 *  whether the route surfaces it as `error` or `outcome`. */
function deferralOf(body: Record<string, unknown>): string | null {
  for (const key of ["error", "outcome"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.includes("deferred")) return value;
  }
  return null;
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Role gate FIRST — before any HTTP. Absent role → guest view.
  if ((ROLE_RANK[ctx.role ?? ""] ?? 0) < ADMIN_RANK) {
    return toolError(
      "FORBIDDEN",
      "software updates can be applied by owners and admins only",
    );
  }

  // ── resolve the pending update, on BOTH phases ──
  //
  // WARP-2002: this used to run only on the unconfirmed phase, because the
  // gate was a boolean and needed nothing from the server. The token is bound
  // to the specific pending update, so the row has to be re-read before the
  // apply too. That is a strict improvement: an approval for update X can no
  // longer dispatch a different update Y that landed in between.
  let statusRes: Response;
  try {
    statusRes = await ctx.http.orchestrator.get("/api/updates/status", {
      headers: { Accept: "application/json" },
    });
  } catch {
    return toolError(
      "STATUS_UNAVAILABLE",
      "could not check for a pending update — orchestrator not reachable",
    );
  }
  if (!statusRes.ok) {
    return toolError(
      "STATUS_UNAVAILABLE",
      `could not check for a pending update — orchestrator returned ${statusRes.status}`,
    );
  }
  const payload = (await statusRes.json().catch(() => ({}))) as {
    pending?: UpdateRowView | null;
  };
  const pending = payload.pending ?? null;
  // Nothing on deck → short-circuit; never mint a doomed confirmation.
  if (!pending) return NOTHING_PENDING;
  // An apply already owns the row → confirming would only 409.
  if (pending.status === "applying") {
    return toolError(
      "APPLY_IN_PROGRESS",
      "an update apply is already in progress — follow it with get_update_status",
    );
  }

  const version = versionLabel(pending);

  // Confirmation gate. This route's 202 means "dispatched" — terminal success,
  // NOT confirmation_required (see the header note) — so unlike the wifi tools
  // there is no server-side gate behind this one. The token IS the gate.
  const fingerprint = confirmationFingerprint([TOOL_NAME, pending.id]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to apply the pending verified update ${version}. ` +
        "Droplet services will restart during the apply, and the assistant may go quiet for several minutes — that is expected; " +
        "progress can be followed with get_update_status afterwards. " +
        "The update system verifies release signatures and automatically rolls back if the new version fails its health checks. " +
        "Ask the user to approve. You cannot approve on their behalf.",
      {
        type: TOOL_NAME,
        version,
        deviceUpdateId: pending.id,
        releaseTag: pending.releaseTag,
        gitSha: pending.gitSha,
      },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  // ── phase 2: confirmed — dispatch exactly once ──
  let res: Response;
  try {
    res = await ctx.http.orchestrator.post("/api/updates/apply-now", undefined, {
      headers: { Accept: "application/json" },
    });
  } catch {
    // Dropped connection/timeout AFTER the dispatch attempt: the apply
    // may already be restarting services. Never retry — report honestly.
    return toolError(
      "APPLY_DISPATCH_UNCONFIRMED",
      "the apply request was sent but no response arrived — the apply may have started; check get_update_status before doing anything else, and do not re-dispatch",
    );
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  // 202 = dispatched. Terminal success — see the fire-once header note.
  if (res.status === 202) {
    return {
      ok: true,
      data: {
        type: "apply_update",
        started: true,
        deviceUpdateId:
          typeof body.deviceUpdateId === "string" ? body.deviceUpdateId : null,
        note: "apply dispatched — services will restart; check get_update_status for progress",
      },
    };
  }

  const deferral = deferralOf(body);
  if (deferral) {
    const reason =
      typeof body.reason === "string" && body.reason.length > 0
        ? body.reason
        : deferral;
    return toolError(
      "APPLY_DEFERRED",
      `the update system deferred the apply — ${reason}`,
    );
  }

  if (res.status === 503) {
    const detail = typeof body.error === "string" ? body.error : "apply_unavailable";
    return toolError(
      "APPLY_UNAVAILABLE",
      `updates cannot be applied on this box — the server reported "${detail}" (apply is not provisioned here, e.g. a dev/CI box without the host compose socket)`,
    );
  }

  if (res.status === 409) {
    if (body.error === "apply_in_progress") {
      return toolError(
        "APPLY_IN_PROGRESS",
        "an update apply is already in progress — follow it with get_update_status",
      );
    }
    if (body.error === "nothing_pending") return NOTHING_PENDING;
  }

  return toolError(
    "APPLY_FAILED",
    `the apply could not be dispatched — orchestrator returned ${res.status}${
      typeof body.error === "string" ? ` (${body.error})` : ""
    }`,
  );
}

const tool: Tool = {
  name: "apply_update",
  description:
    "Apply the pending verified software update to the Droplet appliance (the server applies the single pending update — no version argument). HIGH IMPACT: services restart during the apply, and the assistant may go quiet for several minutes mid-apply — that is expected; follow progress with get_update_status. The update system verifies release signatures before applying and automatically rolls back to the previous version if the update fails its health checks. Two-step: the first call returns confirmation_required naming the pending version — relay it to the user, and only after they explicitly approve, approval is handled outside this conversation. Owner/admin only.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
