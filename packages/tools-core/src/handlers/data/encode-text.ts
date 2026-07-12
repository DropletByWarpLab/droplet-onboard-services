/**
 * WARP-899 — `encode_text` LLM tool.
 *
 * Data-utility domain (competitive audit, codename Nomad — WARP-898): our
 * competitors ship CyberChef/IT-Tools as a manual, user-operated SPA; we are
 * agentic — the assistant performs the transform in-chat instead. Tier-1
 * read (no write, no confirmation); pure computation, no I/O, no app
 * secrets, no network egress. Uses only Node's built-in `Buffer`/`encodeURIComponent` —
 * never the credential-bearing `encryption.service.ts` (`aes-256-gcm`) or
 * `password.service.ts` (`argon2id`) keys.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Mirrors `read_file`'s MAX_TEXT_CHARS cap (packages/tools-core/src/handlers/files/read-file.ts). */
const MAX_TEXT_CHARS = 10_000;

type Encoding = "base64" | "base64url" | "hex" | "url";
const VALID_ENCODINGS: Encoding[] = ["base64", "base64url", "hex", "url"];

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: `Text to encode. Capped at ${MAX_TEXT_CHARS} chars.`,
    },
    encoding: {
      type: "string",
      enum: VALID_ENCODINGS,
      description: "Target encoding: 'base64', 'base64url', 'hex', or 'url' (percent-encoding).",
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

  let encoded: string;
  switch (encoding as Encoding) {
    case "base64":
      encoded = Buffer.from(text, "utf8").toString("base64");
      break;
    case "base64url":
      encoded = Buffer.from(text, "utf8").toString("base64url");
      break;
    case "hex":
      encoded = Buffer.from(text, "utf8").toString("hex");
      break;
    case "url":
      encoded = encodeURIComponent(text);
      break;
  }

  return {
    ok: true,
    data: { type: "encode_text", encoding, encoded },
  };
}

const tool: Tool = {
  name: "encode_text",
  description:
    `Encode text as 'base64', 'base64url', 'hex', or 'url' (percent-encoding). ` +
    `Input capped at ${MAX_TEXT_CHARS} chars. Tier-1 read; pure computation, no network egress. ` +
    "Use decode_text to reverse.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
