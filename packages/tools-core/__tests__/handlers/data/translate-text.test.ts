/**
 * WARP-1426 — `translate_text` LLM tool.
 *
 * Thin wrapper over the orchestrator's single-turn completion endpoint
 * (`POST /api/llm/complete`): builds a fixed translation-engine system
 * prompt, sends the user text verbatim at temperature 0.1, and returns
 * only the translated text. Tier-1 read — no writes, no confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import translateText from "../../../src/handlers/data/translate-text.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  orchestratorPost: Mock,
): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: vi.fn(),
        post: orchestratorPost,
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

function okPost(content: string, model = "qwen2.5:7b"): Mock {
  // Fresh Response per call — a Response body can only be read once.
  return vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ content, model }), { status: 200 }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof translateText.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("translate_text", () => {
  it("posts the completion request and returns the trimmed translation", async () => {
    const post = okPost("  Bonjour le monde  ");
    const ctx = ctxWith(post);

    const res = await translateText.handler(
      { text: "Hello, world", target_language: "French" },
      ctx,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/api/llm/complete",
      expect.objectContaining({
        system: expect.stringContaining("French"),
        text: "Hello, world",
        temperature: 0.1,
      }),
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "translate_text",
        translation: "Bonjour le monde",
        target_language: "French",
        model: "qwen2.5:7b",
      });
    }
  });

  it("includes source_language in the system prompt and echoes it in data", async () => {
    const post = okPost("Hola");
    const ctx = ctxWith(post);

    const res = await translateText.handler(
      { text: "Hello", target_language: "Spanish", source_language: "English" },
      ctx,
    );

    const [, body] = post.mock.calls[0] as [string, { system: string }];
    expect(body.system).toContain("Spanish");
    expect(body.system).toContain("English");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual(
        expect.objectContaining({
          type: "translate_text",
          translation: "Hola",
          target_language: "Spanish",
          source_language: "English",
        }),
      );
    }
  });

  it("rejects a missing text with INVALID_ARGS (no HTTP call)", async () => {
    const post = vi.fn();
    const res = await translateText.handler(
      { target_language: "French" },
      ctxWith(post),
    );
    expectError(res, "INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an empty text with INVALID_ARGS", async () => {
    const res = await translateText.handler(
      { text: "", target_language: "French" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_ARGS");
  });

  it("rejects a missing target_language with INVALID_ARGS", async () => {
    const res = await translateText.handler(
      { text: "Hello" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_ARGS");
  });

  it("rejects an empty target_language with INVALID_ARGS", async () => {
    const res = await translateText.handler(
      { text: "Hello", target_language: "" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_ARGS");
  });

  it("rejects text over 8000 characters with INVALID_ARGS", async () => {
    const res = await translateText.handler(
      { text: "a".repeat(8001), target_language: "French" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_ARGS");
  });

  it("rejects a target_language over 80 characters with INVALID_ARGS", async () => {
    const res = await translateText.handler(
      { text: "Hello", target_language: "x".repeat(81) },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_ARGS");
  });

  it("maps an orchestrator 502 to LLM_UNAVAILABLE", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "llm_unavailable" }), {
          status: 502,
        }),
      );
    const res = await translateText.handler(
      { text: "Hello", target_language: "French" },
      ctxWith(post),
    );
    expectError(res, "LLM_UNAVAILABLE");
  });

  it("maps a thrown fetch error to LLM_UNAVAILABLE", async () => {
    const post = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await translateText.handler(
      { text: "Hello", target_language: "French" },
      ctxWith(post),
    );
    expectError(res, "LLM_UNAVAILABLE");
  });

  it("maps a 200 with empty content to EMPTY_TRANSLATION", async () => {
    const res = await translateText.handler(
      { text: "Hello", target_language: "French" },
      ctxWith(okPost("")),
    );
    expectError(res, "EMPTY_TRANSLATION");
  });

  it("maps a 200 with whitespace-only content to EMPTY_TRANSLATION", async () => {
    const res = await translateText.handler(
      { text: "Hello", target_language: "French" },
      ctxWith(okPost("   \n")),
    );
    expectError(res, "EMPTY_TRANSLATION");
  });
});

describe("translate_text — tool metadata", () => {
  it("is named translate_text and is Tier-1 (no write, no confirm)", () => {
    expect(translateText.name).toBe("translate_text");
    expect(translateText.requiresWrite).toBe(false);
    expect(translateText.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema requiring text + target_language", () => {
    const schema = translateText.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["text", "target_language"]);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "text",
      "target_language",
      "source_language",
    ]);
  });
});
