// WARP-2212 — create_word_document: render a titled document to .docx in the
// user's files. Same spec shape as create_pdf_report; python-docx produces a
// document that stays EDITABLE, which is the reason to pick this over PDF.
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
      description: "Full target path including filename; must end in .docx.",
    },
    title: {
      type: "string",
      description: "Document title, rendered as the top-level heading.",
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
  const v = validateDocPath(args.path, "docx");
  if (!v.ok) return v.error;
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  // The hop stays HERE rather than behind a helper: tool-routes.test.ts
  // parses this file for its ctx.http hops, and a swallowed request would
  // make the manifest row read as a lie.
  const res = await ctx.http.nextcloud.post(
    "/render",
    {
      path: v.path,
      format: "docx",
      title: typeof args.title === "string" ? args.title : "",
      body_markdown: typeof args.body_markdown === "string" ? args.body_markdown : "",
    },
    { headers: ncHeaders(ctx) },
  );
  return interpretRenderResponse(res, v.path);
}

const tool: Tool = {
  name: "create_word_document",
  description:
    "Write a Word (.docx) document into the user's files. Give `path` (ending in .docx), a `title`, and `body_markdown` for the content. Prefer this over create_pdf_report when the user will edit the result; the document opens in the dashboard's editor.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
