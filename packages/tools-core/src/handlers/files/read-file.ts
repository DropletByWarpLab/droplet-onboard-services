/**
 * `read_file` — read the text of one Nextcloud file, in pages.
 *
 * Why paging. This tool used to slice at 10,000 characters and say nothing
 * about it: a 9 KB file and the first 8% of a 120 KB file both came back as
 * `{ path, content }`, identical in shape, with no flag, no total, and no
 * way to ask for the rest. A model cannot distinguish "that is the whole
 * file" from "that is the opening fragment", so it summarized the fragment
 * as the file — the same failure `read_document_text` was built to prevent
 * (WARP-2057). Every response now carries `truncated` and an explicit
 * `next_offset`: a number while text remains, `null` ONLY when the file is
 * genuinely exhausted. "Budget hit" is never spelled the same way as
 * "done". The 10,000-char cap itself is unchanged — the defect was the
 * silence, not the ceiling.
 *
 * CHARACTER offsets, not byte Ranges (WARP-2194). `offset` indexes the
 * DECODED string and the whole body is downloaded on every call. The
 * alternative — an HTTP `Range` on the download — was rejected for two
 * reasons, one fatal on its own:
 *
 *   - A byte Range splits multi-byte codepoints. Nextcloud content is
 *     UTF-8; cutting at byte 10,000 lands mid-sequence roughly whenever
 *     the file is not pure ASCII, so the tail of one page and the head of
 *     the next each decode to U+FFFD and the character is destroyed. The
 *     contract this tool now promises — page to exhaustion and reconstruct
 *     the file EXACTLY — is unachievable on raw byte offsets without
 *     carrying decoder state between calls, which a stateless tool cannot.
 *   - The producer does not serve Ranges anyway. `read_file` reads through
 *     the orchestrator's `GET /api/files/download`, which pipes the whole
 *     WebDAV stream with no `Accept-Ranges` and no 206 path. A `Range`
 *     header there is ignored and answered with the entire body — so a
 *     byte-offset implementation would silently re-serve page 1 forever.
 *
 * The cost is re-downloading the file per page. That is the SAME cost the
 * pre-paging implementation already paid to serve its single truncated
 * page, and these are documents, not media. If a large-file profile ever
 * justifies streaming, the fix is a decoder that tracks a char→byte index
 * across calls, not a naive Range.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import { sniffIsText } from "./_sniff.js";

/** Characters served per call. Unchanged by WARP-2194 — deliberately. */
const MAX_TEXT_CHARS = 10000;

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Full path to the file to read." },
    offset: {
      type: "integer",
      minimum: 0,
      default: 0,
      description:
        "0-based CHARACTER offset to resume from. Omit for the start of the file; on a follow-up call pass the `next_offset` value from the previous result.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/**
 * Not text — say so, and name the tool that CAN read it. WARP-2194:
 * `read_document_text` reassembles the file-indexer's ordered extraction of
 * the whole document; search_content answers a different question — the
 * passages ranked most similar to a query, capped — and sending a "read this
 * document" intent there is what produced reports built on the top few
 * snippets. Still `ok: true`: an unreadable type is an answer, not a fault.
 */
function binaryRefusal(path: string, contentType: string): ToolResult {
  return {
    ok: true,
    data: {
      path,
      error: `Binary file (type: ${contentType}), cannot read as text — use read_document_text for its extracted text.`,
    },
  };
}

/** Leading half of a surrogate pair — an astral codepoint in UTF-16. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Cut one page out of the decoded text and describe it honestly.
 *
 * `truncated` and `next_offset` answer the same question twice on purpose:
 * the flag is what a human reading the payload sees, the offset is what the
 * model passes back. They can never disagree — both derive from whether the
 * cut landed short of the end.
 */
function page(
  path: string,
  text: string,
  bytesTotal: number,
  offset: number,
): ToolResult {
  const charsTotal = text.length;
  // Past the end. An empty file read from 0 is a legitimate complete read,
  // not an overrun. Every other offset at-or-past the length was invented
  // by the caller: the producer returns `next_offset: null` rather than an
  // offset equal to the length, so a paging model never arrives here.
  if (offset >= charsTotal && charsTotal > 0) {
    return err(
      "INVALID_ARGS",
      `offset ${offset} is past the end of the file (${charsTotal} characters).`,
    );
  }

  let end = Math.min(offset + MAX_TEXT_CHARS, charsTotal);
  // Never split a surrogate pair across the boundary. The halves rejoin on
  // concatenation, so a paged reconstruction survives either way — but a
  // consumer that UTF-8-encodes ONE page (a log line, a re-serialization)
  // turns each lone surrogate into U+FFFD and the character is lost. Push
  // the whole codepoint to the next page instead. Guarded against emptying
  // the page: only ever gives up one character, and only when the page has
  // more than one.
  if (end < charsTotal && end - 1 > offset && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }

  const truncated = end < charsTotal;
  return {
    ok: true,
    data: {
      path,
      content: text.slice(offset, end),
      offset,
      truncated,
      // A number while text remains, null ONLY when the file is exhausted.
      next_offset: truncated ? end : null,
      // Size on disk, in BYTES. `offset`/`next_offset`/`chars_total` are
      // CHARACTERS. Both are reported so neither has to be inferred from
      // the other — on a multi-byte file they are not the same number.
      bytes_total: bytesTotal,
      chars_total: charsTotal,
    },
  };
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

  // Validated BEFORE the download: a malformed offset is the caller's bug,
  // and spending a WebDAV fetch to discover it costs the box real work.
  if (args.offset !== undefined) {
    if (
      typeof args.offset !== "number" ||
      !Number.isInteger(args.offset) ||
      args.offset < 0
    ) {
      return err("INVALID_ARGS", "offset must be a non-negative integer");
    }
  }
  const offset = (args.offset as number | undefined) ?? 0;

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
  const declaredText =
    contentType.includes("text") ||
    contentType.includes("json") ||
    contentType.includes("xml");
  // WARP-1372: sniff only GENERIC/undeclared types — a specifically
  // declared binary type (image/png, application/pdf) is trusted as-is.
  const undeclared = contentType === "" || contentType.includes("octet-stream");

  // Refuse a DECLARED binary before the body is ever read. `read_file` takes
  // an arbitrary model-supplied path and the download route streams whatever
  // it is asked for with no size cap, so buffering the body of a video or a
  // disk image just to discard it a few lines later is an OOM waiting for
  // the first large file — paid on a request that cannot succeed anyway.
  if (!declaredText && !undeclared) return binaryRefusal(path, contentType);

  // ONE read, on the only two branches that can serve text. `byteLength` is
  // the file's real size on disk — not the re-encoded length of a decoded
  // string, which differs the moment the source is not valid UTF-8.
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!declaredText && !sniffIsText(bytes)) return binaryRefusal(path, contentType);
  return page(path, new TextDecoder("utf-8").decode(bytes), bytes.byteLength, offset);
}

const tool: Tool = {
  name: "read_file",
  description:
    "Read the text of a file on the Droplet's Nextcloud, in pages of up to 10,000 characters starting at `offset` (a CHARACTER offset into the file's text; omit it to start at the beginning). Long files come back in parts: when `truncated` is true, `next_offset` is a number and there is more text — call again with `offset` set to that number and keep going until `next_offset` is null. `next_offset: null` is the ONLY signal that you have the whole file, so never describe or summarize a file you have not paged to the end. `chars_total` is the file's full length in characters and `bytes_total` its size in bytes. Binary files (PDFs, Word documents, scans) are refused here — use read_document_text for their extracted text, and for files attached in chat, which live in brain memory rather than on Nextcloud.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
