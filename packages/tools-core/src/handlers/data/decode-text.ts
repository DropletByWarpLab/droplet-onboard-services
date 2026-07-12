/**
 * WARP-899 — `decode_text` LLM tool.
 *
 * Reverse of `encode_text`. Tier-1 read (no write, no confirmation); pure
 * computation, no I/O, no app secrets, no network egress.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Mirrors `read_file`'s MAX_TEXT_CHARS cap (packages/tools-core/src/handlers/files/read-file.ts). */
const MAX_TEXT_CHARS = 10_000;

type Encoding = "base64" | "base64url" | "hex" | "url";
const VALID_ENCODINGS: Encoding[] = ["base64", "base64url", "hex", "url"];

/** Node accepts near-arbitrary bytes as "valid" base64/hex and silently
 *  drops the invalid tail instead of throwing, so a garbage input can
 *  round-trip to an empty or truncated string with no error. Reject inputs
 *  that don't match the expected alphabet up front instead of guessing. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const HEX_PATTERN = /^([0-9a-fA-F]{2})*$/;

function decodeStrict(text: string, encoding: Encoding): string {
  switch (encoding) {
    case "base64": {
      if (!BASE64_PATTERN.test(text) || text.length % 4 !== 0) {
        throw new Error("not valid base64");
      }
      return Buffer.from(text, "base64").toString("utf8");
    }
    case "base64url": {
      if (!BASE64URL_PATTERN.test(text)) {
        throw new Error("not valid base64url");
      }
      return Buffer.from(text, "base64url").toString("utf8");
    }
    case "hex": {
      if (!HEX_PATTERN.test(text)) {
        throw new Error("not valid hex");
      }
      return Buffer.from(text, "hex").toString("utf8");
    }
    case "url":
      return decodeURIComponent(text);
  }
}

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: `Text to decode. Capped at ${MAX_TEXT_CHARS} chars.`,
    },
    encoding: {
      type: "string",
      enum: VALID_ENCODINGS,
      description: "Source encoding: 'base64', 'base64url', 'hex', or 'url' (percent-encoding).",
    },
  },
  required: ["text", "encoding"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text : undefined;
  const encoding = typeof args.encoding === "string" ? args.encoding : undefined;

  if (text === undefined || encoding === undefined) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "text and encoding are required" },
    };
  }
  if (!VALID_ENCODINGS.includes(encoding as Encoding)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ENCODING", message: `encoding must be one of: ${VALID_ENCODINGS.join(", ")}` },
    };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      status: "error",
      error: { code: "TEXT_TOO_LONG", message: `text exceeds ${MAX_TEXT_CHARS} chars` },
    };
  }

  let decoded: string;
  try {
    decoded = decodeStrict(text, encoding as Encoding);
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: { code: "DECODE_FAILED", message: String((err as Error)?.message ?? err) },
    };
  }

  return {
    ok: true,
    data: { type: "decode_text", encoding, decoded },
  };
}

const tool: Tool = {
  name: "decode_text",
  description:
    `Decode text from 'base64', 'base64url', 'hex', or 'url' (percent-encoding). ` +
    `Input capped at ${MAX_TEXT_CHARS} chars; malformed input for the chosen encoding is rejected as DECODE_FAILED ` +
    "rather than silently truncated. Tier-1 read; pure computation, no network egress.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
