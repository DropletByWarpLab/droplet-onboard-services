/**
 * Unit tests for the onboarding ORG step service (PR #380 / WARP onb org).
 *
 * The org step names the single workspace ("company brain"), reserves its
 * `droplet.local/<slug>`, and records LOCAL-only smart-default hints
 * (industry / size). This file pins the pure logic:
 *
 *   - normalizeSlug  — lowercases + trims; never substitutes characters.
 *   - isValidSlug    — `[a-z0-9-]`, not empty, not a reserved word, no
 *                      leading/trailing/double hyphen.
 *   - persistOrg     — upserts the Workspace singleton (id = 1), sets the
 *                      explicit `orgConfigured` flag (no IS-NULL guessing),
 *                      enforces slug uniqueness, and returns the reserved
 *                      `droplet.local/<slug>` host.
 *
 * Mirrors setup-claim.service.test.ts: an in-memory Workspace singleton
 * stand-in keyed on the fixed `id = 1`. We unmock @prisma/client so the
 * Prisma error type (P2002) the uniqueness path catches is the real one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.unmock("@prisma/client");

import { Prisma } from "@prisma/client";
import {
  normalizeSlug,
  isValidSlug,
  reservedHostForSlug,
  RESERVED_SLUGS,
  SlugInvalidError,
  SlugTakenError,
  persistOrg,
} from "./setup-org.service.js";

// ── In-memory Workspace singleton store ──
//
// Models the slice persistOrg touches: findUnique({ where: { id: 1 } }),
// findFirst({ where: { slug } }) for the uniqueness pre-check, and upsert
// keyed on id = 1. A second row with a colliding slug throws a real
// Prisma.PrismaClientKnownRequestError P2002 so the catch path is exercised.
function createPrismaMock() {
  let row: Record<string, unknown> | null = null;
  return {
    _seed: (r: Record<string, unknown> | null) => {
      row = r;
    },
    _row: () => row,
    workspace: {
      findUnique: async ({ where }: { where: { id: number } }) =>
        row && row.id === where.id ? { ...row } : null,
      findFirst: async ({ where }: { where: { slug?: string } }) =>
        row && where.slug !== undefined && row.slug === where.slug
          ? { ...row }
          : null,
      upsert: async ({
        create,
        update,
      }: {
        where: { id: number };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        // Simulate the DB unique constraint on `slug`: if a *different*
        // singleton somehow carried this slug we'd collide — but with a
        // true singleton (id = 1) the pre-check is the real guard. We still
        // model P2002 so the service's catch path has coverage.
        row = row ? { ...row, ...update } : { id: 1, ...create };
        return { ...row };
      },
    },
  };
}

type Mock = ReturnType<typeof createPrismaMock>;

describe("setup-org.service — slug normalization + validation", () => {
  it("normalizes case + surrounding whitespace without substituting characters", () => {
    expect(normalizeSlug("  Acme  ")).toBe("acme");
    expect(normalizeSlug("ACME-HQ")).toBe("acme-hq");
    // Internal characters are NOT rewritten — validation rejects, it doesn't
    // silently coerce (so the customer sees their bad input, not a guess).
    expect(normalizeSlug("Acme HQ")).toBe("acme hq");
  });

  it("accepts a [a-z0-9-] slug", () => {
    expect(isValidSlug("acme")).toBe(true);
    expect(isValidSlug("acme-hq")).toBe(true);
    expect(isValidSlug("team-42")).toBe(true);
  });

  it("rejects empty, space, uppercase, and punctuation slugs", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("acme hq")).toBe(false);
    expect(isValidSlug("Acme")).toBe(false);
    expect(isValidSlug("acme_hq")).toBe(false);
    expect(isValidSlug("acme.hq")).toBe(false);
    expect(isValidSlug("acme/hq")).toBe(false);
  });

  it("rejects leading/trailing/double hyphens (clean URL hosts only)", () => {
    expect(isValidSlug("-acme")).toBe(false);
    expect(isValidSlug("acme-")).toBe(false);
    expect(isValidSlug("ac--me")).toBe(false);
  });

  it("rejects reserved words that would collide with platform hosts", () => {
    for (const r of RESERVED_SLUGS) {
      expect(isValidSlug(r)).toBe(false);
    }
  });

  it("reserves droplet.local/<slug> as the workspace host", () => {
    expect(reservedHostForSlug("acme")).toBe("droplet.local/acme");
  });
});

describe("setup-org.service — persistOrg", () => {
  let prisma: Mock;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("persists the workspace, flips the explicit orgConfigured flag, and returns the reserved host", async () => {
    const result = await persistOrg(prisma as never, {
      name: "Acme HQ",
      slug: "acme",
      tz: "America/New_York",
      industry: "logistics",
      size: "11-50",
    });

    expect(result.slug).toBe("acme");
    expect(result.reservedHost).toBe("droplet.local/acme");

    const stored = prisma._row()!;
    expect(stored.displayName).toBe("Acme HQ");
    expect(stored.slug).toBe("acme");
    expect(stored.tz).toBe("America/New_York");
    // Completion is an EXPLICIT column — never inferred from `slug IS NULL`
    // (CLAUDE.md no-guessing rule; WARP-218 precedent).
    expect(stored.orgConfigured).toBe(true);
  });

  it("normalizes the slug before persisting", async () => {
    const result = await persistOrg(prisma as never, {
      name: "Acme HQ",
      slug: "  ACME-HQ  ",
      tz: "America/New_York",
    });
    expect(result.slug).toBe("acme-hq");
    expect(prisma._row()!.slug).toBe("acme-hq");
  });

  it("throws SlugInvalidError on a malformed slug WITHOUT writing", async () => {
    await expect(
      persistOrg(prisma as never, {
        name: "Acme",
        slug: "Acme HQ!",
        tz: "America/New_York",
      }),
    ).rejects.toBeInstanceOf(SlugInvalidError);
    // No partial write — the singleton row was never created.
    expect(prisma._row()).toBeNull();
  });

  it("throws SlugTakenError when the slug is already used by another workspace", async () => {
    // Seed a *different* workspace already holding the slug. (Singleton today,
    // but the uniqueness contract must hold regardless of row identity.)
    prisma._seed({ id: 2, slug: "acme", displayName: "Other", orgConfigured: true });
    await expect(
      persistOrg(prisma as never, {
        name: "Acme HQ",
        slug: "acme",
        tz: "America/New_York",
      }),
    ).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("translates a Prisma P2002 unique-violation into SlugTakenError", async () => {
    // Force the upsert to throw the real unique-constraint error (covers the
    // race where two requests pass the pre-check then collide at the DB).
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test", meta: { target: ["slug"] } },
    );
    prisma.workspace.upsert = async () => {
      throw p2002;
    };
    await expect(
      persistOrg(prisma as never, {
        name: "Acme HQ",
        slug: "acme",
        tz: "America/New_York",
      }),
    ).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("does NOT require industry/size — they are optional LOCAL hints", async () => {
    const result = await persistOrg(prisma as never, {
      name: "Solo Studio",
      slug: "solo",
      tz: "Europe/Berlin",
    });
    expect(result.slug).toBe("solo");
    const stored = prisma._row()!;
    expect(stored.industry ?? null).toBeNull();
    expect(stored.size ?? null).toBeNull();
    expect(stored.orgConfigured).toBe(true);
  });
});

// ── WARP-1325 — the ADR-007 §2 Home/Business pick ──
//
// The org step is the ONLY place a fresh install ever states what kind of
// workspace this is. Before this, nothing set `Workspace.type`, so every
// install stayed at the `HOME` schema default and the Business-gated surfaces
// (Departments & teams, WARP-1270) were permanently unreachable.
describe("setup-org.service — persistOrg workspace type (WARP-1325)", () => {
  let prisma: Mock;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  const base = { name: "Acme HQ", slug: "acme", tz: "America/New_York" };

  it("persists type BUSINESS on a business pick, stamping setBy/setAt", async () => {
    await persistOrg(prisma as never, { ...base, workspaceType: "business" });
    const stored = prisma._row()!;
    expect(stored.type).toBe("BUSINESS");
    // Pre-auth first run — the step itself is the recorded actor.
    expect(stored.setBy).toBe("setup-wizard");
    expect(stored.setAt).toBeInstanceOf(Date);
  });

  it("persists type HOME on a home pick", async () => {
    await persistOrg(prisma as never, { ...base, workspaceType: "home" });
    expect(prisma._row()!.type).toBe("HOME");
  });

  it("records the session owner as setBy when provided", async () => {
    await persistOrg(prisma as never, {
      ...base,
      workspaceType: "business",
      setBy: "owner",
    });
    expect(prisma._row()!.setBy).toBe("owner");
  });

  it("does NOT touch a stored pick when the field is absent (legacy caller)", async () => {
    // An older dashboard bundle re-submits the org form without the pick —
    // the stored BUSINESS type must survive, not get clobbered back to HOME.
    prisma._seed({
      id: 1,
      slug: "acme",
      displayName: "Acme HQ",
      type: "BUSINESS",
      orgConfigured: true,
    });
    await persistOrg(prisma as never, base);
    expect(prisma._row()!.type).toBe("BUSINESS");
  });

  it("leaves type to the schema default when creating without a pick", async () => {
    await persistOrg(prisma as never, base);
    // No `type` key in the create payload — the DB default (HOME) applies.
    expect(prisma._row()!.type).toBeUndefined();
  });
});
