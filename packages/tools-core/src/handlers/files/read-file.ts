import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full path to the file to read." },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const MAX_TEXT_CHARS = 10000;

// WARP-1372: bytes sniffed when the content-type header doesn't declare a
// texty type. Mirrors the file-indexer's sniffer (watcher.py, WARP-1139).
const SNIFF_BYTES = 4096;

/**
 * WARP-1372 — is this undeclared content readable text? The download proxy
 * reports application/octet-stream for plainly-readable files (md/csv/txt),
 * so the header alone must never be grounds for refusal. UTF-8-decode a
 * bounded head: a NUL byte or a hard decode error away from the boundary
 * means genuinely binary; a multibyte char split at the very end is fine.
 */
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

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // TOOLS-03: read_file must enforce the SAME boundary the write
  // file-tools do — an authenticated Nextcloud session (userId+ncToken)
  // and `validateNcPath` traversal defense. Previously this tool ran
  // even with no token (leaning entirely on the Nextcloud sidecar for
  // authz) and never rejected `..`/null-byte/percent-encoded-traversal
  // at the tool boundary. read tools aren't in WRITE_TOOLS, so a
  // low-privilege role (family/guest) can reach them.
  if (!ctx.userId || !ctx.ncToken) {
    // The message is surfaced verbatim to the chat model, which relays it
    // to the user — say how to RECOVER, not just that auth is missing.
    // Sessions minted without a password (passkey/SSO), or whose stored
    // Nextcloud credential was lost (cache restart) or revoked (logout
    // elsewhere), can only be re-provisioned by a password sign-in.
    return {
      ok: false,
      status: "error",
      error: {
        code: "AUTH_REQUIRED",
        message:
          "File access isn't connected for this session. Ask the user to sign out of the Droplet dashboard and sign back in with their password — that reconnects file access and file tools will work again.",
      },
    };
  }
  const v = validateNcPath(args.path);
  if (!v.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_PATH", message: v.error },
    };
  }
  const path = v.path;
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.get(`/download?path=${encodeURIComponent(path)}`, { headers });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "READ_FAILED", message: `nextcloud returned ${res.status}` },
    };
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (
    contentType.includes("text") ||
    contentType.includes("json") ||
    contentType.includes("xml")
  ) {
    const text = await res.text();
    return { ok: true, data: { path, content: text.slice(0, MAX_TEXT_CHARS) } };
  }
  // WARP-1372: sniff only GENERIC/undeclared types — a specifically
  // declared binary type (image/png, application/pdf) is trusted as-is.
  const undeclared = contentType === "" || contentType.includes("octet-stream");
  if (undeclared) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sniffIsText(bytes)) {
      const text = new TextDecoder("utf-8").decode(bytes);
      return { ok: true, data: { path, content: text.slice(0, MAX_TEXT_CHARS) } };
    }
  }
  return {
    ok: true,
    data: { path, error: `Binary file (type: ${contentType}), cannot read as text` },
  };
}

const tool: Tool = {
  name: "read_file",
  description:
    "Read the text content of a file on the Droplet's Nextcloud. Returns up to 10,000 characters; binary files are rejected with an explanatory note. NOTE: files attached in chat live in brain memory, not here — use search_content for those.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
