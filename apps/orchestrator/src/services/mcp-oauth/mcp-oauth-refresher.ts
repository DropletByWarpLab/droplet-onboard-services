/**
 * WARP-2409 — the seam between dispatch (which needs a fresh token) and the
 * refresh job (WARP-2416, which owns single-flight refresh). Dispatch depends
 * on this port only; the refresh service registers itself at boot. With none
 * registered, dispatch uses a held token until it has actually expired and
 * then asks the person to sign in again.
 */
export type McpOAuthRefreshOutcome = "refreshed" | "needs_reconnect" | "unavailable";

export interface McpOAuthRefresher {
  /** Refresh one connection now (shared with the cron tick, single-flight per id). */
  refreshNow(connectionId: string): Promise<McpOAuthRefreshOutcome>;
}

let current: McpOAuthRefresher | null = null;

export function registerMcpOAuthRefresher(r: McpOAuthRefresher | null): void {
  current = r;
}

export function mcpOAuthRefresher(): McpOAuthRefresher | null {
  return current;
}
