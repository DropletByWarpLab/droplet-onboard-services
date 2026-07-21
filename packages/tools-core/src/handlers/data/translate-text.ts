/**
 * WARP-1426 — `translate_text` LLM tool.
 *
 * Translates text between languages using the box's local model via the
 * orchestrator's single-turn completion endpoint (`POST /api/llm/complete`).
 * The handler builds a fixed translation-engine system prompt, sends the
 * user text verbatim at low temperature, and returns only the translated
 * text. Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_TEXT_CHARS = 8000;
const MAX_LANGUAGE_CHARS = 80;

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TEXT_CHARS,
      description: `The text to translate (1–${MAX_TEXT_CHARS} characters). Sent verbatim.`,
    },
    target_language: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LANGUAGE_CHARS,
      description:
        'Language to translate into — a name like "French" or a code like "fr".',
    },
    source_language: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LANGUAGE_CHARS,
      description:
        'Language of the input text — a name like "German" or a code like "de". Auto-detected when omitted.',
    },
  },
  required: ["text", "target_language"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: { code: "INVALID_ARGS", message },
  };
}

function llmUnavailable(): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "LLM_UNAVAILABLE",
      message: "the language model is not reachable right now",
    },
  };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text) return invalidArgs("text is required and must be a non-empty string");
  if (text.length > MAX_TEXT_CHARS) {
    return invalidArgs(`text must be at most ${MAX_TEXT_CHARS} characters`);
  }

  const targetLanguage =
    typeof args.target_language === "string" ? args.target_language : "";
  if (!targetLanguage) {
    return invalidArgs("target_language is required and must be a non-empty string");
  }
  if (targetLanguage.length > MAX_LANGUAGE_CHARS) {
    return invalidArgs(
      `target_language must be at most ${MAX_LANGUAGE_CHARS} characters`,
    );
  }

  let sourceLanguage: string | undefined;
  if (args.source_language !== undefined) {
    if (
      typeof args.source_language !== "string" ||
      args.source_language === "" ||
      args.source_language.length > MAX_LANGUAGE_CHARS
    ) {
      return invalidArgs(
        `source_language, when given, must be a non-empty string of at most ${MAX_LANGUAGE_CHARS} characters`,
      );
    }
    sourceLanguage = args.source_language;
  }

  const system =
    `You are a translation engine. Translate the user's text into ${targetLanguage}` +
    (sourceLanguage
      ? ` from ${sourceLanguage}.`
      : ". Auto-detect the source language.") +
    " Preserve the original meaning, tone, and formatting." +
    " Output ONLY the translated text — no commentary, no explanations, no surrounding quotes.";

  let content = "";
  let model = "";
  try {
    const res = await ctx.http.orchestrator.post("/api/llm/complete", {
      system,
      text,
      temperature: 0.1,
    });
    if (!res.ok) return llmUnavailable();
    const payload = (await res.json()) as {
      content?: unknown;
      model?: unknown;
    };
    content = typeof payload.content === "string" ? payload.content : "";
    model = typeof payload.model === "string" ? payload.model : "";
  } catch {
    return llmUnavailable();
  }

  const translation = content.trim();
  if (!translation) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMPTY_TRANSLATION",
        message: "the model returned an empty translation",
      },
    };
  }

  return {
    ok: true,
    data: {
      type: "translate_text",
      translation,
      target_language: targetLanguage,
      ...(sourceLanguage && { source_language: sourceLanguage }),
      model,
    },
  };
}

const tool: Tool = {
  name: "translate_text",
  description:
    "Translate text between languages using the box's local model (single-turn completion via the orchestrator). Provide the text (up to 8000 characters) and a target_language — a language name like \"French\" or a code like \"fr\"; source_language is optional and auto-detected when omitted. Returns only the translation, with no commentary.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
