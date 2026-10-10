/** Fixed local destinations only; OAuth callback query parameters never choose a destination. */
export const ACCOUNT_CONNECT_RETURN_PATHS = ["/settings", "/setup", "/setup?step=accounts", "/chat"] as const;
export type AccountConnectReturnTo = typeof ACCOUNT_CONNECT_RETURN_PATHS[number];

export function accountConnectReturnTo(value: unknown): AccountConnectReturnTo {
  return (ACCOUNT_CONNECT_RETURN_PATHS as readonly unknown[]).includes(value)
    ? value as AccountConnectReturnTo
    : "/settings";
}

export function accountConnectOutcomeUrl(returnTo: AccountConnectReturnTo, provider: "google" | "m365", outcome: string): string {
  return `${returnTo}${returnTo.includes("?") ? "&" : "?"}${provider}=${outcome}`;
}

/** WARP-2405 — where a remote-MCP sign-in lands. A fixed list, like the one above. */
export const MCP_OAUTH_RETURN_PATHS = ["/settings", "/connectors/credentials"] as const;
export type McpOAuthReturnTo = typeof MCP_OAUTH_RETURN_PATHS[number];

/** `<destination>?mcp=<provider>:<outcome>`. `provider` is a registry id (null when the flow was never claimed). */
export function mcpOAuthOutcomeUrl(returnTo: McpOAuthReturnTo, provider: string | null, outcome: string): string {
  return `${returnTo}?mcp=${encodeURIComponent(provider ?? "unknown")}:${outcome}`;
}
