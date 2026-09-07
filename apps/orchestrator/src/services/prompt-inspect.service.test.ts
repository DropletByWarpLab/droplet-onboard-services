/**
 * WARP-2823 — the prompt inspector does not inherit the turn's fail-open.
 *
 * ── The defect this file exists to prevent ─────────────────────────────────
 *
 * Every composer in the chat path fails open: a throw becomes `""` and the
 * turn proceeds. That is right for a turn and pinned elsewhere
 * (`prompt-block-fixtures.ts`). An inspector that inherited it would render a
 * BROKEN block and a block that was never configured identically — as an
 * absence — and the broken one is the exact condition somebody opened this
 * page to find. So the first three tests below are about a thrown error
 * surviving as an error.
 *
 * The second risk is subtler: composing at the CALLER's role instead of the
 * target's. That page would look completely correct, be internally
 * consistent, and describe the wrong person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  attributed: vi.fn(),
  getPersona: vi.fn(),
  composePersonaBlock: vi.fn(),
  getBusinessProfile: vi.fn(),
  composeBusinessBlock: vi.fn(),
  buildBrainBlock: vi.fn(),
  buildMemoryFactsBlock: vi.fn(),
  loadIdentityPrompt: vi.fn(),
  composeToolGuidance: vi.fn(),
}));

vi.mock("./tool-access.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-access.service.js")>();
  return { ...actual, resolveAttributedToolAccess: mocks.attributed };
});
vi.mock("./persona.service.js", () => ({
  getPersona: mocks.getPersona,
  composePersonaBlock: mocks.composePersonaBlock,
}));
vi.mock("./business-profile.service.js", () => ({
  getBusinessProfile: mocks.getBusinessProfile,
  composeBusinessBlock: mocks.composeBusinessBlock,
}));
vi.mock("./brain/brain-block.service.js", () => ({
  buildBrainBlock: mocks.buildBrainBlock,
  BRAIN_BLOCK_CHAR_BUDGET: 1800,
}));
vi.mock("./system-prompt.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./system-prompt.service.js")>();
  return { ...actual, buildMemoryFactsBlock: mocks.buildMemoryFactsBlock };
});
vi.mock("./identity-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity-prompt.js")>();
  return { ...actual, loadIdentityPrompt: mocks.loadIdentityPrompt };
});
vi.mock("./tool-guidance.service.js", () => ({
  composeToolGuidance: mocks.composeToolGuidance,
}));

import { inspectPromptForPerson } from "./prompt-inspect.service.js";

const prisma = {
  workspace: { findUnique: vi.fn(async () => ({ id: 1, type: "BUSINESS" })) },
} as never;

const blockOf = (r: Awaited<ReturnType<typeof inspectPromptForPerson>>, key: string) => {
  const b = r.blocks.find((x) => x.key === key);
  if (!b) throw new Error(`no block "${key}"`);
  return b;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attributed.mockResolvedValue({ scope: null, tier: "owner", unresolved: null });
  mocks.loadIdentityPrompt.mockReturnValue("IDENTITY");
  mocks.getPersona.mockResolvedValue({});
  mocks.composePersonaBlock.mockReturnValue("PERSONA");
  mocks.getBusinessProfile.mockResolvedValue({});
  mocks.composeBusinessBlock.mockReturnValue("BUSINESS");
  mocks.composeToolGuidance.mockReturnValue("GUIDANCE");
  mocks.buildMemoryFactsBlock.mockResolvedValue("\n\nMEMORY");
  mocks.buildBrainBlock.mockResolvedValue("BRAIN");
});

// ── the fail-open inversion ─────────────────────────────────────────────────

describe("🔴 a composer that throws is reported as broken, never as empty", () => {
  it("reports `errored`, not `absent`, when the persona read throws", async () => {
    // On a chat turn this exact throw yields "" and the user never knows. Here
    // it is the answer to the question the admin asked.
    mocks.getPersona.mockRejectedValue(new TypeError("db down"));
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });

    const persona = blockOf(r, "persona");
    expect(persona.status).toBe("errored");
    expect(persona.text).toBeNull();
    expect(persona.note).toBeTruthy();
    expect(r.erroredBlocks).toContain("persona");
  });

  it("distinguishes it from a persona that is legitimately unset", async () => {
    // Without this the test above would pass for a service that called
    // everything `errored`, which is the same failure in the other direction.
    mocks.composePersonaBlock.mockReturnValue("");
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });

    expect(blockOf(r, "persona").status).toBe("absent");
    expect(r.erroredBlocks).toEqual([]);
  });

  it("🔴 does not put the error MESSAGE in the response", async () => {
    // A Prisma error message can carry fragments of the row it failed on, and
    // this response is rendered on a screen and pasted into tickets. The class
    // plus the block name says where to look; the value belongs in the logs.
    mocks.buildBrainBlock.mockRejectedValue(
      new Error("Invalid `prisma.brainDigest.findMany()`: value 'ACME PAYROLL' ..."),
    );
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });

    const brain = blockOf(r, "brain");
    expect(brain.status).toBe("errored");
    expect(brain.note).toContain("Error");
    expect(brain.note).not.toContain("ACME PAYROLL");
    expect(JSON.stringify(r)).not.toContain("ACME PAYROLL");
  });

  it("one broken composer does not take the others down", async () => {
    mocks.getPersona.mockRejectedValue(new Error("x"));
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });

    expect(blockOf(r, "identity").status).toBe("present");
    expect(blockOf(r, "business").status).toBe("present");
    expect(blockOf(r, "tool_guidance").status).toBe("present");
  });
});

// ── whose prompt is this ────────────────────────────────────────────────────

describe("🔴 every role-filtered composer is driven by the TARGET", () => {
  it("composes the business block at the target's tier, not the caller's", async () => {
    // `composeBusinessBlock` role-filters: owner/admin get summary + fields,
    // family gets the summary, guest and service get nothing. A page that
    // passed the admin's own role would show an admin looking at a guest a
    // block that guest has never received.
    mocks.attributed.mockResolvedValue({ scope: null, tier: "family", unresolved: null });
    await inspectPromptForPerson(prisma, { targetUserId: "someone-else" });

    expect(mocks.composeBusinessBlock).toHaveBeenCalledWith("family", {}, "BUSINESS");
  });

  it("reads memory facts at the target's tier", async () => {
    // WARP-845 filters facts to the audiences a role may read.
    mocks.attributed.mockResolvedValue({ scope: null, tier: "guest", unresolved: null });
    await inspectPromptForPerson(prisma, { targetUserId: "g1" });

    expect(mocks.buildMemoryFactsBlock).toHaveBeenCalledWith(prisma, "guest");
  });

  it("builds the brain block for the TARGET's id", async () => {
    // `buildBrainBlock` resolves visibility from the caller it is handed. The
    // target's id here is the difference between showing this person's brain
    // and showing the admin's.
    await inspectPromptForPerson(prisma, { targetUserId: "target-id" });
    expect(mocks.buildBrainBlock).toHaveBeenCalledWith(prisma, {
      id: "target-id",
      role: "owner",
    });
  });
});

// ── the unresolved case ─────────────────────────────────────────────────────

describe("🔴 an unresolvable person composes nothing at all", () => {
  it("names the failure and calls no composer", async () => {
    // Guessing a tier in order to render something produces a prompt nobody
    // ever receives — a page that is confidently describing a fiction.
    mocks.attributed.mockResolvedValue({
      scope: null,
      tier: null,
      unresolved: "user_deactivated",
    });
    const r = await inspectPromptForPerson(prisma, { targetUserId: "gone" });

    expect(r.unresolved).toBe("user_deactivated");
    expect(r.blocks).toEqual([]);
    expect(r.assembled).toBe("");
    expect(mocks.composePersonaBlock).not.toHaveBeenCalled();
    expect(mocks.buildBrainBlock).not.toHaveBeenCalled();
  });
});

// ── assembly ────────────────────────────────────────────────────────────────

describe("🔴 the assembled prompt is the real string, in the real order", () => {
  it("assembles identity, persona, business, guidance, then memory and brain", async () => {
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });

    // Order, not merely membership: the splice order is a design decision
    // (persona refines HOW Droplet talks and must not outrank identity), and a
    // page that showed the blocks in a different order than the model receives
    // them would misrepresent precedence.
    const idx = (s: string) => r.assembled.indexOf(s);
    expect(idx("IDENTITY")).toBe(0);
    expect(idx("PERSONA")).toBeGreaterThan(idx("IDENTITY"));
    expect(idx("BUSINESS")).toBeGreaterThan(idx("PERSONA"));
    expect(idx("GUIDANCE")).toBeGreaterThan(idx("BUSINESS"));
    expect(idx("MEMORY")).toBeGreaterThan(idx("GUIDANCE"));
    expect(idx("BRAIN")).toBeGreaterThan(idx("MEMORY"));
    expect(r.assembledChars).toBe(r.assembled.length);
  });

  it("omits a block the composer could not produce, rather than inventing one", async () => {
    mocks.composePersonaBlock.mockReturnValue("");
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });
    expect(r.assembled).not.toContain("PERSONA");
    expect(r.assembled).toContain("IDENTITY");
  });

  it("appends the interview conductor and the off-LAN notice only when asked", async () => {
    const plain = await inspectPromptForPerson(prisma, { targetUserId: "u1" });
    expect(blockOf(plain, "interview").status).toBe("absent");
    expect(blockOf(plain, "off_lan_notice").status).toBe("absent");

    const both = await inspectPromptForPerson(prisma, {
      targetUserId: "u1",
      interview: true,
      offLan: true,
    });
    expect(blockOf(both, "interview").status).toBe("present");
    expect(blockOf(both, "off_lan_notice").status).toBe("present");
    expect(both.assembled.length).toBeGreaterThan(plain.assembled.length);
  });

  it("passes the caller's allowed tool names to the guidance composer, verbatim", async () => {
    // WARP-642: guidance must never name a tool the person cannot call.
    // `undefined` is the builder's own encoding for "privileged, every tool"
    // and has to survive as undefined rather than becoming an empty list,
    // which would compose guidance for a caller with NO tools.
    await inspectPromptForPerson(prisma, {
      targetUserId: "u1",
      allowedToolNames: ["read_file", "list_files"],
    });
    expect(mocks.composeToolGuidance).toHaveBeenCalledWith(["read_file", "list_files"]);

    mocks.composeToolGuidance.mockClear();
    await inspectPromptForPerson(prisma, { targetUserId: "u1" });
    expect(mocks.composeToolGuidance).toHaveBeenCalledWith(undefined);
  });
});

// ── the block nobody can reconstruct ────────────────────────────────────────

describe("🔴 pins are declared un-modelled rather than reported absent", () => {
  it("says so, with its budget, instead of showing a false negative", async () => {
    // Pins belong to a conversation and this view is per person. Rendering
    // them as `absent` would tell an admin that somebody whose every turn
    // carries four pins receives none.
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });
    const pins = blockOf(r, "context_pins");

    expect(pins.status).toBe("not_modelled");
    expect(pins.note).toBeTruthy();
    expect(pins.cap).toBe(1400);
  });

  it("every block carries its own budget and its drop-immunity", async () => {
    // The two facts an admin needs beside a size. Which blocks survive an
    // overflow is exactly the kind of thing that rots when it lives in the UI.
    const r = await inspectPromptForPerson(prisma, { targetUserId: "u1" });
    expect(blockOf(r, "identity").neverDropped).toBe(true);
    expect(blockOf(r, "tool_guidance").neverDropped).toBe(true);
    expect(blockOf(r, "persona").neverDropped).toBe(false);
    expect(blockOf(r, "business").neverDropped).toBe(false);
    expect(blockOf(r, "brain").neverDropped).toBe(false);
    expect(blockOf(r, "persona").cap).toBe(1200);
    expect(blockOf(r, "business").cap).toBe(1500);
  });
});
