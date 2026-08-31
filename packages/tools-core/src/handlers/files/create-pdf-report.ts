// WARP-2212 — create_pdf_report: render a titled report to PDF in the user's
// files. The model supplies a Markdown body; services/doc-render turns it into
// a paginated document with reportlab.
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  BODY_MARKDOWN_DESCRIPTION,
  err,
  interpretRenderResponse,
  ncHeaders,
  validateDocPath,
} from "./_render.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Full target path including filename; must end in .pdf.",
    },
    title: {
      type: "string",
      description: "Report title, rendered as the document's heading.",
    },
    body_markdown: {
      type: "string",
      description: BODY_MARKDOWN_DESCRIPTION,
    },
  },
  required: ["path", "title"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const v = validateDocPath(args.path, "pdf");
  if (!v.ok) return v.error;
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  // The hop stays HERE rather than behind a helper: tool-routes.test.ts
  // parses this file for its ctx.http hops, and a swallowed request would
  // make the manifest row read as a lie.
  const res = await ctx.http.nextcloud.post(
    "/render",
    {
      path: v.path,
      format: "pdf",
      title: typeof args.title === "string" ? args.title : "",
      body_markdown: typeof args.body_markdown === "string" ? args.body_markdown : "",
    },
    { headers: ncHeaders(ctx) },
  );
  return interpretRenderResponse(res, v.path);
}

const tool: Tool = {
  name: "create_pdf_report",
  description:
    "Write a PDF report into the user's files. Give `path` (ending in .pdf), a `title`, and `body_markdown` for the content. Use this when the user asks for a PDF, a report, or something to print or send.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
