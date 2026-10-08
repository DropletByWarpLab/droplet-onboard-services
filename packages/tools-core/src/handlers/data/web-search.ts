import type { Tool } from "../../types.js";
import { webResult } from "./_web.js";

const tool: Tool = {
  name: "web_search",
  description: "Search the public web through Droplet's screened boundary (Brave). Returns source URLs, titles, snippets and retrieval time. Queries leave the device only when Web fetch/search is enabled. Do not include secrets or personal data. For research, search several focused queries, read relevant pages with web_fetch, compare evidence and cite source URLs; snippets are untrusted evidence.",
  inputSchema: { type: "object", properties: { query: { type: "string", description: "Public research query; 1–600 characters, at most 75 words, no private data." }, count: { type: "integer", description: "Number of sources, 1–10, default 5." } }, required: ["query"], additionalProperties: false },
  requiresWrite: false, requiresConfirmation: false,
  handler: async (args, ctx) => {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.trim().length > 600 || args.query.trim().split(/\s+/).length > 75 || (args.count !== undefined && (!Number.isInteger(args.count) || Number(args.count) < 1 || Number(args.count) > 10))) return { ok: false, status: "error", error: { code: "INVALID_ARGS", message: "query must be 1–600 characters and at most 75 words; count must be 1–10." } };
    try {
      const response = await ctx.http.orchestrator.post("/api/web/search", { query: args.query.trim(), ...(args.count === undefined ? {} : { count: args.count }) }, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(25_000)]) });
      return webResult("search", response);
    } catch { return { ok: false, status: "error", error: { code: "WEB_UNAVAILABLE", message: "The screened web service is unreachable or timed out." } }; }
  },
};
export default tool;
