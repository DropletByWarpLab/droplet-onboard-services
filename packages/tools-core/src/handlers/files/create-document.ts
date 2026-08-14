// WARP-1458 — create_document: seed a new empty Word (.docx) or
// spreadsheet (.xlsx) file in the user's files. The file opens in the
// dashboard's Files app (in-browser editing when the docs engine is
// enabled); this tool only creates the empty document — content goes in
// via the editor.
//
// The seeds are embedded base64 constants so the runtime does zero zip
// work. Each is a minimal valid OOXML package built as a ZIP with STORED
// (uncompressed) entries only — valid per the PKZIP appnote and fully
// deterministic (fixed 1980-01-01 00:00 DOS timestamps, fixed entry
// order, no extra fields). Generated once with a throwaway Node script
// (inline zip writer: local file headers + central directory + EOCD,
// CRC-32 over each part's UTF-8 bytes) and pinned by sha256 in
// __tests__/handlers/files/create-document.test.ts. Regenerating means
// rebuilding with the same recipe and updating the pins.
//
// Package structure:
//   .docx: [Content_Types].xml, _rels/.rels,
//          word/document.xml            (empty <w:body> with one <w:p/>)
//   .xlsx: [Content_Types].xml, _rels/.rels,
//          xl/workbook.xml              (one sheet "Sheet1"),
//          xl/_rels/workbook.xml.rels,
//          xl/worksheets/sheet1.xml     (empty <sheetData/>)
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

/** Minimal empty Word document (1244 bytes decoded). */
export const DOCX_TEMPLATE_BASE64 =
  "UEsDBBQAAAAAAAAAIQB5bjPXrQEAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAAAAACEAm/036ikBAAApAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAIQCZCVxZrgAAAK4AAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnAvPjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAAUAAAAAAAAACEAeW4z160BAACtAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAIQCb/TfqKQEAACkBAAALAAAAAAAAAAAAAAAAAN4BAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAIQCZCVxZrgAAAK4AAAARAAAAAAAAAAAAAAAAADADAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAANBAAAAAA=";

/** Minimal empty spreadsheet (2179 bytes decoded). */
export const XLSX_TEMPLATE_BASE64 =
  "UEsDBBQAAAAAAAAAIQBuYbgNLQIAAC0CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtib29rLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0Lm1haW4reG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvd29ya3NoZWV0cy9zaGVldDEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwud29ya3NoZWV0K3htbCIvPjwvVHlwZXM+UEsDBBQAAAAAAAAAIQCY2uuLJwEAACcBAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAIQCdbEO9GwEAABsBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pjx3b3JrYm9vayB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIiB4bWxuczpyPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzIj48c2hlZXRzPjxzaGVldCBuYW1lPSJTaGVldDEiIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAACEAWv2CaygBAAAoAQAAGgAAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvd29ya3NoZWV0IiBUYXJnZXQ9IndvcmtzaGVldHMvc2hlZXQxLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAhAJ6MqE6cAAAAnAAAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHdvcmtzaGVldCB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIj48c2hlZXREYXRhLz48L3dvcmtzaGVldD5QSwECFAAUAAAAAAAAACEAbmG4DS0CAAAtAgAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAIQCY2uuLJwEAACcBAAALAAAAAAAAAAAAAAAAAF4CAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAIQCdbEO9GwEAABsBAAAPAAAAAAAAAAAAAAAAAK4DAAB4bC93b3JrYm9vay54bWxQSwECFAAUAAAAAAAAACEAWv2CaygBAAAoAQAAGgAAAAAAAAAAAAAAAAD2BAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAAUAAAAAAAAACEAnoyoTpwAAACcAAAAGAAAAAAAAAAAAAAAAABWBgAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAAFAAUARQEAACgHAAAAAA==";

const TEMPLATES: Record<"docx" | "xlsx", string> = {
  docx: DOCX_TEMPLATE_BASE64,
  xlsx: XLSX_TEMPLATE_BASE64,
};

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Full target path including filename; must end in .docx or .xlsx.",
    },
    kind: {
      type: "string",
      enum: ["docx", "xlsx"],
      description:
        "Document kind. Optional — inferred from the path extension; when given it must match.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "auth_required");
  const v = validateNcPath(args.path);
  if (!v.ok) return err("INVALID_PATH", v.error);

  const filename = path.posix.basename(v.path);
  if (!filename) return err("INVALID_PATH", "path must include a filename");

  const ext = /\.docx$/i.test(filename)
    ? ("docx" as const)
    : /\.xlsx$/i.test(filename)
      ? ("xlsx" as const)
      : null;
  if (!ext) return err("INVALID_ARGS", "path must end in .docx or .xlsx");

  if (args.kind !== undefined) {
    if (args.kind !== "docx" && args.kind !== "xlsx") {
      return err("INVALID_ARGS", 'kind must be "docx" or "xlsx"');
    }
    if (args.kind !== ext) {
      return err(
        "INVALID_ARGS",
        `kind "${args.kind}" does not match the ".${ext}" extension in path`,
      );
    }
  }

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };

  // Overwrite protection. The /upload contract has no no-overwrite mode
  // (it PUTs through to WebDAV), so probe the authoritative /download
  // endpoint first — the directory listing rides a cache and could serve
  // a stale "absent". 200 → the file exists, refuse; 404 → clear to
  // create; anything else → fail closed rather than risk clobbering.
  // (A check-then-write race window remains, but a plain create tool has
  // no atomic primitive to close it with on this API.)
  const probe = await ctx.http.nextcloud.get(
    `/download?path=${encodeURIComponent(v.path)}`,
    { headers },
  );
  if (probe.ok) {
    return err(
      "FILE_EXISTS",
      `a file already exists at ${v.path} — delete it first or choose another path`,
    );
  }
  if (probe.status !== 404) {
    return err("WRITE_FAILED", `existence pre-check failed: nextcloud returned ${probe.status}`);
  }

  const dir = path.posix.dirname(v.path) || "/";
  const res = await ctx.http.nextcloud.post(
    "/upload",
    { dir, filename, contentBase64: TEMPLATES[ext] },
    { headers },
  );
  if (!res.ok) {
    return err("WRITE_FAILED", `nextcloud returned ${res.status}`);
  }
  return {
    ok: true,
    data: { type: "create_document", path: v.path, kind: ext, created: true },
  };
}

const tool: Tool = {
  name: "create_document",
  description:
    "Create a new empty Word (.docx) or spreadsheet (.xlsx) file in the user's files. It opens in the dashboard's Files app (OnlyOffice editing when the docs engine is enabled); content goes in via the editor — this tool only creates the file. Fails with FILE_EXISTS instead of overwriting.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
