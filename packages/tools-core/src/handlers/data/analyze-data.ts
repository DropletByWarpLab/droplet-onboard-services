import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, ncHeaders } from "../files/_render.js";

const inputSchema = {
  type: "object",
  properties: {
    code: { type: "string", description: "Python: inputs dict; tables source/sheets/columns/rows; set JSON output; print logs. Only math/statistics/decimal/collections/itertools/json/re/datetime/textwrap. emit_csv(name.csv,columns,rows); emit_chart(name.svg,title,labels,values,kind='bar' or 'line'). No files/network/packages." },
    inputs: { type: "object", description: "Named JSON data (optional)." },
    sources: { type: "array", items: { type: "object", properties: { path: { type: "string" }, item_id: { type: "string" } }, additionalProperties: false }, description: "≤4 CSV/XLSX, ≤3 MiB total: one full File Store path or chat item_id each; first-row headers, XLSX cached values." },
  },
  required: ["code"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (typeof args.code !== "string" || !args.code.trim() || args.code.length > 64_000) return err("INVALID_ARGS", "code must be non-empty Python, at most 64000 characters.");
  if (!ctx.userId) return err("AUTH_REQUIRED", "Sign in to run data analysis.");
  const res = await ctx.http.nextcloud.post("/analyze", args, { headers: ncHeaders(ctx) });
  const data = await res.json().catch(() => null) as { error?: unknown } | null;
  if (!res.ok) {
    const message = typeof data?.error === "string" ? data.error : `Data analysis failed (${res.status}).`;
    return err(res.status === 503 ? "ANALYSIS_UNAVAILABLE" : res.status === 408 ? "TIMEOUT" : "ANALYSIS_FAILED", message);
  }
  if (!data || typeof data !== "object") return err("ANALYSIS_FAILED", "Data analysis returned no result.");
  return { ok: true, data };
}
const tool: Tool = {
  name: "analyze_data",
  description: "Bounded offline Python on JSON/CSV/XLSX; returns computed JSON/logs and optional new CSV/chart files.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};
export default tool;
