import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import memoryExtractFact from "../../../src/handlers/memory/extract.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  create: Mock,
  // Optional, not `string | undefined`: five call sites below deliberately
  // omit it to exercise the no-user path, and the explicit
  // `ctxWith(create, undefined)` at the "rejects a write with no userId"
  // case stays just as meaningful.
  userId?: string,
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

  it("accepts the WARP-1120 Business category (D-9)", async () => {
    const create = vi.fn();
    const res = await memoryExtractFact.handler(
      { category: "Business", fact: "We invoice clients on the 1st.", confirmed: false },
      ctxWith(create),
    );
    // Business is a valid bucket now — the tool asks for confirmation (Tier-2
    // two-phase), it does NOT reject as INVALID_ARGS.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe("confirmation_required");
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

  // ── Confirmation enforcement ──
  //
  // The tool declares requiresConfirmation and its contract says the
  // write only happens after the user approves. Nothing enforces the
  // flag generically (neither the MCP server nor the agent loop), so
  // the handler itself must refuse to write until the model re-issues
  // the call with `confirmed: true` AFTER the user said yes in chat.

  it("does NOT write on the first call — returns confirmation_required", async () => {
    const create = vi.fn();
    const res = await memoryExtractFact.handler(
      { category: "Workflow", fact: "Recap under 200 words" },
      ctxWith(create, "alice"),
    );
    expect(create).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("confirmation_required");
      expect(res.error.code).toBe("CONFIRMATION_REQUIRED");
      // The message carries the fact so the user can approve/decline
      // exactly what would be remembered.
      expect(res.error.message).toContain("Recap under 200 words");
      expect(res.error.details).toMatchObject({
        type: "memory_fact_save",
        category: "Workflow",
        fact: "Recap under 200 words",
      });
    }
  });

  it("explicit confirmed:false also returns confirmation_required", async () => {
    const create = vi.fn();
    const res = await memoryExtractFact.handler(
      { category: "Tone", fact: "Be concise", confirmed: false },
      ctxWith(create, "alice"),
    );
    expect(create).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe("confirmation_required");
  });

  it("validation still runs before the confirmation gate", async () => {
    const create = vi.fn();
    const res = await memoryExtractFact.handler(
      { category: "BogusBucket", fact: "x", confirmed: true },
      ctxWith(create),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(create).not.toHaveBeenCalled();
  });

  it("persists on a confirmed re-issue, with ctx.userId as addedBy", async () => {
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
        confirmed: true,
      },
      ctxWith(create, "alice"),
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        category: "Workflow",
        fact: "Recap under 200 words",
        evidenceChatId: "session-uuid",
        addedBy: "alice",
        // WARP-845 — model-extracted facts default to the household
        // audience; widening/narrowing is a human Memory-panel action.
        audience: "family",
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
      { category: "Tone", fact: "Be concise", confirmed: true },
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
