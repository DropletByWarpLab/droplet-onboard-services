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
      description: "New .docx file path.",
    },
    title: {
      type: "string",
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
    "Create an editable Word document in the user's files; refuses overwrite.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
