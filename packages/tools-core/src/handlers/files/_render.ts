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
import type { ToolContext, ToolResult } from "../../types.js";

export type DocFormat = "pdf" | "docx" | "xlsx";

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
export function interpretRenderResponse(
  res: { ok: boolean; status: number; data?: unknown },
  requestedPath: string,
): ToolResult {
  if (!res.ok) {
    const body = (res.data ?? {}) as { error?: string; path?: string };
    if (res.status === 409) {
      return err(
        "ALREADY_EXISTS",
        `a file already exists at ${body.path ?? requestedPath} — choose another name`,
      );
    }
    if (res.status === 400) {
      return err("INVALID_ARGS", body.error ?? "the document spec was rejected");
    }
    if (res.status === 413) {
      return err("TOO_LARGE", body.error ?? "the rendered document is too large");
    }
    if (res.status === 502) {
      return err("RENDERER_UNAVAILABLE", "the document renderer is not available");
    }
    return err("RENDER_FAILED", `render failed (${res.status})`);
  }

  const data = (res.data ?? {}) as Partial<RenderOk>;
  return {
    ok: true,
    data: {
      path: data.path ?? requestedPath,
      filename: data.filename ?? "",
      bytes: data.bytes ?? 0,
      mimeType: data.mimeType ?? "",
    },
  };
}

/** Shared description of the Markdown subset the renderers accept. */
export const BODY_MARKDOWN_DESCRIPTION =
  "Body content in a small Markdown subset: '# ', '## ', '### ' headings, " +
  "blank-line-separated paragraphs, '- ' bullet lists, '1. ' numbered lists, " +
  "GitHub-style pipe tables, and inline **bold** / *italic*. Anything else is " +
  "rendered as plain text.";
