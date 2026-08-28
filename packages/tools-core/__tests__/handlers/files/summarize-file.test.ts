/**
 * WARP-1426 — `summarize_file`: fetch a Nextcloud file exactly like
 * `read_file` does, then ask the orchestrator's completion endpoint
 * (`POST /api/llm/complete`) for a concise summary.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import summarizeFile from "../../../src/handlers/files/summarize-file.js";
import type { ToolContext } from "../../../src/types.js";

const TRUNCATE_AT = 24000;

function ctxWith(
  get: Mock,
  post: Mock,
  opts: { ncToken?: string; userId?: string } = {},
): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    // Default to an authenticated session so the happy-path tests
    // exercise the flow; auth-gate tests override these explicitly.
    userId: opts.userId === undefined ? "alice" : opts.userId,
    ncToken: opts.ncToken === undefined ? "tok" : opts.ncToken,
    signal: new AbortController().signal,
  };
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

function llmResponse(content: string, model = "qwen3:8b"): Response {
  return new Response(JSON.stringify({ content, model }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("summarize_file", () => {
  it("happy path: fetches like read_file, posts the content for completion", async () => {
    const get = vi.fn().mockResolvedValue(textResponse("Boiler serviced 10/02/2026. Filter changed."));
    const post = vi.fn().mockResolvedValue(llmResponse("  The boiler was serviced and the filter changed.  "));
    const r = await summarizeFile.handler({ path: "/Home/log.md" }, ctxWith(get, post));

    // Fetch phase must be indistinguishable from read_file's download call.
    expect(get).toHaveBeenCalledWith(
      `/download?path=${encodeURIComponent("/Home/log.md")}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": "tok",
          "X-Nextcloud-User": "alice",
        }),
      }),
    );

    // Completion phase: fixed summarization system prompt, file content as text.
    expect(post).toHaveBeenCalledWith(
      "/api/llm/complete",
      expect.objectContaining({
        system: expect.stringMatching(/summar/i),
        text: "Boiler serviced 10/02/2026. Filter changed.",
        temperature: 0.2,
        max_tokens: 1024,
      }),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        type: "summarize_file",
        path: "/Home/log.md",
        summary: "The boiler was serviced and the filter changed.",
        truncated: false,
        model: "qwen3:8b",
      });
    }
  });

  it("threads `focus` into the system prompt", async () => {
    const get = vi.fn().mockResolvedValue(textResponse("Meeting notes about budget and hiring."));
    const post = vi.fn().mockResolvedValue(llmResponse("Summary."));
    const r = await summarizeFile.handler(
      { path: "/notes/meeting.md", focus: "hiring decisions" },
      ctxWith(get, post),
    );
    expect(r.ok).toBe(true);
    const body = post.mock.calls[0][1] as { system: string };
    expect(body.system).toContain("hiring decisions");
  });

  it("truncates long content at 24000 chars and reports truncated=true", async () => {
    const get = vi.fn().mockResolvedValue(textResponse("a".repeat(30000)));
    const post = vi.fn().mockResolvedValue(llmResponse("Long file summary."));
    const r = await summarizeFile.handler({ path: "/big.txt" }, ctxWith(get, post));
    const body = post.mock.calls[0][1] as { text: string };
    expect(body.text.length).toBe(TRUNCATE_AT);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { truncated: boolean }).truncated).toBe(true);
  });

  // ── fetch-phase parity with read_file ────────────────────────────────

  it("propagates read_file's READ_FAILED on a 404 download", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const post = vi.fn();
    const r = await summarizeFile.handler({ path: "/missing.txt" }, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("READ_FAILED");
    expect(post).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without ncToken, like read_file", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const r = await summarizeFile.handler(
      { path: "/notes/x.txt" },
      ctxWith(get, post, { ncToken: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects traversal with INVALID_PATH before any HTTP call, like read_file", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const r = await summarizeFile.handler({ path: "/foo/../../bar" }, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses declared-binary files without calling the LLM", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(" ", { status: 200, headers: { "content-type": "image/png" } }),
    );
    const post = vi.fn();
    const r = await summarizeFile.handler({ path: "/p.png" }, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("BINARY_FILE");
    expect(post).not.toHaveBeenCalled();
  });

  // ── empty / LLM failure paths ────────────────────────────────────────

  it("returns EMPTY_FILE for an empty file", async () => {
    const get = vi.fn().mockResolvedValue(textResponse(""));
    const post = vi.fn();
    const r = await summarizeFile.handler({ path: "/empty.txt" }, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EMPTY_FILE");
    expect(post).not.toHaveBeenCalled();
  });

  it("returns LLM_UNAVAILABLE when the completion endpoint answers 502", async () => {
    const get = vi.fn().mockResolvedValue(textResponse("some content"));
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "llm_unavailable" }), { status: 502 }),
    );
    const r = await summarizeFile.handler({ path: "/notes/x.txt" }, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LLM_UNAVAILABLE");
  });

  it("returns LLM_UNAVAILABLE when the completion call throws", async () => {
    const get = vi.fn().mockResolvedValue(textResponse("some content"));
    const post = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await summarizeFile.handler({ path: "/notes/x.txt" }, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LLM_UNAVAILABLE");
  });

  it("returns EMPTY_SUMMARY when the model answers with empty content", async () => {
    const get = vi.fn().mockResolvedValue(textResponse("some content"));
    const post = vi.fn().mockResolvedValue(llmResponse("   "));
    const r = await summarizeFile.handler({ path: "/notes/x.txt" }, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EMPTY_SUMMARY");
  });

  // ── arg validation ───────────────────────────────────────────────────

  it("rejects a missing path with INVALID_ARGS", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const r = await summarizeFile.handler({}, ctxWith(get, post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a focus over 500 chars with INVALID_ARGS", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const r = await summarizeFile.handler(
      { path: "/notes/x.txt", focus: "f".repeat(501) },
      ctxWith(get, post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a non-string focus with INVALID_ARGS", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const r = await summarizeFile.handler(
      { path: "/notes/x.txt", focus: 42 },
      ctxWith(get, post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("summarize_file — tool metadata", () => {
  it("is named summarize_file and is Tier-1 (no write, no confirm)", () => {
    expect(summarizeFile.name).toBe("summarize_file");
    expect(summarizeFile.requiresWrite).toBe(false);
    expect(summarizeFile.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema requiring only path", () => {
    const schema = summarizeFile.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["path"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["path", "focus"]);
  });

  it("mentions large-file truncation in the LLM-facing description", () => {
    expect(summarizeFile.description).toMatch(/first portion/i);
  });
});
