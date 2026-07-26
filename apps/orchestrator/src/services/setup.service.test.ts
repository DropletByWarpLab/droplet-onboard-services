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
  advanceSetupStepToAtLeast,
  markApplianceReady,
  markTourCompleted,
  isSetupStep,
  SETUP_STEPS,
  STEP_AFTER_CLAIM,
  InvalidSetupStepError,
  SetupNotCompleteError,
} from "./setup.service.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

// ── In-memory applianceSetup singleton store ──
//
// Mirrors the slice of PrismaClient the service touches: findUnique +
// upsert keyed on the pinned `id`. The real model pins `id` to a fixed
// singleton value the same way `Workspace` pins `id = 1`.
function createPrismaMock(opts: { userCount?: number; consumedClaims?: number } = {}) {
  let row: Record<string, unknown> | null = null;
  let userCount = opts.userCount ?? 1;
  // WARP-804 — how many `consumed` ClaimCode rows exist, i.e. whether the box
  // is claimed (`isClaimed` counts `state="consumed"`). Defaults to 0 (NOT
  // claimed) so every pre-existing case keeps its byte-for-byte behaviour: the
  // claim-satisfied short-circuit in getSetupState/setSetupStep only fires when
  // this is > 0, and these legacy cases never claim the box.
  let consumedClaims = opts.consumedClaims ?? 0;
  const prisma = {
    _peek: () => row,
    _setUserCount: (n: number) => {
      userCount = n;
    },
    // WARP-804 — simulate the box being claimed (a consumed ClaimCode exists).
    _setConsumedClaims: (n: number) => {
      consumedClaims = n;
    },
    // M2 — `markApplianceReady` requires at least one admin (User) row
    // before it will claim the box. Defaults to 1 so the existing
    // happy-path cases keep flipping ready.
    user: {
      count: async () => userCount,
    },
    // WARP-804 — the slice of `claimCode` that `isClaimed` touches: a count of
    // rows in the `consumed` state. Mirrors `prisma.claimCode.count({ where:
    // { state: "consumed" } })`.
    claimCode: {
      count: async ({ where }: { where?: { state?: string } } = {}) =>
        where?.state === "consumed" ? consumedClaims : 0,
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
  // WARP-867 (pr-reviewer on #599) — interactive-transaction stand-in: runs
  // the callback against the SAME in-memory store (the `tx` client sees the
  // singleton row), recording calls + options so tests can assert the
  // monotonic floor compare AND its write happen inside ONE Serializable
  // transaction. Same callback-against-the-store shape as
  // setup-claim.test.ts / network.schedules.test.ts.
  // WARP-1570: the shared seam replaces the local stand-in. It records the
  // options (so the "ONE Serializable transaction" assertion below keeps its
  // teeth), and additionally rolls the singleton row back when the callback
  // throws — which the old stand-in did not, so a partial write survived a
  // refusal unnoticed. `row` is REASSIGNED by the upsert, hence the accessor
  // form: a bare reference could not see the rebinding.
  const seam = createTransactionSeam({
    client: () => out,
    stores: {
      row: {
        get: () => row,
        set: (next: unknown) => {
          row = next as typeof row;
        },
      },
    },
  });
  const out = Object.assign(prisma, {
    $transaction: seam.$transaction,
    _seam: () => seam,
  });
  return out;
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
    // PR #381 ships `team`, so it is no longer the not-yet-shipped sentinel.
    // A truly unknown step is still rejected (not silently coerced).
    await expect(
      setSetupStep(prisma as never, "not-a-step"),
    ).rejects.toBeInstanceOf(InvalidSetupStepError);
    await expect(
      setSetupStep(prisma as never, "department"),
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

  it("isSetupStep is a precise type guard over the shipped steps (team now wired, PR #381)", () => {
    // PR #373: `claim` slots SECOND. PR #380: `org` slots AFTER account.
    // PR #381: `team` slots near the END, after `ai` and before `done`
    // (welcome → claim → account → org → internet → storage → discovery →
    // cameras → vpn → ai → team → done).
    expect(SETUP_STEPS).toEqual([
      "welcome",
      "claim",
      "account",
      "org",
      "internet",
      "storage",
      "discovery",
      "cameras",
      "vpn",
      "ai",
      "team",
      "done",
    ]);
    expect(isSetupStep("welcome")).toBe(true);
    expect(isSetupStep("done")).toBe(true);
    // claim + org + team are now real, wired steps (PR #373 / #380 / #381).
    expect(isSetupStep("claim")).toBe(true);
    expect(isSetupStep("org")).toBe(true);
    expect(isSetupStep("team")).toBe(true);
    expect(isSetupStep("")).toBe(false);
    // Every member of the runtime list is a member of the Prisma enum.
    for (const step of SETUP_STEPS) {
      expect(Object.values(SetupStep)).toContain(step);
    }
  });
});

// ── WARP-804 — a persisted `claim` step on an ALREADY-CLAIMED box is an
// unsatisfiable dead-end (the consumed code's plaintext is gone, so the claim
// step can never be re-satisfied → CLAIM_CODE_INVALID → lockout). The state
// machine must treat `claim` as SATISFIED once `isClaimed` is true and resolve
// the effective step to STEP_AFTER_CLAIM, both on read and on write. Behaviour
// when NOT claimed is unchanged (the claim step still shows). ──
describe("setup.service — claim step is satisfied once the box is claimed (WARP-804)", () => {
  it("exposes STEP_AFTER_CLAIM as the post-claim resume target (account)", () => {
    // Single source of truth shared with the claim route. `account` slots
    // immediately after `claim` in the wizard order.
    expect(STEP_AFTER_CLAIM).toBe("account");
    expect(isSetupStep(STEP_AFTER_CLAIM)).toBe(true);
  });

  it("getSetupState resolves a persisted `claim` step to STEP_AFTER_CLAIM when claimed", async () => {
    const prisma = createPrismaMock({ consumedClaims: 1 });
    // Persist the dead-end state the bug parks the box on: setupStep=claim on a
    // box that has already been claimed (a consumed ClaimCode exists).
    await setSetupStep(prisma as never, STEP_AFTER_CLAIM); // materialize the row
    prisma._peek(); // (no-op; row now exists)
    // Force the persisted step back to `claim` directly via the mock to model a
    // box that genuinely has `claim` persisted while claimed.
    (prisma._peek() as Record<string, unknown>).setupStep = "claim";

    const state = await getSetupState(prisma as never);
    expect(state.setupStep).toBe(STEP_AFTER_CLAIM);
    expect(state.setupStep).not.toBe("claim");
  });

  it("getSetupState is SIDE-EFFECT-FREE while resolving the claimed claim step (M5)", async () => {
    const prisma = createPrismaMock({ consumedClaims: 1 });
    prisma.applianceSetup.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", setupStep: "claim" },
      update: { setupStep: "claim" },
    } as never);
    // Tripwire: the public read must not write, even while healing the step.
    const upsertSpy = vi.spyOn(prisma.applianceSetup, "upsert");
    const state = await getSetupState(prisma as never);
    expect(state.setupStep).toBe(STEP_AFTER_CLAIM);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("setSetupStep does NOT persist `claim` when claimed — it advances to STEP_AFTER_CLAIM", async () => {
    const prisma = createPrismaMock({ consumedClaims: 1 });
    const returned = await setSetupStep(prisma as never, "claim");
    // The returned (effective) step is the post-claim step, never `claim`.
    expect(returned.setupStep).toBe(STEP_AFTER_CLAIM);
    // And the PERSISTED row must not be parked on `claim` either.
    expect((prisma._peek() as Record<string, unknown>).setupStep).toBe(
      STEP_AFTER_CLAIM,
    );
  });

  it("REGRESSION: when NOT claimed, the claim step is persisted and returned unchanged", async () => {
    const prisma = createPrismaMock({ consumedClaims: 0 });
    const returned = await setSetupStep(prisma as never, "claim");
    expect(returned.setupStep).toBe("claim");
    expect((prisma._peek() as Record<string, unknown>).setupStep).toBe("claim");
    // A read of the same unclaimed box still reports `claim` (the step shows).
    const state = await getSetupState(prisma as never);
    expect(state.setupStep).toBe("claim");
  });
});

/**
 * WARP-867 — `advanceSetupStepToAtLeast` is the floor-semantics variant the
 * claim route uses: heal a pointer stranded at/before the target, never drag
 * a further-along pointer backward. The field-report dead-end was a resume
 * pointer regressed onto `account` — unsatisfiable once the owner row exists
 * (POST /auth/setup 409s OWNER_EXISTS).
 */
describe("setup.service — advanceSetupStepToAtLeast floor semantics (WARP-867)", () => {
  it("advances a pointer that is still BEFORE the target", async () => {
    const prisma = createPrismaMock();
    await setSetupStep(prisma as never, "welcome");
    const state = await advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM);
    expect(state.setupStep).toBe(STEP_AFTER_CLAIM);
    expect((prisma._peek() as Record<string, unknown>).setupStep).toBe(
      STEP_AFTER_CLAIM,
    );
  });

  it("does NOT regress a pointer that is already PAST the target", async () => {
    const prisma = createPrismaMock();
    await setSetupStep(prisma as never, "internet");
    const state = await advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM);
    // Returned AND persisted state keep the further-along pointer.
    expect(state.setupStep).toBe("internet");
    expect((prisma._peek() as Record<string, unknown>).setupStep).toBe(
      "internet",
    );
  });

  it("is a no-op when the pointer already EQUALS the target", async () => {
    const prisma = createPrismaMock();
    await setSetupStep(prisma as never, STEP_AFTER_CLAIM);
    const upsertSpy = vi.spyOn(prisma.applianceSetup, "upsert");
    const state = await advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM);
    expect(state.setupStep).toBe(STEP_AFTER_CLAIM);
    // Equal pointer → pure read, no write at all.
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("orders by WIZARD order (SETUP_STEPS), and a claimed box's healed `claim` read participates", async () => {
    // Stored `claim` on a CLAIMED box reads as STEP_AFTER_CLAIM (WARP-804), so
    // advancing to STEP_AFTER_CLAIM is a no-op rather than a real write —
    // the healing and the floor compose.
    const prisma = createPrismaMock({ consumedClaims: 1 });
    // Write the raw row directly via upsert to park the STORED value on claim.
    await prisma.applianceSetup.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", setupStep: "claim" },
      update: { setupStep: "claim" },
    });
    const state = await advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM);
    expect(state.setupStep).toBe(STEP_AFTER_CLAIM);
  });

  it("rejects an unknown step with InvalidSetupStepError", async () => {
    const prisma = createPrismaMock();
    await expect(
      advanceSetupStepToAtLeast(prisma as never, "not-a-step"),
    ).rejects.toBeInstanceOf(InvalidSetupStepError);
  });

  // ── Atomicity (pr-reviewer on #599): the floor compare and the write must
  // not be two independent round-trips, or a concurrent re-claim racing a
  // wizard PATCH can regress the resume pointer (read `welcome`, lose the
  // race to a committed `internet`, then blind-upsert `account`). ──

  it("runs the floor compare + write inside ONE Serializable interactive transaction", async () => {
    const prisma = createPrismaMock();
    await setSetupStep(prisma as never, "welcome");
    const state = await advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM);
    expect(state.setupStep).toBe(STEP_AFTER_CLAIM);
    // The read AND the conditional write went through the tx callback —
    // exactly one transaction, opened SERIALIZABLE (READ COMMITTED would
    // let both sides of a race pass the compare before either commit).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });

  it("retries a P2034 serialization conflict and converges on the concurrent winner", async () => {
    const prisma = createPrismaMock();
    await setSetupStep(prisma as never, "welcome");
    prisma.$transaction.mockImplementationOnce(async () => {
      // A concurrent wizard PATCH commits a FURTHER step while our snapshot
      // is open; the SERIALIZABLE engine aborts the losing side with P2034.
      await prisma.applianceSetup.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", setupStep: "internet" },
        update: { setupStep: "internet" },
      });
      const err = new Error(
        "Transaction failed due to a write conflict or a deadlock. Please retry your transaction.",
      ) as Error & { code?: string };
      err.code = "P2034";
      throw err;
    });
    const state = await advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM);
    // The retry re-reads inside a FRESH transaction, sees the winner, and the
    // floor keeps it — the pointer is never dragged back to `account`.
    expect(state.setupStep).toBe("internet");
    expect((prisma._peek() as Record<string, unknown>).setupStep).toBe("internet");
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("gives up after bounded attempts and rethrows the serialization conflict", async () => {
    const prisma = createPrismaMock();
    prisma.$transaction.mockImplementation(async () => {
      const err = new Error("write conflict") as Error & { code?: string };
      err.code = "P2034";
      throw err;
    });
    await expect(
      advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-serialization failure", async () => {
    const prisma = createPrismaMock();
    prisma.$transaction.mockImplementation(async () => {
      throw new Error("connection lost");
    });
    await expect(
      advanceSetupStepToAtLeast(prisma as never, STEP_AFTER_CLAIM),
    ).rejects.toThrow("connection lost");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
