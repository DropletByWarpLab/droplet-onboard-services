import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, interpretRenderResponse, ncHeaders, validateDocPath } from "./_render.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "New .pdf/.pptx path." },
    title: { type: "string" },
    theme: { type: "string", description: "droplet, light or dark" },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          subtitle: { type: "string" },
          columns: { type: "array", items: { type: "object" }, description: "Two {title?,bullets:string[]} columns." },
          table: { type: "object", description: "{headers:string[],rows:cell[][]}." },
          chart: { type: "object", description: "{kind:bar|line|pie,labels:string[],series:[{name,values:number[]}]}." },
          notes: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      description: "1-60 slides; one layout: bullets, columns, table or chart. Latin/Greek/Cyrillic text.",
    },
  },
  required: ["path", "title", "slides"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const format = typeof args.path === "string" && args.path.trim().toLowerCase().endsWith(".pptx")
    ? "pptx" : "pdf";
  const v = validateDocPath(args.path, format);
  if (!v.ok) return v.error;
  if (typeof args.title !== "string" || !Array.isArray(args.slides) || args.slides.length === 0) {
    return err("INVALID_ARGS", "title and a non-empty slides array are required");
  }
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  const res = await ctx.http.nextcloud.post(
    "/render",
    { path: v.path, format, title: args.title, slides: args.slides, ...(args.theme !== undefined ? { theme: args.theme } : {}) },
    { headers: ncHeaders(ctx) },
  );
  return interpretRenderResponse(res, v.path);
}

const tool: Tool = {
  name: "create_slide_deck",
  description: "Create a 16:9 PDF or editable PowerPoint deck. Call twice for both. Refuses overwrite.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
