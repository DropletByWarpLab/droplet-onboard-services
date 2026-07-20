/**
 * WARP-1426 — `summarize_file`: fetch a Nextcloud file (same boundary and
 * download call as `read_file`), then ask the orchestrator's completion
 * endpoint (`POST /api/llm/complete`) for a concise summary.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full path to the file to summarize." },
    focus: {
      type: "string",
      maxLength: 500,
      description: "Optional topic or question to emphasize in the summary.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const MAX_FOCUS_CHARS = 500;

/** Cap on the content sent to the completion endpoint — very large files
 *  are summarized from their first portion only. */
const MAX_SUMMARY_INPUT_CHARS = 24000;

// Same sniff parameters as read-file.ts (WARP-1372) — the download proxy
// reports application/octet-stream for plainly-readable files (md/csv/txt),
// so the header alone must never be grounds for refusal. Duplicated here
// because read-file.ts only exports its tool, not the helper.
const SNIFF_BYTES = 4096;

function sniffIsText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Tolerate up to 3 trailing bytes of a char truncated by the sniff window.
  for (let trim = 0; trim <= 3 && trim < head.length; trim++) {
    try {
      decoder.decode(head.subarray(0, head.length - trim));
      return true;
    } catch {
      // Only a boundary truncation is forgivable — keep trimming; a decode
      // error that survives all trims is real binary content.
    }
  }
  return false;
}

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (typeof args.path !== "string" || args.path.length === 0) {
    return err("INVALID_ARGS", "path is required and must be a string");
  }
  if (args.focus !== undefined) {
    if (typeof args.focus !== "string") {
      return err("INVALID_ARGS", "focus must be a string");
    }
    if (args.focus.length > MAX_FOCUS_CHARS) {
      return err("INVALID_ARGS", `focus must be at most ${MAX_FOCUS_CHARS} characters`);
    }
  }
  const focus = args.focus as string | undefined;

  // ── Fetch phase: identical boundary + download call to read_file ──────
  // (TOOLS-03 auth gate, validateNcPath traversal defense, Nextcloud
  // sidecar download proxy, WARP-1372 octet-stream sniffing.)
  if (!ctx.userId || !ctx.ncToken) {
    return err(
      "AUTH_REQUIRED",
      "File access isn't connected for this session. Ask the user to sign out of the Droplet dashboard and sign back in with their password — that reconnects file access and file tools will work again.",
    );
  }
  const v = validateNcPath(args.path);
  if (!v.ok) {
    return err("INVALID_PATH", v.error);
  }
  const path = v.path;
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.get(`/download?path=${encodeURIComponent(path)}`, { headers });
  if (!res.ok) {
    return err("READ_FAILED", `nextcloud returned ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  let content: string | null = null;
  if (contentType.includes("text") || contentType.includes("json") || contentType.includes("xml")) {
    content = await res.text();
  } else if (contentType === "" || contentType.includes("octet-stream")) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sniffIsText(bytes)) content = new TextDecoder("utf-8").decode(bytes);
  }
  if (content === null) {
    return err("BINARY_FILE", `Binary file (type: ${contentType}), cannot summarize as text`);
  }
  if (content.trim().length === 0) {
    return err("EMPTY_FILE", "The file is empty — nothing to summarize.");
  }

  // ── Completion phase ──────────────────────────────────────────────────
  const truncated = content.length > MAX_SUMMARY_INPUT_CHARS;
  const text = truncated ? content.slice(0, MAX_SUMMARY_INPUT_CHARS) : content;
  let system =
    "Summarize the following file content. Produce a concise summary in plain language, leading with what the document is and then its key points. Never invent content that is not in the text.";
  if (focus) system += ` Emphasize anything related to: ${focus}.`;

  let llmRes: Response;
  try {
    llmRes = await ctx.http.orchestrator.post("/api/llm/complete", {
      system,
      text,
      temperature: 0.2,
      max_tokens: 1024,
    });
  } catch {
    return err("LLM_UNAVAILABLE", "The local AI is not reachable — try again shortly.");
  }
  if (!llmRes.ok) {
    return err("LLM_UNAVAILABLE", `completion endpoint returned ${llmRes.status}`);
  }
  let payload: { content?: unknown; model?: unknown };
  try {
    payload = (await llmRes.json()) as { content?: unknown; model?: unknown };
  } catch {
    return err("LLM_UNAVAILABLE", "completion endpoint returned a malformed response");
  }
  const summary = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!summary) {
    return err("EMPTY_SUMMARY", "The model returned an empty summary — try again.");
  }

  return {
    ok: true,
    data: {
      type: "summarize_file",
      path,
      summary,
      truncated,
      model: typeof payload.model === "string" ? payload.model : "",
    },
  };
}

const tool: Tool = {
  name: "summarize_file",
  description:
    "Read a file on the Droplet's Nextcloud and return a concise summary of its contents, optionally focused on a given topic. Very large files are summarized from their first portion only. Binary files cannot be summarized.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
