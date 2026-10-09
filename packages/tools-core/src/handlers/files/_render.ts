// WARP-2211/2212 — shared dispatch for the three document-generation tools.
//
// All three send a compact SPEC to the orchestrator's POST /api/files/render,
// which calls services/doc-render and uploads the result. The model never
// handles document bytes: it cannot: the box's window is 16384 tokens with a
// 4096-token output ceiling, and a minimum viable .xlsx is 2179 bytes of ZIP
// before a single cell of content.
//
// The hop goes through `ctx.http.nextcloud` — despite the name that client
// targets the orchestrator's own `/api/files` surface (FILES_API_URL,
// WARP-861) — carrying the caller's Nextcloud credentials as headers, exactly
// as `write_file` does. The render route reads them via getToken/getUser, so
// the document lands in the CALLER's storage, not a service account's.
import { fileMediaFromPath } from "@droplet/shared-types";
import type { ToolContext, ToolResult } from "../../types.js";

export type DocFormat = "pdf" | "docx" | "xlsx" | "pptx";

export function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/**
 * Validate the target path the same way for every format.
 *
 * The extension is the caller's declared intent, so a mismatch is refused
 * rather than corrected: silently renaming `report.txt` to `report.pdf` (or
 * writing PDF bytes under a .txt name) is the kind of guess this repo does
 * not make. The route re-checks all of this — this copy exists so the model
 * gets a precise, actionable error instead of a bare HTTP status.
 */
export function validateDocPath(raw: unknown, format: DocFormat): { ok: true; path: string } | { ok: false; error: ToolResult } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: err("INVALID_ARGS", "path is required") };
  }
  const path = raw.trim();
  const filename = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (!filename || filename === "." || filename === "..") {
    return { ok: false, error: err("INVALID_PATH", "path must include a filename") };
  }
  if (!filename.toLowerCase().endsWith(`.${format}`)) {
    return {
      ok: false,
      error: err("INVALID_ARGS", `path must end in .${format}`),
    };
  }
  return { ok: true, path };
}

interface RenderOk {
  path: string;
  filename: string;
  bytes: number;
  mimeType: string;
}

/**
 * The caller's Nextcloud credentials, which the render route reads via
 * getToken/getUser so the document lands in THEIR storage.
 */
export function ncHeaders(ctx: ToolContext): Record<string, string> {
  return {
    "X-Nextcloud-Token": ctx.ncToken ?? "",
    "X-Nextcloud-User": ctx.userId ?? "",
  };
}

/**
 * Normalize the route's outcome into a ToolResult.
 *
 * Deliberately NOT a wrapper that also makes the call: `tool-routes.test.ts`
 * parses each handler's SOURCE for its `ctx.http.<client>` hops, so a helper
 * that swallowed the request would make every one of these tools look like it
 * calls nothing — and the manifest row would read as a lie. Each handler owns
 * its visible hop; this owns only the interpretation.
 *
 * Refusals keep their own reasons rather than collapsing into one opaque
 * failure: a 409 means "that name is taken, pick another", which the model can
 * only act on if it is told.
 */
export async function interpretRenderResponse(
  res: Response,
  requestedPath: string,
): Promise<ToolResult> {
  const payload: unknown = await res.json().catch(() => null);
  const body = payload && typeof payload === "object" ? payload : {};
  if (!res.ok) {
    const failure = body as { error?: string; path?: string };
    if (res.status === 409) {
      return err(
        "ALREADY_EXISTS",
        `a file already exists at ${failure.path ?? requestedPath} — choose another name`,
      );
    }
    if (res.status === 400) {
      return err("INVALID_ARGS", failure.error ?? "the document spec was rejected");
    }
    if (res.status === 413) {
      return err("TOO_LARGE", failure.error ?? "the rendered document is too large");
    }
    if (res.status === 408) {
      return err("OUTCOME_UNKNOWN", "Creation was interrupted. Check the destination filename before retrying; a save may have completed.");
    }
    if (res.status === 502) {
      return err("RENDERER_UNAVAILABLE", "the document renderer is not available");
    }
    return err("RENDER_FAILED", `render failed (${res.status})`);
  }

  const data = body as Partial<RenderOk>;
  if (typeof data.path !== "string" || !data.path.startsWith("/") || data.path.length > 4096 || /[\u0000-\u001f\\]/.test(data.path) || data.path.split("/").some((part) => part === "." || part === "..") ||
      typeof data.filename !== "string" || !data.filename || data.filename.length > 255 || /[\u0000-\u001f]/.test(data.filename) ||
      typeof data.bytes !== "number" || !Number.isSafeInteger(data.bytes) || data.bytes <= 0 || typeof data.mimeType !== "string" || !data.mimeType) {
    return err("RENDER_FAILED", "the renderer returned no saved file metadata");
  }
  return {
    ok: true,
    data: {
      path: data.path ?? requestedPath,
      filename: data.filename ?? "",
      bytes: data.bytes ?? 0,
      mimeType: data.mimeType ?? "",
      media: fileMediaFromPath(data.path ?? requestedPath, {
        name: data.filename,
        mimeType: data.mimeType,
        size: data.bytes,
      }),
    },
  };
}

/** Shared description of the Markdown subset the renderers accept. */
export const BODY_MARKDOWN_DESCRIPTION =
  "Markdown: #/##/### headings, paragraphs, - bullets, 1. lists, pipe tables, **bold**, *italic*; other syntax is plain text.";
