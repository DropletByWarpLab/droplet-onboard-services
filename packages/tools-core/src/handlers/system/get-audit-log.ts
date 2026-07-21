/**
 * WARP-1450 — `get_audit_log` LLM tool.
 *
 * The household audit trail: what the AI and household members did —
 * tool calls, network changes, auth events, system actions — read from
 * the tamper-evident activity log via a SINGLE `GET /api/activity` call
 * (routes/activity.ts). Unlike `list_threat_events` (which multi-calls
 * per kind and curates severities), this is the GENERAL view: an
 * optional `kind` filter passes straight through, and rows come back in
 * the route's newest-first order untouched.
 *
 * ROLE GATE (WARP-845 / WARP-1450): only `ctx.role` owner or admin may
 * proceed — the ROLE_RANK ladder mirrors handlers/network/
 * list-threat-events.ts. The orchestrator's /api/activity route is
 * owner/admin-gated too, but on this call path it only ever sees the
 * mcp-server's SERVICE principal, so the route's guard says nothing
 * about the human in the chat. THIS check is the human-role defense:
 * family/guest (and absent role → guest view) get FORBIDDEN before any
 * HTTP leaves the handler.
 *
 * `refs` passthrough: rows carry collector payloads (`refs`) that can
 * reference other users' activity. They are forwarded UNMODIFIED — the
 * audience is owner/admin by the gate above, the same boundary the
 * dashboard's activity page already exposes them to (WARP-1450).
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
const MAX_HOURS = 720;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;

/** Mirrors routes/activity.ts ACTIVITY_KINDS verbatim. */
const ACTIVITY_KINDS = [
  "chat",
  "tool_call",
  "file",
  "camera",
  "network",
  "smart_home",
  "email",
  "auth",
  "tool_run",
  "system",
  "voice",
] as const;

/** The route's ActivityActorType minus "anonymous" — the agent-facing
 *  question is "was it a person, the AI, or the system?". */
const ACTOR_TYPES = ["user", "ai", "system"] as const;

interface ActivityItem {
  at: string;
  severity: string;
  what: string;
  kind: string;
  refs: unknown;
  actorType: string | null;
}

const inputSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ACTIVITY_KINDS,
      description: "Only events of this kind (omit for all kinds).",
    },
    actor: {
      type: "string",
      enum: ACTOR_TYPES,
      description:
        "Only events performed by this actor type: a household member (user), the AI, or the system itself.",
    },
    hours: {
      type: "integer",
      minimum: 1,
      maximum: MAX_HOURS,
      description: `Look-back window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS} = 30 days).`,
    },
    q: {
      type: "string",
      maxLength: MAX_QUERY_LENGTH,
      description: "Case-insensitive substring match on the event text.",
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
        message: "the audit log is visible to owners and admins only",
      },
    };
  }

  let kind: (typeof ACTIVITY_KINDS)[number] | undefined;
  if (args.kind !== undefined) {
    if (
      typeof args.kind !== "string" ||
      !(ACTIVITY_KINDS as readonly string[]).includes(args.kind)
    ) {
      return invalidArgs(`kind must be one of: ${ACTIVITY_KINDS.join(", ")}`);
    }
    kind = args.kind as (typeof ACTIVITY_KINDS)[number];
  }
  let actor: (typeof ACTOR_TYPES)[number] | undefined;
  if (args.actor !== undefined) {
    if (
      typeof args.actor !== "string" ||
      !(ACTOR_TYPES as readonly string[]).includes(args.actor)
    ) {
      return invalidArgs(`actor must be one of: ${ACTOR_TYPES.join(", ")}`);
    }
    actor = args.actor as (typeof ACTOR_TYPES)[number];
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
  let q: string | undefined;
  if (args.q !== undefined) {
    if (
      typeof args.q !== "string" ||
      args.q.length < 1 ||
      args.q.length > MAX_QUERY_LENGTH
    ) {
      return invalidArgs(
        `q must be a non-empty string of at most ${MAX_QUERY_LENGTH} characters`,
      );
    }
    q = args.q;
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

  let res: Response;
  try {
    res = await ctx.http.orchestrator.get("/api/activity", {
      params: {
        ...(kind !== undefined ? { kind } : {}),
        ...(actor !== undefined ? { actorType: actor } : {}),
        from,
        ...(q !== undefined ? { q } : {}),
        limit,
      },
      headers: { Accept: "application/json" },
    });
  } catch {
    return activityUnavailable("orchestrator not reachable");
  }
  if (!res.ok) {
    return activityUnavailable(`orchestrator returned ${res.status}`);
  }
  const payload = (await res.json()) as { items?: unknown };
  if (!Array.isArray(payload.items)) {
    return activityUnavailable("orchestrator returned an unexpected shape");
  }

  // Route order (newest first) preserved; `refs` forwarded unmodified —
  // see the header comment for the owner/admin audience rationale.
  const events = (payload.items as ActivityItem[]).map((r) => ({
    at: r.at,
    kind: r.kind,
    severity: r.severity,
    summary: r.what,
    ...(r.actorType !== null && r.actorType !== undefined
      ? { actorType: r.actorType }
      : {}),
    ...(r.refs !== null && r.refs !== undefined ? { refs: r.refs } : {}),
  }));

  return {
    ok: true,
    data: {
      type: "get_audit_log",
      events,
      count: events.length,
      windowHours: hours,
    },
  };
}

const tool: Tool = {
  name: "get_audit_log",
  description:
    'The household audit trail — what the AI and household members did (tool calls, network changes, auth events, system actions) from the tamper-evident activity log. Owner/admin only — other roles get FORBIDDEN. Filter by kind, actor (user/ai/system), or a free-text query. Use for "what did the AI do today?", "who changed the Wi-Fi?", or "show recent activity" questions. Defaults to the last 24 hours (max 720 = 30 days). Tier-1 read; safe to call without operator confirmation.',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
