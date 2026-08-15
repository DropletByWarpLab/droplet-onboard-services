/**
 * `read_document_text` — serve the FULL extracted text of one document,
 * in document order, including formats `read_file` cannot decode.
 *
 * Why this exists. `read_file` downloads the raw bytes and gives up the
 * moment the content-type is a declared binary — a PDF comes back as
 * "Binary file (type: application/pdf), cannot read as text". So the only
 * route to PDF content was `search_content`, which answers a different
 * question: it returns the chunks most SIMILAR TO A QUERY, ranked, capped
 * at 50. That is the right primitive for "what does this say about X" and
 * the wrong one for "read this and compile it", where a missed line item
 * is a wrong report rather than a thinner answer.
 *
 * No new extraction happens here. The file-indexer already decoded the
 * PDF (pypdf → pdfplumber → OCR) and persisted the result as ordered
 * `FileContentChunk` rows, unique on `(ncFileId, chunkIdx)` and carrying
 * `pageNumber` + per-chunk extractor `warnings`. This tool reassembles
 * those rows by `chunkIdx`. The read is delegated to `ctx.readDocumentText`
 * — the same shim discipline `search_content` uses for `ctx.searchHybrid`
 * (WARP-286) — because decrypt-on-read, the dual-shape chunk-owner
 * resolution (WARP-1014), and the RBAC predicate all live server-side in
 * `file-search.service.ts`. A prisma query here would be a second copy of
 * three security-relevant behaviours, free to drift from the first.
 *
 * Two failure modes this tool refuses to paper over:
 *
 *   - NOT INDEXED. A reconcile over the live box scanned 321 files and
 *     produced chunks for 203: `.JPG`, legacy `.doc`, and NUL-byte PDFs
 *     all fail extraction SILENTLY. Returning "" for those would read to
 *     the model as an empty document, and it would go on to write a
 *     confident report about nothing. Zero chunks is an ERROR here, with
 *     a message that says how to recover.
 *   - TRUNCATION. A long PDF cannot land in one tool result, and a model
 *     that cannot tell "that's the whole thing" from "that's the first
 *     8%" will summarize the first 8% as if it were the whole thing.
 *     Every response carries an explicit `next_chunk` — a number while
 *     text remains, `null` only when the document is exhausted.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

/** Default text budget per call — comfortably inside a single tool result
 *  while still covering ~4-6 pages of a typical PDF. */
const DEFAULT_MAX_CHARS = 12000;
/** Hard ceiling per call, whatever the model asks for. */
const MAX_MAX_CHARS = 50000;

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Full path of the document to read, as reported by search_content, list_files, or list_recent_files.",
    },
    start_chunk: {
      type: "integer",
      minimum: 0,
      description:
        "0-based chunk index to resume from. Omit for the start of the document; on a follow-up call pass the `next_chunk` value from the previous result.",
    },
    max_chars: {
      type: "integer",
      minimum: 500,
      maximum: MAX_MAX_CHARS,
      description: `Approximate character budget for this call (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}). Whole chunks are returned, so the real total can slightly exceed this.`,
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");

  // The chunk row's `path` is the watcher's `stored_path` — a leading-slash,
  // separator-collapsed, user-relative path. `validateNcPath` normalizes to
  // exactly that shape, so reusing it means every spelling that works with
  // read_file works here too. Without it "Docs/q.pdf" or "/Docs//q.pdf"
  // would miss an exact `path =` match and surface as a false NOT_INDEXED,
  // which is the one error this tool must never cry wolf on.
  const v = validateNcPath(typeof args.path === "string" ? args.path.trim() : args.path);
  if (!v.ok) return err("INVALID_ARGS", v.error);
  if (v.path === "/") return err("INVALID_ARGS", "path must name a file, not the root");
  const path = v.path;

  if (args.start_chunk !== undefined) {
    if (
      typeof args.start_chunk !== "number" ||
      !Number.isInteger(args.start_chunk) ||
      args.start_chunk < 0
    ) {
      return err("INVALID_ARGS", "start_chunk must be a non-negative integer");
    }
  }
  const startChunk = (args.start_chunk as number | undefined) ?? 0;

  if (args.max_chars !== undefined) {
    if (
      typeof args.max_chars !== "number" ||
      !Number.isInteger(args.max_chars) ||
      args.max_chars < 500
    ) {
      return err("INVALID_ARGS", "max_chars must be an integer of at least 500");
    }
  }
  const maxChars = Math.min(
    MAX_MAX_CHARS,
    (args.max_chars as number | undefined) ?? DEFAULT_MAX_CHARS,
  );

  if (!ctx.readDocumentText) {
    return err(
      "DOCUMENT_READ_UNAVAILABLE",
      "Document reading is not available right now — the file index is not reachable.",
    );
  }

  let res: Awaited<ReturnType<NonNullable<typeof ctx.readDocumentText>>>;
  try {
    res = await ctx.readDocumentText({ path, startChunk, maxChars });
  } catch {
    return err("DOCUMENT_READ_FAILED", "document_read_failed");
  }

  // Zero chunks anywhere in the corpus for this path. Distinct from "this
  // offset is past the end" (handled below), and NOT an empty success:
  // the extractor skipping a file is invisible from the outside, so the
  // model must be told the text does not exist rather than handed "".
  if (res.totalChunks === 0) {
    return err(
      "NOT_INDEXED",
      `No extracted text exists for ${path}. The file may still be indexing, or its text could not be extracted (scanned image with no OCR text layer, a legacy .doc, or a corrupt PDF). Ask the user to re-upload it, or use search_content to check whether any of it was indexed.`,
    );
  }

  if (startChunk >= res.totalChunks) {
    return err(
      "INVALID_ARGS",
      `start_chunk ${startChunk} is past the end of the document (${res.totalChunks} chunks).`,
    );
  }

  const text = res.chunks.map((c) => c.text).join("\n");

  const pages = [
    ...new Set(
      res.chunks.flatMap((c) => (c.pageNumber === null ? [] : [c.pageNumber])),
    ),
  ].sort((a, b) => a - b);

  // Deduped across the returned chunks — the model needs to know OCR ran
  // low-confidence on a page, not to receive the same tag forty times.
  const warnings = [...new Set(res.chunks.flatMap((c) => c.warnings))];

  return {
    ok: true,
    data: {
      type: "read_document_text",
      path,
      source: res.source,
      text,
      chunks_returned: res.chunks.length,
      start_chunk: startChunk,
      // A number while text remains, null ONLY when the document is
      // exhausted. The model reads this to decide whether to call again;
      // conflating "done" with "budget hit" is what turns a partial read
      // into a confident summary of the first few pages.
      next_chunk: res.nextChunk,
      total_chunks: res.totalChunks,
      ...(pages.length > 0 ? { pages } : {}),
      ...(warnings.length > 0 ? { extraction_warnings: warnings } : {}),
      // Chunks dropped because their DEK is gone (crypto-shredded) or
      // failed authentication. Surfaced rather than swallowed: a report
      // compiled from a document with holes in it should say so.
      ...(res.unreadableChunks > 0
        ? { unreadable_chunks: res.unreadableChunks }
        : {}),
    },
  };
}

const tool: Tool = {
  name: "read_document_text",
  description:
    "Read the full extracted text of one document in document order, including PDFs, Word docs, and scans that read_file cannot decode. Use this — not search_content — when you need the WHOLE document (compiling a report, extracting every date or line item); use search_content when you only need the passages matching a question. Long documents come back in parts: when `next_chunk` is a number there is more text, so call again with start_chunk set to it, and keep going until `next_chunk` is null. Fails with NOT_INDEXED when the file has no extracted text rather than returning an empty document.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
