/**
 * Unit tests for the onboarding setup state machine (PR #372 /
 * docs/ONBOARDING_STATE_MACHINE.md).
 *
 * The service owns the singleton `ApplianceSetup` row and the legal
 * transitions over it. State is an EXPLICIT column (`state` =
 * "unclaimed" | "ready", `setupStep` = SetupStep enum) — never derived
 * from absence (CLAUDE.md no-guessing rule; WARP-218
 * `BrainMemoryItemStatus` precedent).
 *
 * Strategy: an in-memory Prisma stand-in for the single
 * `applianceSetup` model. We assert:
 *   - first read materializes the singleton at the welcome / unclaimed
 *     default (resumability has somewhere to start from);
 *   - persisting a setup step round-trips (mid-wizard refresh returns to
 *     the same step — the headline AC);
 *   - an unknown step is rejected, not silently coerced;
 *   - marking the appliance ready flips the explicit `state` column;
 *   - the tour-completed flag flips independently of `state`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// The global `@prisma/client` vi.mock in src/__tests__/setup.ts stubs only
// `PrismaClient` + `Prisma` — it does NOT export the generated enums. The
// service deliberately imports `SetupStep` as a TYPE only (SETUP_STEPS is a
// string-literal tuple checked against the enum at compile time), so the
// service itself runs fine under the global mock. We unmock here purely so
// the runtime cross-check below (`Object.values(SetupStep)` must contain
// every shipped step) resolves the REAL generated enum object — same
// unmock pattern as activity-schema.test.ts.
vi.unmock("@prisma/client");

import { SetupStep } from "@prisma/client";
import {
  getSetupState,
  setSetupStep,
  markApplianceReady,
  markTourCompleted,
  isSetupStep,
  SETUP_STEPS,
  InvalidSetupStepError,
  SetupNotCompleteError,
} from "./setup.service.js";

// ── In-memory applianceSetup singleton store ──
//
// Mirrors the slice of PrismaClient the service touches: findUnique +
// upsert keyed on the pinned `id`. The real model pins `id` to a fixed
// singleton value the same way `Workspace` pins `id = 1`.
function createPrismaMock(opts: { userCount?: number } = {}) {
  let row: Record<string, unknown> | null = null;
  let userCount = opts.userCount ?? 1;
  return {
    _peek: () => row,
    _setUserCount: (n: number) => {
      userCount = n;
    },
    // M2 — `markApplianceReady` requires at least one admin (User) row
    // before it will claim the box. Defaults to 1 so the existing
    // happy-path cases keep flipping ready.
    user: {
      count: async () => userCount,
    },
    applianceSetup: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        row && row.id === where.id ? { ...row } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (row && row.id === where.id) {
          row = { ...row, ...update, updatedAt: new Date() };
        } else {
          // Mirror the Prisma schema column defaults the real DB applies
          // on insert, so a `create: { id }` (no other fields) lands the
          // documented welcome/unclaimed/false baseline.
          row = {
            state: "unclaimed",
            setupStep: "welcome",
            userTourCompleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
        }
        return { ...row };
      },
    },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe("setup.service — state machine", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("returns the welcome/unclaimed default on first read WITHOUT writing (M5)", async () => {
    const state = await getSetupState(prisma as never);
    expect(state.appliance).toBe("unclaimed");
    expect(state.setupStep).toBe("welcome");
    expect(state.userTourCompleted).toBe(false);
    // M5 — the public GET must be side-effect-free: a read on a fresh
    // appliance synthesizes the default in memory and does NOT materialize
    // a row (the migration seed / authenticated writers own that).
    expect(prisma._peek()).toBeNull();
  });

  it("persists and round-trips a setup step (resumable mid-wizard)", async () => {
    await setSetupStep(prisma as never, "storage");
    const state = await getSetupState(prisma as never);
    expect(state.setupStep).toBe("storage");
    // Still unclaimed — advancing the wizard step does NOT claim the box.
    expect(state.appliance).toBe("unclaimed");
  });

  it("round-trips every shipped step", async () => {
    for (const step of SETUP_STEPS) {
      await setSetupStep(prisma as never, step);
      const state = await getSetupState(prisma as never);
      expect(state.setupStep).toBe(step);
    }
  });

  it("rejects an unknown step instead of coercing it", async () => {
    await expect(
      setSetupStep(prisma as never, "claim"),
    ).rejects.toBeInstanceOf(InvalidSetupStepError);
    await expect(
      setSetupStep(prisma as never, "not-a-step"),
    ).rejects.toBeInstanceOf(InvalidSetupStepError);
  });

  it("marks the appliance ready via the explicit state column", async () => {
    await getSetupState(prisma as never); // unclaimed baseline
    const after = await markApplianceReady(prisma as never);
    expect(after.appliance).toBe("ready");
    // Re-reading reflects the persisted flip (explicit, not derived).
    const reread = await getSetupState(prisma as never);
    expect(reread.appliance).toBe("ready");
  });

  it("REFUSES to mark ready when no admin account exists (M2 — anti-lockout)", async () => {
    // The lockout vector: flipping an account-less box "ready" would route
    // every visitor to /login on a box with no credentials. markApplianceReady
    // must fail CLOSED until setup actually completed (an admin row exists).
    prisma._setUserCount(0);
    await expect(
      markApplianceReady(prisma as never),
    ).rejects.toBeInstanceOf(SetupNotCompleteError);
    // The appliance stays unclaimed — no partial write.
    const reread = await getSetupState(prisma as never);
    expect(reread.appliance).toBe("unclaimed");
  });

  it("marks ready once an admin account exists (precondition satisfied)", async () => {
    prisma._setUserCount(0);
    await expect(
      markApplianceReady(prisma as never),
    ).rejects.toBeInstanceOf(SetupNotCompleteError);
    // Admin is created (POST /auth/setup) → the claim now succeeds.
    prisma._setUserCount(1);
    const after = await markApplianceReady(prisma as never);
    expect(after.appliance).toBe("ready");
  });

  it("flips tour-completed independently of appliance state", async () => {
    const after = await markTourCompleted(prisma as never);
    expect(after.userTourCompleted).toBe(true);
    // Marking the tour done must not implicitly claim the appliance.
    expect(after.appliance).toBe("unclaimed");
    const reread = await getSetupState(prisma as never);
    expect(reread.userTourCompleted).toBe(true);
  });

  it("isSetupStep is a precise type guard over the shipped 9 steps", () => {
    expect(SETUP_STEPS).toEqual([
      "welcome",
      "account",
      "internet",
      "storage",
      "discovery",
      "cameras",
      "vpn",
      "ai",
      "done",
    ]);
    expect(isSetupStep("welcome")).toBe(true);
    expect(isSetupStep("done")).toBe(true);
    // Gated steps (claim/org/team) are NOT wired here — they extend the
    // enum when they ship (see GATE constraint in PR #372).
    expect(isSetupStep("claim")).toBe(false);
    expect(isSetupStep("org")).toBe(false);
    expect(isSetupStep("team")).toBe(false);
    expect(isSetupStep("")).toBe(false);
    // Every member of the runtime list is a member of the Prisma enum.
    for (const step of SETUP_STEPS) {
      expect(Object.values(SetupStep)).toContain(step);
    }
  });
});
