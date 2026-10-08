/**
 * WARP-3904 — `disconnect_connection` LLM tool.
 *
 * Removes one connected service: `POST /api/connections/disconnect` with
 * `{ id }` for a row id from `list_connections` ("integration:mailchimp",
 * "google:me", "mailbox:<accountId>") or `{ provider }` for a friendly name
 * the route resolves ("our mailchimp"). The route enforces its own role guard
 * (box-wide rows need owner or admin) and purges the stored key or token.
 *
 * Write tier + interceptor-owned confirmation, like `email_send`: the
 * dispatch interceptor asks the person before this handler runs, so the
 * handler has no `confirmed` flag and no prompt of its own. The description is
 * what the approval card shows (WARP-3344), so it is one short human sentence.
 *
 * `precheck` (WARP-3349) refuses a call that can never succeed, such as a
 * missing target or a role the route would refuse, BEFORE the person is asked
 * to approve it. It reads nothing and makes no HTTP call.
 */
import { parseConnectionDisconnected } from "@droplet/shared-types";
import type { PrecheckRefusal, Tool, ToolContext, ToolResult } from "../../types.js";
import { actingHeaders, fail, gate, httpFailure, isRecord, readJson } from "./_common.js";

/** A `ConnectionRow.id` is `<family>:<provider-or-record-id>`, 160 characters at most. */
const MAX_CONNECTION_CHARS = 160;
const CONNECTION_ID_RE = /^[a-z0-9]+:[A-Za-z0-9_-]+$/;

const inputSchema = {
  type: "object",
  properties: {
    connection: {
      type: "string",
      description:
        'Exact id from list_connections, or a service name.',
    },
  },
  required: ["connection"],
  additionalProperties: false,
} as const;

/** Everything decidable without the network: who is asking, and what for. */
function validate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { ok: true; connection: string } | PrecheckRefusal {
  const refused = gate(ctx);
  if (refused) return refused;
  const connection = typeof args.connection === "string" ? args.connection.trim() : "";
  if (connection.length === 0) {
    return fail("INVALID_ARGS", "connection is required: a connection id from list_connections, or the service name");
  }
  if (connection.length > MAX_CONNECTION_CHARS) {
    return fail("INVALID_ARGS", `connection must be ${MAX_CONNECTION_CHARS} characters or fewer`);
  }
  return { ok: true, connection };
}

async function precheck(args: Record<string, unknown>, ctx: ToolContext): Promise<PrecheckRefusal | null> {
  const v = validate(args, ctx);
  return v.ok ? null : v;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const v = validate(args, ctx);
  if (!v.ok) return v;

  // An id names one row exactly; anything else is a name the route resolves.
  const body = CONNECTION_ID_RE.test(v.connection) ? { id: v.connection } : { provider: v.connection };
  const res = await ctx.http.orchestrator.post("/api/connections/disconnect", body, {
    headers: actingHeaders(ctx),
  });

  if (res.status === 404) {
    return fail("NOT_FOUND", "No connected service matches that. Call list_connections to see what is connected.");
  }
  if (res.status === 400) {
    return fail("INVALID_ARGS", "That connection was not understood. Call list_connections for the exact id.");
  }
  if (!res.ok) {
    return httpFailure(
      res.status,
      "DISCONNECT_FAILED",
      "Droplet could not disconnect that service",
      "Show connections here in this chat to check its status before trying again.",
    );
  }

  const payload = await readJson(res);
  const disconnected = parseConnectionDisconnected(isRecord(payload) ? payload.disconnected : null);
  if (!disconnected) {
    // The route answered 2xx, so the disconnect probably happened. Say so
    // rather than let the model report a failure and retry.
    return fail(
      "INTERNAL",
      "Droplet may have disconnected it, but the reply could not be read. Show connections here in this chat to check before trying again.",
    );
  }
  return { ok: true, data: disconnected };
}

const tool: Tool = {
  name: "disconnect_connection",
  description:
    "Disconnect a service and remove its saved access. Personal accounts, mailboxes and calendars delete local archives; catalog integration records stay.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  precheck,
  handler,
};

export default tool;
