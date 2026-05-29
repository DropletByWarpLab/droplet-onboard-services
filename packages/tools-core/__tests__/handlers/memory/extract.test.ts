import { describe, it, expect, vi } from "vitest";
import memoryExtractFact from "../../../src/handlers/memory/extract.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  create: ReturnType<typeof vi.fn>,
  userId: string | undefined,
): ToolContext {
  return {
    prisma: {
      memoryFact: { create },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("memory_extract_fact", () => {
  it("rejects unknown category", async () => {
    const create = vi.fn();
    const res = await memoryExtractFact.handler(
      { category: "BogusBucket", fact: "x" },
      ctxWith(create),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects empty fact", async () => {
    const create = vi.fn();
    const res = await memoryExtractFact.handler(
      { category: "Tone", fact: "  " },
      ctxWith(create),
    );
    expect(res.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects oversized fact (>2000 chars)", async () => {
    const create = vi.fn();
    const res = await memoryExtractFact.handler(
      { category: "Tone", fact: "x".repeat(2001) },
      ctxWith(create),
    );
    expect(res.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("persists with ctx.userId as addedBy", async () => {
    const at = new Date("2026-05-28T12:00:00Z");
    const create = vi.fn().mockResolvedValue({
      id: "f1",
      category: "Workflow",
      fact: "Recap under 200 words",
      addedAt: at,
    });
    const res = await memoryExtractFact.handler(
      {
        category: "Workflow",
        fact: "Recap under 200 words",
        evidenceChatId: "session-uuid",
      },
      ctxWith(create, "alice"),
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        category: "Workflow",
        fact: "Recap under 200 words",
        evidenceChatId: "session-uuid",
        addedBy: "alice",
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({
        id: "f1",
        category: "Workflow",
        fact: "Recap under 200 words",
        addedAt: at.toISOString(),
      });
    }
  });

  it("falls back to addedBy='agent' when ctx.userId is unset", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "f2",
      category: "Tone",
      fact: "Be concise",
      addedAt: new Date(),
    });
    await memoryExtractFact.handler(
      { category: "Tone", fact: "Be concise" },
      ctxWith(create, undefined),
    );
    const callArgs = create.mock.calls[0]?.[0] as {
      data: { addedBy: string };
    };
    expect(callArgs.data.addedBy).toBe("agent");
  });

  it("is Tier 2 (writes + requires confirmation)", () => {
    expect(memoryExtractFact.requiresWrite).toBe(true);
    expect(memoryExtractFact.requiresConfirmation).toBe(true);
  });
});
