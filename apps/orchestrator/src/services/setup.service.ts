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
import { type SetupStep, type PrismaClient, type Prisma } from "@prisma/client";
import { isClaimed } from "./claim-code.service.js";

/**
 * WARP-867 (pr-reviewer on #599) — the client surface the state machine
 * reads/writes through: the root client OR an interactive-transaction client
 * (`tx`), so `advanceSetupStepToAtLeast` can run its floor compare + write
 * ATOMICALLY while every reader/writer keeps going through this module's
 * single enforcement point. Type-only — the module still has no runtime
 * dependency on `@prisma/client` (see the SETUP_STEPS note below).
 */
export type SetupDbClient = PrismaClient | Prisma.TransactionClient;

/** The fixed primary key of the singleton row. Mirrors `Workspace.id = 1`. */
export const APPLIANCE_SETUP_ID = "singleton";

/**
 * WARP-804 — the wizard step the customer resumes on once the appliance is
 * CLAIMED. `claim` slots FIRST (welcome → claim → account, #371 handoff §1), so
 * a claimed box belongs on `account`. This is the SINGLE source of truth for
 * that step name: the claim route (`routes/setup.ts`) imports it instead of
 * redefining it, and the state machine below uses it to heal a `claim` step
 * that was persisted on (or is being written to) an already-claimed box.
 *
 * WHY this lives here, in the state-machine module: a `claim` step on a claimed
 * box is unsatisfiable — the consumed code's plaintext is gone (memo-only,
 * rotates), so a re-presented claim step can never be satisfied and the
 * dashboard stays gated. `claim` must therefore be treated as SATISFIED once
 * `isClaimed` is true, and the only place that decision can be made for BOTH
 * the read (`getSetupState`) and the write (`setSetupStep`) is here.
 *
 * Typed against the Prisma enum via the SETUP_STEPS tuple membership.
 */
export const STEP_AFTER_CLAIM: SetupStep = "account";

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
 *
 * WARP-804 — if the persisted step is `claim` but the box is ALREADY claimed,
 * that step is unsatisfiable (the consumed code's plaintext is gone), so the
 * EFFECTIVE step is resolved IN MEMORY to STEP_AFTER_CLAIM. The healing is
 * read-only: we never write here (M5 is preserved — `setSetupStep` durably
 * heals the row on the next wizard write). The `isClaimed` count is only
 * issued when the step is actually `claim`, so non-claim reads (the
 * overwhelming majority) keep their exact single-query behaviour.
 */
export async function getSetupState(prisma: SetupDbClient): Promise<SetupState> {
  const row = await prisma.applianceSetup.findUnique({
    where: { id: APPLIANCE_SETUP_ID },
  });
  const state = row ? toSetupState(row) : DEFAULT_STATE;
  if (state.setupStep === "claim" && (await isClaimed(prisma))) {
    return { ...state, setupStep: STEP_AFTER_CLAIM };
  }
  return state;
}

/**
 * Persist the wizard step the customer is on. This is the resumability
 * write: the dashboard calls it as the wizard advances so a refresh
 * routes back to the same step. Rejects unknown steps.
 *
 * WARP-804 — a write that would park the box on `claim` while it is ALREADY
 * claimed is refused: `claim` is unsatisfiable on a claimed box (the consumed
 * code's plaintext is gone), so persisting it would re-create the dead-end the
 * dashboard gets gated on. Instead we DURABLY advance to STEP_AFTER_CLAIM and
 * return that — self-healing the row so a later read resumes on `account`. The
 * `isClaimed` check is gated behind `step === "claim"`, so every other step
 * write keeps its exact single-write behaviour. When NOT claimed, `claim` is
 * persisted unchanged (the claim step still shows on a fresh box).
 */
export async function setSetupStep(
  prisma: SetupDbClient,
  step: string,
): Promise<SetupState> {
  if (!isSetupStep(step)) {
    throw new InvalidSetupStepError(step);
  }
  const effectiveStep: SetupStep =
    step === "claim" && (await isClaimed(prisma)) ? STEP_AFTER_CLAIM : step;
  const row = await prisma.applianceSetup.upsert({
    where: { id: APPLIANCE_SETUP_ID },
    create: { id: APPLIANCE_SETUP_ID, setupStep: effectiveStep },
    update: { setupStep: effectiveStep },
  });
  return toSetupState(row);
}

/**
 * WARP-867 — monotonic variant of `setSetupStep` for flows that may legally
 * REPLAY an early wizard step on a box whose persisted pointer is already
 * further along. The claim route is the canonical caller: after a reboot the
 * wizard can restart from `welcome` (a cold load that raced the state probe),
 * the customer re-enters the code, and the ALREADY_CLAIMED short-circuit used
 * to call `setSetupStep(STEP_AFTER_CLAIM)` unconditionally — dragging a
 * pointer like `internet` back to `account`. Once the owner row exists the
 * account step is unsatisfiable (POST /auth/setup 409s OWNER_EXISTS), so the
 * regressed pointer parked the box on a dead-end resume target.
 *
 * Floor semantics: persist `step` only when the CURRENT pointer orders
 * strictly before it in `SETUP_STEPS` (wizard order); otherwise return the
 * stored state untouched. The comparison uses `getSetupState`, so the
 * WARP-804 claim→account healing applies before ordering.
 *
 * ATOMICITY (pr-reviewer on #599) — the compare and the write run inside ONE
 * SERIALIZABLE interactive transaction, not two independent round-trips. As
 * separate calls, a re-claim racing a wizard PATCH could read `welcome`, lose
 * the race to a committed `internet`, then blind-upsert `account` — regressing
 * the pointer the floor exists to protect. READ COMMITTED (Prisma's default)
 * is not enough: both sides of the race can pass the compare before either
 * commit. Under SERIALIZABLE the losing side aborts with P2034 ("retry your
 * transaction"); the operation is idempotent and converges (a competitor that
 * advanced further turns the retry into a pure read), so we retry a bounded
 * number of times — same pattern as `reset.service`'s double-fire guard
 * (pr-reviewer #549).
 */
const ADVANCE_TX_ATTEMPTS = 3;

export async function advanceSetupStepToAtLeast(
  prisma: PrismaClient,
  step: string,
): Promise<SetupState> {
  if (!isSetupStep(step)) {
    throw new InvalidSetupStepError(step);
  }
  let conflict: unknown;
  for (let attempt = 0; attempt < ADVANCE_TX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const current = await getSetupState(tx);
          const currentIdx = SETUP_STEPS.indexOf(current.setupStep);
          const targetIdx = SETUP_STEPS.indexOf(step);
          if (currentIdx >= targetIdx) {
            return current;
          }
          return setSetupStep(tx, step);
        },
        // The string literal (vs `Prisma.TransactionIsolationLevel.Serializable`)
        // keeps this module free of runtime `@prisma/client` imports (the
        // SETUP_STEPS note above); the `$transaction` options type still
        // checks it against the generated isolation-level union.
        { isolationLevel: "Serializable" },
      );
    } catch (err) {
      if (!isSerializationConflict(err)) {
        throw err;
      }
      conflict = err;
    }
  }
  throw conflict;
}

/**
 * Prisma surfaces a Postgres serialization failure (the losing side of two
 * concurrent SERIALIZABLE transactions) as P2034. Detected by error code
 * rather than `instanceof Prisma.PrismaClientKnownRequestError` so the check
 * holds across client instances (and test doubles) — mirrors
 * `reset.service.ts`.
 */
function isSerializationConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2034"
  );
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
