/**
 * WARP-1118 — persona composition + singleton CRUD (§7.1, §7.3, §10).
 *
 *   composePersonaBlock(persona)  deterministic, char-budgeted style block
 *   getPersona(prisma)            create-default-on-first-read
 *   updatePersona(prisma, patch)  partial update of the singleton
 *
 * Snapshot the composed block per preset (proves determinism + copy),
 * assert the 1200-char cap truncates customInstructions rather than
 * blowing the budget, and prove the CRUD create-on-first-read contract.
 */
import { describe, it, expect, vi } from "vitest";
import {
  composePersonaBlock,
  getPersona,
  updatePersona,
  PERSONA_PROMPT_MAX_CHARS,
  PERSONA_BLOCK_PREFIX,
  type PersonaRow,
} from "./persona.service.js";

const DEFAULT_PERSONA: PersonaRow = {
  id: "singleton",
  preset: "warm_friendly",
  verbosity: "balanced",
  useFirstNames: true,
  customInstructions: "",
  updatedBy: null,
  updatedAt: new Date("2026-07-08T00:00:00.000Z"),
};

function persona(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return { ...DEFAULT_PERSONA, ...overrides };
}

describe("composePersonaBlock", () => {
  it("prefixes with the safety-precedence reminder", () => {
    const block = composePersonaBlock(persona());
    expect(block.startsWith(PERSONA_BLOCK_PREFIX)).toBe(true);
    expect(PERSONA_BLOCK_PREFIX).toContain("never override safety");
  });

  it("is deterministic — same row in, same text out", () => {
    expect(composePersonaBlock(persona())).toBe(composePersonaBlock(persona()));
  });

  it.each([
    "warm_friendly",
    "professional_precise",
    "founder",
    "direct_technical",
  ] as const)("matches the snapshot for preset %s", (preset) => {
    expect(composePersonaBlock(persona({ preset }))).toMatchSnapshot();
  });

  it("reflects verbosity and address-form traits in the block", () => {
    const concise = composePersonaBlock(persona({ verbosity: "concise" }));
    const detailed = composePersonaBlock(persona({ verbosity: "detailed" }));
    expect(concise).not.toBe(detailed);
    expect(concise.toLowerCase()).toContain("concise");
    expect(detailed.toLowerCase()).toContain("thorough");

    const firstNames = composePersonaBlock(persona({ useFirstNames: true }));
    const noFirstNames = composePersonaBlock(persona({ useFirstNames: false }));
    expect(firstNames).not.toBe(noFirstNames);
  });

  it("includes owner-authored customInstructions when present", () => {
    const block = composePersonaBlock(
      persona({ customInstructions: "Always mention the quarterly numbers." }),
    );
    expect(block).toContain("Always mention the quarterly numbers.");
  });

  it("never exceeds PERSONA_PROMPT_MAX_CHARS (1200), truncating instructions", () => {
    expect(PERSONA_PROMPT_MAX_CHARS).toBe(1200);
    const block = composePersonaBlock(
      persona({ customInstructions: "x".repeat(5000) }),
    );
    expect(block.length).toBeLessThanOrEqual(PERSONA_PROMPT_MAX_CHARS);
    // The preset/verbosity lines survive; only the free-text tail is cut.
    expect(block).toContain(PERSONA_BLOCK_PREFIX);
  });
});

describe("getPersona (create-default-on-first-read)", () => {
  it("creates the singleton with defaults when none exists yet", async () => {
    const created: PersonaRow[] = [];
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Partial<PersonaRow> }) => {
          const row = persona(data);
          created.push(row);
          return row;
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await getPersona(prisma as any);
    expect(prisma.assistantPersona.findUnique).toHaveBeenCalledWith({
      where: { id: "singleton" },
    });
    expect(prisma.assistantPersona.create).toHaveBeenCalledTimes(1);
    expect(row.id).toBe("singleton");
    expect(row.preset).toBe("warm_friendly");
    expect(row.verbosity).toBe("balanced");
  });

  it("returns the existing singleton without creating a second row", async () => {
    const existing = persona({ preset: "founder" });
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await getPersona(prisma as any);
    expect(row.preset).toBe("founder");
    expect(prisma.assistantPersona.create).not.toHaveBeenCalled();
  });
});

describe("updatePersona", () => {
  it("upserts the singleton, stamping updatedBy", async () => {
    let stored: PersonaRow | null = null;
    const prisma = {
      assistantPersona: {
        upsert: vi.fn(
          async ({
            create,
            update,
          }: {
            create: Partial<PersonaRow>;
            update: Partial<PersonaRow>;
          }) => {
            stored = stored
              ? persona({ ...stored, ...update })
              : persona({ ...create });
            return stored;
          },
        ),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await updatePersona(prisma as any, {
      preset: "direct_technical",
      updatedBy: "owner-uuid",
    });
    expect(prisma.assistantPersona.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.assistantPersona.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ id: "singleton" });
    expect(row.preset).toBe("direct_technical");
    expect(row.updatedBy).toBe("owner-uuid");
  });
});
