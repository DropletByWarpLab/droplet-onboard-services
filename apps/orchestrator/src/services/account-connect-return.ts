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
