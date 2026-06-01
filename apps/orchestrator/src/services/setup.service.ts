/**
 * Onboarding setup state machine (PR #372 /
 * docs/ONBOARDING_STATE_MACHINE.md).
 *
 * Owns the singleton `ApplianceSetup` row and the legal transitions over
 * it. Every reader/writer goes through here so the explicit-state
 * invariant (CLAUDE.md no-guessing rule) has exactly one enforcement
 * point. The closest precedent is `settings-workspace.ts` operating on
 * the `Workspace` singleton (id = 1, get-or-default, upsert on write).
 *
 * Wire shape returned to the dashboard's `AuthGate` (snake_case in the
 * route layer; this service returns the camelCase domain object):
 *   { appliance: "unclaimed" | "ready", setupStep, userTourCompleted }
 */
import { type SetupStep, type PrismaClient } from "@prisma/client";

/** The fixed primary key of the singleton row. Mirrors `Workspace.id = 1`. */
export const APPLIANCE_SETUP_ID = "singleton";

/**
 * The SHIPPED wizard steps, in WIZARD ORDER. Mirrors the dashboard wizard's
 * `STEPS` array 1:1 — this is the authoritative resume-order, NOT the Prisma
 * enum's declaration order (which only governs membership).
 *
 * PR #373: `claim` ships and slots SECOND (welcome → claim → account, #371
 * handoff §1). PR #380: `org` ships and slots AFTER account (welcome → claim →
 * account → org → internet → …, #380 spec). PR #381: `team` ships and slots
 * near the END, after `ai` and before `done` (… → ai → team → done): once the
 * box is set up the owner brings people in. `team` is the LAST onboarding step
 * to wire — it extends `SetupStep`, this list, the wizard array, and the route
 * validation together, the way claim and org did. `team` IS skippable in the
 * wizard, but it is still a real reachable resume target, so it belongs here.
 *
 * Declared as a plain string-literal tuple (NOT `SetupStep.welcome` etc.)
 * so this module has NO runtime dependency on the Prisma enum OBJECT at
 * import time — that would crash every test importing the app graph under
 * the global `@prisma/client` vi.mock (which only stubs the client, not
 * the generated enums). The `satisfies readonly SetupStep[]` below is a
 * COMPILE-TIME check: each literal must be a member of the Prisma enum, so
 * any drift between the schema enum and this list fails `tsc --noEmit`.
 */
export const SETUP_STEPS = [
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
] as const satisfies readonly SetupStep[];

/** The terminal wizard step (typed against the Prisma enum via the tuple). */
const TERMINAL_STEP: SetupStep = "done";

/** Appliance lifecycle — explicit, never derived. */
export type ApplianceState = "unclaimed" | "ready";

/** The domain shape `AuthGate` routes off. */
export interface SetupState {
  appliance: ApplianceState;
  setupStep: SetupStep;
  userTourCompleted: boolean;
}

/**
 * Thrown when a caller tries to persist a step that isn't one of the
 * shipped `SetupStep` values. We reject rather than coerce so a bad
 * client (or a gated-but-not-wired step leaking in) can never park the
 * appliance on a resume target the wizard can't render. The route layer
 * maps this to a 400.
 */
export class InvalidSetupStepError extends Error {
  public readonly code = "INVALID_SETUP_STEP";
  public readonly step: string;
  constructor(step: string) {
    super(
      `Unknown setup step "${step}". Expected one of: ${SETUP_STEPS.join(", ")}.`,
    );
    this.name = "InvalidSetupStepError";
    this.step = step;
  }
}

/**
 * M2 (PR #372 re-review) — thrown when the `appliance:"ready"` transition is
 * requested before setup has actually completed, i.e. before any admin
 * account exists. Marking an account-less box "ready" would route every
 * subsequent visitor to /login on a box with no credentials = a permanent
 * lockout (and a pre-claim takeover vector). We require proof setup
 * finished — at least one local `User` row — before honoring the claim.
 * The route layer maps this to a 409 Conflict (the request is well-formed
 * but the appliance isn't in a state where it can be claimed yet).
 */
export class SetupNotCompleteError extends Error {
  public readonly code = "SETUP_NOT_COMPLETE";
  constructor() {
    super(
      "Cannot mark the appliance ready before setup completes: no admin account exists yet.",
    );
    this.name = "SetupNotCompleteError";
  }
}

/** Precise type guard over the shipped steps. */
export function isSetupStep(value: unknown): value is SetupStep {
  return (
    typeof value === "string" &&
    (SETUP_STEPS as readonly string[]).includes(value)
  );
}

/** Narrow a Prisma row down to the wire/domain shape. */
function toSetupState(row: {
  state: string;
  setupStep: SetupStep;
  userTourCompleted: boolean;
}): SetupState {
  // `state` is a 2-value String column we are the sole writer of; anything
  // other than "ready" is treated as the safe "unclaimed" default so a
  // hand-edited row can't trick the dashboard into skipping setup.
  const appliance: ApplianceState = row.state === "ready" ? "ready" : "unclaimed";
  return {
    appliance,
    setupStep: row.setupStep,
    userTourCompleted: row.userTourCompleted,
  };
}

/** The welcome / unclaimed baseline returned when the singleton row hasn't
 *  been materialized yet. Mirrors the schema column defaults and the
 *  migration-seeded row, so a read can synthesize it WITHOUT writing. */
const DEFAULT_STATE: SetupState = {
  appliance: "unclaimed",
  setupStep: "welcome",
  userTourCompleted: false,
};

/**
 * Read the current setup state.
 *
 * M5 (PR #372 re-review) — this is a PUBLIC, unauthenticated read, so it
 * MUST be side-effect-free: a `GET /api/setup/state` from any LAN caller
 * can never write. We `findUnique` and fall back to the welcome/unclaimed
 * default in memory. The row is materialized by the migration seed
 * (`INSERT ... ON CONFLICT DO NOTHING`) and by the authenticated writers
 * below, so a real appliance always has a concrete row to resume from; the
 * in-memory default only covers the pre-migration / fresh-mock edge.
 */
export async function getSetupState(prisma: PrismaClient): Promise<SetupState> {
  const row = await prisma.applianceSetup.findUnique({
    where: { id: APPLIANCE_SETUP_ID },
  });
  return row ? toSetupState(row) : DEFAULT_STATE;
}

/**
 * Persist the wizard step the customer is on. This is the resumability
 * write: the dashboard calls it as the wizard advances so a refresh
 * routes back to the same step. Rejects unknown steps.
 */
export async function setSetupStep(
  prisma: PrismaClient,
  step: string,
): Promise<SetupState> {
  if (!isSetupStep(step)) {
    throw new InvalidSetupStepError(step);
  }
  const row = await prisma.applianceSetup.upsert({
    where: { id: APPLIANCE_SETUP_ID },
    create: { id: APPLIANCE_SETUP_ID, setupStep: step },
    update: { setupStep: step },
  });
  return toSetupState(row);
}

/**
 * Flip the appliance to "ready" — the wizard-finish transition. Explicit
 * column write; the dashboard never infers ready-ness from `setupStep`.
 * Also lands the step on `done` so the persisted row is internally
 * consistent (a ready appliance is on the terminal step).
 *
 * M2 (PR #372 re-review) — PRECONDITION: setup must actually have
 * completed before the box can be claimed. Without this guard an
 * account-less box could be flipped "ready" (by a pre-claim LAN attacker,
 * or a buggy client), after which `AuthGate` routes every visitor to
 * /login on a box with NO admin — a permanent lockout. We fail CLOSED.
 *
 * "Setup completed" is proven by EITHER:
 *   - `opts.authorized === true` — the caller presented a valid dashboard
 *     session (verified inline in the route). A session can only exist if
 *     an admin account was created and logged in, so it IS proof of a
 *     completed account step — this covers the narrow window where the
 *     finish PATCH fires from the freshly-authenticated wizard before any
 *     other admin-count read could observe the new row; OR
 *   - at least one local `User` (admin) row exists.
 * Neither ⇒ `SetupNotCompleteError` (409), appliance stays unclaimed.
 * Once claimable, a re-flip is an idempotent no-op.
 */
export async function markApplianceReady(
  prisma: PrismaClient,
  opts: { authorized?: boolean } = {},
): Promise<SetupState> {
  if (!opts.authorized) {
    const adminCount = await prisma.user.count();
    if (adminCount === 0) {
      throw new SetupNotCompleteError();
    }
  }
  const row = await prisma.applianceSetup.upsert({
    where: { id: APPLIANCE_SETUP_ID },
    create: { id: APPLIANCE_SETUP_ID, state: "ready", setupStep: TERMINAL_STEP },
    update: { state: "ready", setupStep: TERMINAL_STEP },
  });
  return toSetupState(row);
}

/**
 * Mark the post-claim product tour complete. Independent of `state` —
 * finishing the tour does not claim the appliance and claiming the
 * appliance does not skip the tour.
 */
export async function markTourCompleted(
  prisma: PrismaClient,
): Promise<SetupState> {
  const row = await prisma.applianceSetup.upsert({
    where: { id: APPLIANCE_SETUP_ID },
    create: { id: APPLIANCE_SETUP_ID, userTourCompleted: true },
    update: { userTourCompleted: true },
  });
  return toSetupState(row);
}
