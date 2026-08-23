/**
 * WARP-1450 — `get_update_status` LLM tool.
 *
 * Software-update status over the orchestrator's
 * `GET /api/updates/status` (routes/updates.ts, WARP-540): the
 * currently-running committed release, the pending/in-flight
 * DeviceUpdate row, the last terminal verdict (incl. the
 * `degraded_health` signal), the WARP-538 operator settings, and
 * whether apply is provisioned on this box. The companion read to
 * `apply_update` — it is the ONLY progress cursor once an apply has
 * been dispatched.
 *
 * ROLE GATE (WARP-845 / WARP-1450): only `ctx.role` owner or admin may
 * proceed — the ROLE_RANK ladder mirrors
 * handlers/network/list-threat-events.ts. The updates routes are
 * owner/admin-gated too, but on this call path they only ever see the
 * mcp-server's SERVICE principal, so the route guard says nothing
 * about the human in the chat. THIS check is the human-role defense:
 * family/guest (and absent role → guest view) get FORBIDDEN before any
 * HTTP leaves the handler.
 *
 * Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

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
 *  in routes/updates.ts — never manifestJson). Dates arrive as ISO
 *  strings over JSON. */
interface UpdateRowView {
  id: string;
  status: string;
  channel: string;
  releaseTag: string | null;
  gitSha: string;
  builtAt: string;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StatusPayload {
  current?: UpdateRowView | null;
  pending?: UpdateRowView | null;
  lastVerdict?: UpdateRowView | null;
  degraded?: boolean;
  settings?: {
    channel?: string;
    applyWindowCron?: string;
    autoApply?: boolean;
  } | null;
  applyAvailable?: boolean;
  updateSourceAuthenticated?: boolean;
}

/** Prisma's DeviceUpdateStatus enum → a phase the user understands. */
const PHASE: Record<string, string> = {
  pending: "pending — a verified update is ready to apply",
  superseded: "superseded — replaced by a newer release or skipped by the operator",
  verifying: "verifying — the update is being downloaded and its signatures checked",
  applying: "applying — services are restarting; the assistant may be briefly unavailable",
  committed: "committed — the update was applied and the system is healthy",
  rolled_back: "rolled back — the update failed and the previous version was restored",
  failed: "failed — the update could not be applied",
  rejected: "rejected — the release failed signature verification and was not applied",
};

function phaseFor(status: string): string {
  return PHASE[status] ?? status;
}

/** Same version label the route uses in activity rows: the release tag
 *  when the manifest carried one, else the short git SHA. */
function versionLabel(row: UpdateRowView): string {
  return row.releaseTag ?? row.gitSha.slice(0, 10);
}

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Role gate FIRST — see the header comment. Absent role → guest view.
  if ((ROLE_RANK[ctx.role ?? ""] ?? 0) < ADMIN_RANK) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: "software-update status is visible to owners and admins only",
      },
    };
  }

  let res: Response;
  try {
    res = await ctx.http.orchestrator.get("/api/updates/status", {
      headers: { Accept: "application/json" },
    });
  } catch {
    return {
      ok: false,
      status: "error",
      error: {
        code: "STATUS_UNAVAILABLE",
        message: "update status is not available — orchestrator not reachable",
      },
    };
  }
  if (res.status === 403 || res.status === 451) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: `the orchestrator denied access to update status (${res.status})`,
      },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "STATUS_UNAVAILABLE",
        message: `update status is not available — orchestrator returned ${res.status}`,
      },
    };
  }

  const payload = (await res.json().catch(() => ({}))) as StatusPayload;
  const current = payload.current ?? null;
  const pending = payload.pending ?? null;
  const lastVerdict = payload.lastVerdict ?? null;
  const settings = payload.settings ?? null;

  return {
    ok: true,
    data: {
      type: "get_update_status",
      // "Currently running" = the newest committed OTA row; null means
      // the box has never OTA'd and runs its factory image.
      current: current
        ? {
            version: versionLabel(current),
            releaseTag: current.releaseTag,
            gitSha: current.gitSha,
            builtAt: current.builtAt,
            committedAt: current.updatedAt,
          }
        : null,
      ...(current
        ? {}
        : {
            currentNote:
              "no OTA update has been applied yet — the box is running its factory image",
          }),
      // The in-flight row (status pending | verifying | applying). A
      // status of `pending` means the release already passed cosign
      // verification (the poller only tracks rows post-verify), so its
      // createdAt is the verification timestamp.
      pending: pending
        ? {
            version: versionLabel(pending),
            releaseTag: pending.releaseTag,
            gitSha: pending.gitSha,
            builtAt: pending.builtAt,
            status: pending.status,
            phase: phaseFor(pending.status),
            verifiedAt: pending.createdAt,
          }
        : null,
      phase: pending
        ? phaseFor(pending.status)
        : "idle — no update is being verified or applied",
      lastVerdict: lastVerdict
        ? {
            version: versionLabel(lastVerdict),
            status: lastVerdict.status,
            phase: phaseFor(lastVerdict.status),
            failureReason: lastVerdict.failureReason,
            at: lastVerdict.updatedAt,
          }
        : null,
      // WARP-539's rollback-also-failed verdict — rollback did not
      // restore a healthy previous state.
      degraded: payload.degraded === true,
      applyAvailable: payload.applyAvailable === true,
      // WARP-2133: false ⇒ this box has no credential for the release
      // source, so "no pending update" means it CANNOT SEE releases, not
      // that it is current. Without this the assistant repeats the same
      // lie the dashboard used to tell.
      updateSourceAuthenticated: payload.updateSourceAuthenticated === true,
      settings: settings
        ? {
            channel: settings.channel,
            autoApply: settings.autoApply,
            applyWindowCron: settings.applyWindowCron,
          }
        : null,
    },
  };
}

const tool: Tool = {
  name: "get_update_status",
  description:
    "Software-update status of the Droplet appliance: the currently running version, any pending verified update, apply progress (with a human-readable phase), the last update verdict, and the update settings (channel / auto-apply). The companion to apply_update — use it to check whether an update is available and to follow progress after an apply is dispatched. Owner/admin only — other roles get FORBIDDEN. Tier-1 read; safe to call without operator confirmation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
