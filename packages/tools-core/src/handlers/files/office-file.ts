import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { fileMediaFromPath } from "@droplet/shared-types";
import { validateNcPath } from "./_paths.js";
import { err, ncHeaders } from "./_render.js";

const inputSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "inspect (default) or revise." },
    source_path: { type: "string", description: "DOCX/XLSX/PPTX File Store path; exactly one source_path or item_id." },
    item_id: { type: "string", description: "Owned chat attachment ID." },
    path: { type: "string", description: "For revise: new personal-root filename, same Office extension. Original stays unchanged." },
    changes: { type: "object", properties: {
      cells: { type: "array", items: { type: "object" }, description: "XLSX: [{sheet,cell,value}]; existing A1 cells only; JSON scalars, strings are literal." },
      text: { type: "array", items: { type: "object" }, description: "DOCX/PPTX: [{id,text}]; paragraph IDs from inspect; first text-run style retained." },
    }, additionalProperties: false, description: "Revise only: 1–200 edits, 1 MiB total. Inspect first; truncated inspection is incomplete." },
  },
  additionalProperties: false,
} as const;
const MIME: Record<string, string> = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "Sign in to inspect or revise Office files.");
  const action = args.action ?? "inspect";
  if (action !== "inspect" && action !== "revise") return err("INVALID_ARGS", "action must be inspect or revise.");
  if (Boolean(args.source_path) === Boolean(args.item_id)) return err("INVALID_ARGS", "Provide exactly one source_path or item_id.");
  const payload: Record<string, unknown> = { action };
  if (args.source_path !== undefined) {
    const source = validateNcPath(args.source_path);
    if (!source.ok || source.trailingSlash || !/\.(docx|xlsx|pptx)$/i.test(source.path)) return err("INVALID_PATH", "source_path must name an Office file without traversal.");
    payload.source_path = source.path;
  } else {
    if (typeof args.item_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(args.item_id)) return err("INVALID_ARGS", "item_id must name an owned chat attachment.");
    payload.item_id = args.item_id;
  }
  if ((args.source_path !== undefined || action === "revise") && !ctx.ncToken) return err("AUTH_REQUIRED", "File access is disconnected.");
  if (action === "inspect") {
    if (args.path !== undefined || args.changes !== undefined) return err("INVALID_ARGS", "Inspection accepts no destination or revision operations.");
  } else {
    if (typeof args.path !== "string" || args.path.length > 255 || !/^\/[^/\\%\x00-\x1f\x7f]+\.(docx|xlsx|pptx)$/i.test(args.path) || /[\p{Cf}\p{Cs}]/u.test(args.path)) return err("INVALID_PATH", "path must be a new personal-root Office filename.");
    if (typeof payload.source_path === "string" && (args.path.toLowerCase() === payload.source_path.toLowerCase() || args.path.split(".").pop()?.toLowerCase() !== payload.source_path.split(".").pop()?.toLowerCase())) return err("INVALID_PATH", "Revision needs a new filename with the source Office extension.");
    if (!args.changes || typeof args.changes !== "object" || Array.isArray(args.changes)) return err("INVALID_ARGS", "changes must contain cell or text edits from inspection.");
    const changes = args.changes as Record<string, unknown>;
    if (Object.keys(changes).some((key) => key !== "cells" && key !== "text") || Boolean(changes.cells) === Boolean(changes.text)) return err("INVALID_ARGS", "changes must contain exactly one cells or text list.");
    const operations = changes.cells ?? changes.text;
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 200 || operations.some((op) => !op || typeof op !== "object" || Array.isArray(op))) return err("INVALID_ARGS", "Office revision needs 1–200 edit operations.");
    if (Buffer.byteLength(JSON.stringify(changes), "utf8") > 1_048_576) return err("TOO_LARGE", "Office revision operations exceed 1 MiB. Use fewer edits or smaller replacement values.");
    payload.path = args.path; payload.changes = changes;
  }
  const res = await ctx.http.nextcloud.post("/office", payload, { headers: ncHeaders(ctx), signal: ctx.signal });
  const value: unknown = await res.json().catch(() => null);
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (!res.ok) return err(res.status === 409 ? "ALREADY_EXISTS" : res.status === 401 || res.status === 403 ? "AUTH_REQUIRED" : res.status === 404 ? "NOT_FOUND" : res.status === 400 ? "INVALID_FILE" : res.status === 413 ? "TOO_LARGE" : res.status === 408 ? "TIMEOUT" : res.status === 429 ? "OFFICE_BUSY" : "OFFICE_UNAVAILABLE", typeof body.error === "string" ? body.error : `Office processing failed (${res.status}).`);
  if (action === "inspect") {
    if (body.action !== "inspect" || typeof body.format !== "string" || !MIME[body.format] || typeof body.totalItems !== "number" || !Number.isInteger(body.totalItems) || body.totalItems < 0 || typeof body.returnedItems !== "number" || !Number.isInteger(body.returnedItems) || body.returnedItems < 0 || body.returnedItems > 200 || body.returnedItems > body.totalItems || typeof body.truncated !== "boolean" || body.format === "xlsx" && !Array.isArray(body.sheets) || body.format !== "xlsx" && !Array.isArray(body.paragraphs)) return err("OFFICE_UNAVAILABLE", "Office processing returned no valid inspection.");
    return { ok: true, data: { action, format: body.format, source: body.source, totalItems: body.totalItems, returnedItems: body.returnedItems, truncated: body.truncated, ...(body.format === "xlsx" ? { sheets: body.sheets } : { paragraphs: body.paragraphs }), warnings: Array.isArray(body.warnings) ? body.warnings : [] } };
  }
  const format = (payload.path as string).split(".").pop()!.toLowerCase();
  if (body.action !== "revise" || body.path !== payload.path || body.format !== format || body.filename !== (payload.path as string).slice(1) || body.mimeType !== MIME[format] || typeof body.bytes !== "number" || !Number.isInteger(body.bytes) || body.bytes < 22 || body.bytes > 10 * 1024 * 1024) return err("OFFICE_UNAVAILABLE", "Office processing returned no valid saved-file metadata.");
  return { ok: true, data: { action, format, path: body.path, filename: body.filename, bytes: body.bytes, mimeType: body.mimeType, warnings: Array.isArray(body.warnings) ? body.warnings : [], media: fileMediaFromPath(body.path as string, { name: body.filename as string, mimeType: body.mimeType as string, size: body.bytes }) } };
}
const tool: Tool = {
  name: "office_file",
  description: "Inspect Office structure and text, then revise XLSX cells or DOCX/PPTX paragraphs into a new copy while preserving native formatting, charts and assets. Refuses active/external content.",
  inputSchema, requiresWrite: true, requiresConfirmation: false, handler,
};
export default tool;
