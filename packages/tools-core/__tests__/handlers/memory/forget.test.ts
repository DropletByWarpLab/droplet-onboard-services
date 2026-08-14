import { describe, it, expect, vi } from "vitest";
import memoryForget from "../../../src/handlers/memory/forget.js";
import { runApproved } from "../../helpers/approve.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  findUnique: ReturnType<typeof vi.fn>,
  update: ReturnType<typeof vi.fn>,
  role?: ToolContext["role"],
): ToolContext {
  return {
    prisma: {
      memoryFact: { findUnique, update },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    ...(role !== undefined ? { role } : {}),
    signal: new AbortController().signal,
  };
}

function factRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "f1",
    category: "Tone",
    fact: "Prefers warm greetings",
    addedBy: "alice",
    addedAt: new Date("2026-05-28T12:00:00Z"),
    active: true,
    audience: "family",
    ...overrides,
  };
}

describe("memory_forget", () => {
  it("rejects a missing id", async () => {
    const findUnique = vi.fn();
    const update = vi.fn();
    const res = await runApproved(memoryForget, {}, ctxWith(findUnique, update, "owner"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an empty id", async () => {
    const findUnique = vi.fn();
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: "   " },
      ctxWith(findUnique, update, "owner"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a non-string id", async () => {
    const findUnique = vi.fn();
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: 42 },
      ctxWith(findUnique, update, "owner"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when no fact has that id", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: "missing", confirmed: true },
      ctxWith(findUnique, update, "owner"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toBe("no active fact with that id");
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an already-inactive fact", async () => {
    const findUnique = vi.fn().mockResolvedValue(factRow({ active: false }));
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: "f1", confirmed: true },
      ctxWith(findUnique, update, "owner"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toBe("no active fact with that id");
    }
    expect(update).not.toHaveBeenCalled();
  });

  // ── WARP-845 audience gate ──
  //
  // A fact the caller cannot READ must be indistinguishable from a
  // missing one: same NOT_FOUND code AND message, and the response must
  // never leak the fact text.

  it("guest cannot forget an owner-audience fact — NOT_FOUND, no leak, no write", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue(factRow({ audience: "owner", fact: "The safe code is 4711" }));
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: "f1", confirmed: true },
      ctxWith(findUnique, update, "guest"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("NOT_FOUND");
      // Identical wording to the missing-id branch — no existence leak.
      expect(res.error.message).toBe("no active fact with that id");
    }
    expect(JSON.stringify(res)).not.toContain("safe code");
    expect(update).not.toHaveBeenCalled();
  });

  it("absent role is treated as guest — family-audience fact is invisible", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue(factRow({ audience: "family", fact: "Household dinner at 7pm" }));
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: "f1", confirmed: true },
      ctxWith(findUnique, update),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toBe("no active fact with that id");
    }
    expect(JSON.stringify(res)).not.toContain("dinner");
    expect(update).not.toHaveBeenCalled();
  });

  it("owner CAN forget a guest-audience fact", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue(factRow({ audience: "guest", fact: "Wifi guest password rotates monthly" }));
    const update = vi.fn().mockResolvedValue(factRow({ audience: "guest", active: false }));
    const res = await runApproved(memoryForget, 
      { id: "f1", confirmed: true },
      ctxWith(findUnique, update, "owner"),
    );
    expect(res.ok).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: "f1" },
      data: { active: false },
    });
  });

  // ── Confirmation enforcement ──
  //
  // Same handler-enforced Tier-2 contract as memory_extract_fact:
  // nothing enforces requiresConfirmation generically, so the first
  // call must return confirmation_required WITHOUT writing, echoing
  // the fact so the user approves exactly what would be forgotten.

  it("does NOT write on the first call — returns confirmation_required echoing the fact", async () => {
    const findUnique = vi.fn().mockResolvedValue(factRow());
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: "f1" },
      ctxWith(findUnique, update, "owner"),
    );
    expect(update).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("confirmation_required");
      expect(res.error.code).toBe("CONFIRMATION_REQUIRED");
      // The message carries the fact so the user can approve/decline
      // exactly what would be forgotten.
      expect(res.error.message).toContain("Prefers warm greetings");
      expect(res.error.details).toMatchObject({
        type: "memory_forget",
        id: "f1",
        category: "Tone",
        fact: "Prefers warm greetings",
      });
    }
  });

  it("explicit confirmed:false also returns confirmation_required", async () => {
    const findUnique = vi.fn().mockResolvedValue(factRow());
    const update = vi.fn();
    const res = await runApproved(memoryForget, 
      { id: "f1", confirmed: false },
      ctxWith(findUnique, update, "owner"),
    );
    expect(update).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe("confirmation_required");
  });

  it("soft-disables on a confirmed re-issue — exactly { active: false }", async () => {
    const findUnique = vi.fn().mockResolvedValue(factRow());
    const update = vi.fn().mockResolvedValue(factRow({ active: false }));
    const res = await runApproved(memoryForget, 
      { id: "f1", confirmed: true },
      ctxWith(findUnique, update, "owner"),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "f1" },
      data: { active: false },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "memory_forget",
        id: "f1",
        forgotten: true,
        fact: "Prefers warm greetings",
        category: "Tone",
      });
    }
  });

  // ── Metadata ──

  it("is Tier 2 (writes + requires confirmation) and named memory_forget", () => {
    expect(memoryForget.name).toBe("memory_forget");
    expect(memoryForget.requiresWrite).toBe(true);
    expect(memoryForget.requiresConfirmation).toBe(true);
  });

  it("input schema requires id and rejects unknown args", () => {
    const schema = memoryForget.inputSchema as {
      required: readonly string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("id");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["confirmation_token", "id"]);
  });
});
