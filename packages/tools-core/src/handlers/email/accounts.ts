import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Discover only the mailboxes the acting person may read; no credentials. */
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!["owner", "admin", "family"].includes(ctx.role ?? "")) {
    return { ok: false, status: "error", error: { code: "FORBIDDEN", message: "email accounts are available to owner, admin, and member roles only" } };
  }
  if (!ctx.userId) {
    return { ok: false, status: "error", error: { code: "AUTH_REQUIRED", message: "auth_required" } };
  }
  // The trusted MCP principal forwards a human identity. The route resolves
  // their canonical role and ownership before returning any mailbox IDs.
  const res = await ctx.http.orchestrator.get("/api/email/accounts", {
    headers: { Accept: "application/json", "X-Droplet-User": ctx.userId },
  });
  if (!res.ok) {
    return { ok: false, status: "error", error: { code: "EMAIL_ACCOUNTS_FAILED", message: `orchestrator returned ${res.status}` } };
  }
  const data = await res.json() as { accounts: Array<Record<string, unknown>> };
  // Deliberately omit userId, raw sync errors and any future connection fields.
  const accounts = data.accounts.map(account => ({
    id: account.id,
    address: account.address,
    displayName: account.displayName,
    authMode: account.authMode,
    canSend: account.authMode !== "M365_GRAPH" && account.canSend === true,
    imapStatus: account.imapStatus,
    lastIdleAt: account.lastIdleAt,
  }));
  return { ok: true, data: { type: "email_accounts", accountCount: accounts.length, accounts } };
}

const tool: Tool = {
  name: "email_accounts",
  description: "List readable mailbox IDs, addresses and import status. Use before email_search/read. Outlook imports are read-only (canSend=false); drafts stay local.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
