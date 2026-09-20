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
  PersonaRowInvalidError,
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
            where: { id: string };
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

/**
 * WARP-2653 — the create-on-first-read boundary.
 *
 * `getPersona` hands whatever Prisma resolved with straight to
 * `composePersonaBlock`. It used to do that through a double type cast, so a
 * `create` that resolved to `undefined` (a bare `vi.fn()`), a partial
 * `select`, a renamed column or a client extension all reached the composer
 * unchecked and surfaced as `Cannot read properties of undefined` inside the
 * route's fail-open — a prompt silently missing its persona block.
 *
 * The validated set is EXACTLY the four fields `composePersonaBlock` reads
 * (`preset`, `verbosity`, `useFirstNames`, `customInstructions`); `id`,
 * `updatedBy` and `updatedAt` are deliberately not validated because the
 * prompt path never reads them.
 */
describe("getPersona — row validation at the create boundary (WARP-2653)", () => {
  const COMPOSER_FIELDS = [
    "preset",
    "verbosity",
    "useFirstNames",
    "customInstructions",
  ] as const;

  /** The four fields the composer reads, and nothing else — kept honest by
   *  reading the composed block back out of the same row. */
  it("validates exactly the fields composePersonaBlock reads", () => {
    const block = composePersonaBlock(
      persona({ preset: "founder", verbosity: "concise", customInstructions: "x" }),
    );
    // Every validated field is observable in the block; nothing else is.
    expect(block).toContain("energetic");        // preset
    expect(block.toLowerCase()).toContain("concise"); // verbosity
    expect(block).toContain("first name");       // useFirstNames
    expect(block).toContain("x");                // customInstructions
    expect(block).not.toContain(DEFAULT_PERSONA.id);
    expect(block).not.toContain("2026-07-08");   // updatedAt
  });

  it("throws a typed error naming the model when create resolves to undefined", async () => {
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(), // a bare double — resolves to undefined
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await getPersona(prisma as any).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonaRowInvalidError);
    expect((err as PersonaRowInvalidError).message).toBe(
      "AssistantPersona row invalid: expected a row object, got undefined",
    );
    expect((err as PersonaRowInvalidError).field).toBeNull();
  });

  it.each(COMPOSER_FIELDS)(
    "throws a typed error naming %s when the loaded row is missing it",
    async (field) => {
      const row: Record<string, unknown> = { ...persona() };
      delete row[field];
      const prisma = {
        assistantPersona: {
          findUnique: vi.fn(async () => row),
          create: vi.fn(),
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = await getPersona(prisma as any).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PersonaRowInvalidError);
      expect((err as PersonaRowInvalidError).field).toBe(field);
      expect((err as PersonaRowInvalidError).message).toContain(
        "AssistantPersona",
      );
      expect((err as PersonaRowInvalidError).message).toContain(`"${field}"`);
      expect(prisma.assistantPersona.create).not.toHaveBeenCalled();
    },
  );

  it("rejects a preset the composer has no fragment for", async () => {
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => ({ ...persona(), preset: "chatty_pirate" })),
        create: vi.fn(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await getPersona(prisma as any).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonaRowInvalidError);
    expect((err as PersonaRowInvalidError).field).toBe("preset");
  });

  it("rejects a verbosity with no line, which the composer would drop silently", async () => {
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => ({ ...persona(), verbosity: "chatty" })),
        create: vi.fn(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await getPersona(prisma as any).catch((e: unknown) => e);
    expect((err as PersonaRowInvalidError).field).toBe("verbosity");
    // What the composer produces without the guard: `Array.join` renders the
    // missing VERBOSITY_LINE entry as an empty line, so the block LOOKS fine
    // and just quietly stops instructing verbosity — no throw to fail open on.
    const unguarded = composePersonaBlock(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...persona(), verbosity: "chatty" } as any,
    );
    expect(unguarded).toContain("\n\n");
    expect(unguarded).not.toContain("balanced replies");
  });

  it("names the field and never quotes its value (rule 19)", async () => {
    const owned = "call Dr Reyes on 555-0100 about the Bramble account";
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => ({
          ...persona(),
          customInstructions: { note: owned }, // wrong shape, real content
        })),
        create: vi.fn(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await getPersona(prisma as any).catch((e: unknown) => e);
    const message = (err as PersonaRowInvalidError).message;
    expect((err as PersonaRowInvalidError).field).toBe("customInstructions");
    expect(message).not.toContain(owned);
    expect(message).not.toContain("Bramble");
    expect(message).not.toContain("555-0100");
  });

  it("returns a valid row unchanged — same object, unvalidated columns intact", async () => {
    const existing = {
      ...persona({ preset: "founder" }),
      aColumnNothingInThePromptPathReads: 7,
    };
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await getPersona(prisma as any);
    // Identity, not a rebuilt/narrowed copy: nothing is stripped or widened.
    expect(row).toBe(existing);
    expect(
      (row as unknown as Record<string, unknown>)
        .aColumnNothingInThePromptPathReads,
    ).toBe(7);
    expect(composePersonaBlock(row)).toContain("energetic");
  });

  it("validates the CREATED row too, not only the loaded one", async () => {
    const prisma = {
      assistantPersona: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ ...persona(), useFirstNames: "yes" })),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await getPersona(prisma as any).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonaRowInvalidError);
    expect((err as PersonaRowInvalidError).field).toBe("useFirstNames");
  });
});
