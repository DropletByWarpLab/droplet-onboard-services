// WARP-2212 — create_spreadsheet: render tabular data to .xlsx in the user's
// files. openpyxl writes a real workbook, so the result is sortable and
// formula-ready rather than a table picture.
//
// The spec is rows-and-columns rather than Markdown because a spreadsheet's
// content IS its grid: routing it through a prose format would lose the cell
// types that make the file worth producing. Numbers and booleans stay native;
// nothing is coerced (see `_cell` in services/doc-render/renderers.py — a zip
// code keeps its leading zero).
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, interpretRenderResponse, ncHeaders, validateDocPath } from "./_render.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "New .xlsx file path.",
    },
    sheets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "Header row.",
          },
          rows: {
            type: "array",
            items: { type: "array", items: {} },
            description: "Typed values; strings stay text.",
          },
          formulas: {
            type: "array",
            items: {
              type: "object",
              properties: { cell: { type: "string" }, expression: { type: "string" } },
              required: ["cell", "expression"],
              additionalProperties: false,
            },
            description: "Existing cell formulas: arithmetic, SUM/AVERAGE/MIN/MAX/COUNT/ROUND/ABS; local references only.",
          },
          chart: {
            type: "object",
            properties: {
              title: { type: "string" },
              kind: { type: "string", description: "bar or line" },
              category_column: { type: "integer" },
              value_column: { type: "integer" },
            },
            required: ["kind", "category_column", "value_column"],
            additionalProperties: false,
            description: "1-based columns; all data rows.",
          },
        },
        required: ["columns", "rows"],
        additionalProperties: false,
      },
    },
  },
  required: ["path", "sheets"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const v = validateDocPath(args.path, "xlsx");
  if (!v.ok) return v.error;
  if (!Array.isArray(args.sheets) || args.sheets.length === 0) {
    return err("INVALID_ARGS", "sheets must be a non-empty array");
  }
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  // The hop stays HERE rather than behind a helper: tool-routes.test.ts parses
  // this file for its ctx.http hops, and a swallowed request would make the
  // manifest row read as a lie.
  const res = await ctx.http.nextcloud.post(
    "/render",
    { path: v.path, format: "xlsx", sheets: args.sheets },
    { headers: ncHeaders(ctx) },
  );
  return interpretRenderResponse(res, v.path);
}

const tool: Tool = {
  name: "create_spreadsheet",
  description:
    "Create Excel with optional formulas (recalculate on open) and chart; refuses overwrite.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
