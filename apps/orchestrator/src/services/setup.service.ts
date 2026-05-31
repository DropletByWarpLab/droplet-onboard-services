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
 * The 9 SHIPPED wizard steps, in wizard order. Mirrors the dashboard
 * wizard's `STEPS` array 1:1. The GATE constraint (PR #372) keeps
 * claim / org / team OUT until they ship — they extend `SetupStep`, this
 * list, the wizard array, and the route validation together.
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
  "account",
  "internet",
  "storage",
  "discovery",
  "cameras",
  "vpn",
  "ai",
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

/**
 * Read the current setup state, materializing the singleton at the
 * welcome / unclaimed default on first call. We upsert (not just read)
 * so the row exists for subsequent writers — and so resumability has a
 * concrete anchor from the very first `/setup/state` hit.
 */
export async function getSetupState(prisma: PrismaClient): Promise<SetupState> {
  const row = await prisma.applianceSetup.upsert({
    where: { id: APPLIANCE_SETUP_ID },
    create: { id: APPLIANCE_SETUP_ID },
    update: {},
  });
  return toSetupState(row);
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
 */
export async function markApplianceReady(
  prisma: PrismaClient,
): Promise<SetupState> {
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
