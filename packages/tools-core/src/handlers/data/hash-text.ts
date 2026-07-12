/**
 * WARP-899 — `hash_text` LLM tool.
 *
 * Computes a digest of arbitrary text via Node's built-in `crypto` module.
 * Tier-1 read (no write, no confirmation); pure computation, no I/O, no app
 * secrets, no network egress. Never touches the credential-bearing
 * `encryption.service.ts` (`aes-256-gcm`) or `password.service.ts`
 * (`argon2id`) infra — those are internal-only and out of scope here.
 *
 * NON-SECURITY-GRADE: this is a general-purpose text digest (checksums,
 * dedup keys, cache keys, etc.), not a credential hash. `md5` and `sha1`
 * are cryptographically broken for adversarial contexts (collision
 * attacks) and none of these algorithms are salted/stretched — do not use
 * this tool's output to store or verify passwords/secrets.
 */
import { createHash } from "node:crypto";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Mirrors `read_file`'s MAX_TEXT_CHARS cap (packages/tools-core/src/handlers/files/read-file.ts). */
const MAX_TEXT_CHARS = 10_000;

type Algorithm = "sha256" | "sha1" | "md5";
const VALID_ALGORITHMS: Algorithm[] = ["sha256", "sha1", "md5"];

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: `Text to hash. Capped at ${MAX_TEXT_CHARS} chars.`,
    },
    algorithm: {
      type: "string",
      enum: VALID_ALGORITHMS,
      description: "Digest algorithm: 'sha256', 'sha1', or 'md5'.",
    },
  },
  required: ["text", "algorithm"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text : undefined;
  const algorithm = typeof args.algorithm === "string" ? args.algorithm : undefined;

  if (text === undefined || algorithm === undefined) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "text and algorithm are required" },
    };
  }
  if (!VALID_ALGORITHMS.includes(algorithm as Algorithm)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ALGORITHM", message: `algorithm must be one of: ${VALID_ALGORITHMS.join(", ")}` },
    };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      status: "error",
      error: { code: "TEXT_TOO_LONG", message: `text exceeds ${MAX_TEXT_CHARS} chars` },
    };
  }

  const hash = createHash(algorithm).update(text, "utf8").digest("hex");

  return {
    ok: true,
    data: { type: "hash_text", algorithm, hash },
  };
}

const tool: Tool = {
  name: "hash_text",
  description:
    `Compute a hex digest of text using 'sha256', 'sha1', or 'md5' (Node built-in crypto, no app secrets, no ` +
    `network egress). Input capped at ${MAX_TEXT_CHARS} chars. NON-SECURITY-GRADE: unsalted, unstretched — a ` +
    "general text/checksum digest, not a password/credential hash. Tier-1 read.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
