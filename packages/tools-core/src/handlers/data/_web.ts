import type { ToolResult } from "../../types.js";

export async function webResult(route: "search" | "fetch", response: Response): Promise<ToolResult> {
  try {
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof data.error === "string" ? data.error.toUpperCase() : "WEB_UNAVAILABLE";
      const message = code === "EGRESS_DISABLED" ? "Enable Web fetch/search in the dashboard off-LAN settings to use public web sources." : code === "SEARCH_NOT_CONFIGURED" ? "An operator must provision BRAVE_SEARCH_API_KEY on the screened web-fetch service." : "Screened web request failed: " + code.toLowerCase();
      return { ok: false, status: "error", error: { code, message } };
    }
    return { ok: true, data: { type: `web_${route}`, ...data } };
  } catch { return { ok: false, status: "error", error: { code: "WEB_UNAVAILABLE", message: "The screened web service is unreachable or timed out." } }; }
}
