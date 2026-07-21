/**
 * WARP-1443 — `list_threat_events` LLM tool.
 *
 * Recent security-relevant events from the signed activity log: the
 * `network` and `auth` kinds of `GET /api/activity` (routes/activity.ts),
 * curated to severity warn/error. That predicate includes the WARP-268
 * egress-anomaly rows (kind `network`, severity `warn`, sub
 * `unlisted_destination` / `allowlist_unavailable`, refs from the
 * egress-audit collector) — the rows a "has anything phoned home?"
 * question is really about.
 *
 * ROLE GATE (WARP-845 / WARP-1443): only `ctx.role` owner or admin may
 * proceed — the ROLE_RANK ladder mirrors handlers/memory/recall.ts.
 * The orchestrator's /api/activity route is owner/admin-gated too, but
 * it only ever sees the mcp-server's SERVICE principal on this call
 * path, so the route's own guard says nothing about the human in the
 * chat. THIS check is the human-role defense: family/guest (and absent
 * role → guest view) get FORBIDDEN before any HTTP leaves the handler.
 *
 * The route has no severity filter, so each kind is fetched at the
 * route's page cap (200) and curated client-side — otherwise warn/error
 * rows buried under routine info rows would be silently missed.
 * Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** WARP-845 — audience ladder (same table as handlers/memory/recall.ts). */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1,
  guest: 0,
};
const ADMIN_RANK = 2;

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** GET /api/activity's `limit` cap (listQuerySchema in routes/activity.ts). */
const ROUTE_PAGE_MAX = 200;

/** The two activity kinds that carry threat signal. */
const THREAT_KINDS = ["network", "auth"] as const;
const THREAT_SEVERITIES = new Set(["warn", "error"]);

interface ActivityItem {
  at: string;
  severity: string;
  what: string;
  sub: string | null;
  kind: string;
  refs: unknown;
}

const inputSchema = {
  type: "object",
  properties: {
    hours: {
      type: "integer",
      minimum: 1,
      maximum: MAX_HOURS,
      description: `Look-back window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS} = 7 days).`,
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Max events to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    },
  },
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: { code: "INVALID_ARGS", message },
  };
}

function activityUnavailable(detail: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "ACTIVITY_UNAVAILABLE",
      message: `the activity log is not available — ${detail}`,
    },
  };
}

/** Thrown internally to carry the unavailability detail out of fetchKind. */
class ActivityUnavailableError extends Error {}

async function fetchKind(
  ctx: ToolContext,
  kind: (typeof THREAT_KINDS)[number],
  from: string,
): Promise<ActivityItem[]> {
  const res = await ctx.http.orchestrator.get("/api/activity", {
    params: { kind, from, limit: ROUTE_PAGE_MAX },
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new ActivityUnavailableError(`orchestrator returned ${res.status}`);
  }
  const payload = (await res.json()) as { items?: unknown };
  if (!Array.isArray(payload.items)) {
    throw new ActivityUnavailableError(
      "orchestrator returned an unexpected shape",
    );
  }
  return payload.items as ActivityItem[];
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Role gate FIRST — see the header comment. Absent role → guest view.
  if ((ROLE_RANK[ctx.role ?? ""] ?? 0) < ADMIN_RANK) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: "threat events are visible to owners and admins only",
      },
    };
  }

  let hours = DEFAULT_HOURS;
  if (args.hours !== undefined) {
    if (
      typeof args.hours !== "number" ||
      !Number.isInteger(args.hours) ||
      args.hours < 1 ||
      args.hours > MAX_HOURS
    ) {
      return invalidArgs(`hours must be an integer between 1 and ${MAX_HOURS}`);
    }
    hours = args.hours;
  }
  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > MAX_LIMIT
    ) {
      return invalidArgs(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    limit = args.limit;
  }

  const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let items: ActivityItem[];
  try {
    // One call per kind (the route filters a single kind at a time).
    const perKind = await Promise.all(
      THREAT_KINDS.map((kind) => fetchKind(ctx, kind, from)),
    );
    items = perKind.flat();
  } catch (err) {
    return activityUnavailable(
      err instanceof ActivityUnavailableError
        ? err.message
        : "orchestrator not reachable",
    );
  }

  const events = items
    .filter((r) => THREAT_SEVERITIES.has(r.severity))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit)
    .map((r) => ({
      at: r.at,
      kind: r.kind,
      severity: r.severity,
      summary: r.what,
      ...(r.sub !== null && r.sub !== undefined ? { sub: r.sub } : {}),
      ...(r.refs !== null && r.refs !== undefined ? { refs: r.refs } : {}),
    }));

  return {
    ok: true,
    data: {
      type: "list_threat_events",
      events,
      count: events.length,
      windowHours: hours,
    },
  };
}

const tool: Tool = {
  name: "list_threat_events",
  description:
    'Recent security-relevant events from the tamper-evident activity log: auth failures/denials and network threat rows, including egress anomalies (a service trying to reach an unlisted destination). Owner/admin only — other roles get FORBIDDEN. Use for "any threats?", "did anything phone home?", or "any failed logins?" questions. Defaults to the last 24 hours (max 168 = 7 days). Tier-1 read; safe to call without operator confirmation.',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
