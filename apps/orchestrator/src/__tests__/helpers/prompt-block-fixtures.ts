/**
 * WARP-2652 — the shared floor under every route suite that drives
 * `POST /api/llm/chat`: the two prompt blocks the product always sends, and
 * a guard that makes their absence audible.
 *
 * ## The defect this module exists to close
 *
 * `routes/llm.ts` composes the persona block (`getPersona` →
 * `composePersonaBlock`) and the business block (`workspace.findUnique` →
 * `getBusinessProfile` → `composeBusinessBlock`) inside two deliberate
 * fail-open try/catch blocks (`routes/llm.ts:1691-1720`). That posture is
 * correct in production — a persona read failure must not cost a user their
 * answer — but under a test double it converts "the fixture is wrong" into a
 * silent, green run.
 *
 * Sixteen orchestrator route suites had Prisma doubles with no
 * `assistantPersona` / `businessProfile` / `workspace` delegate at all, so
 * every turn in them threw `TypeError: Cannot read properties of undefined
 * (reading 'findUnique')` twice and printed two stderr lines nobody reads —
 * **173 lines a run** at the WARP-2642 baseline. Every prompt those suites
 * measured was missing two blocks the product always sends, and missing them
 * in the direction that HIDES overflow: a prompt smaller than the real one
 * cannot reproduce a budget the real one blows.
 *
 * WARP-2642 fixed one file inline and left a copy-paste shape; this module is
 * that shape promoted to a seam, because the remaining fifteen files would
 * otherwise carry fifteen copies of the same two row literals and the same
 * `afterEach`.
 *
 * ## What is NOT here
 *
 * Not the persona/business FEATURE contracts — ordering, role filtering,
 * budget truncation and the fail-open behaviour itself are owned by
 * `llm-chat.persona-block.test.ts` and `llm-chat.business-block.test.ts`,
 * which build their own rows on purpose. This module only supplies "the
 * blocks render", which is the precondition every OTHER suite silently
 * assumed.
 */
import { afterEach, beforeEach, expect, vi } from "vitest";

/**
 * The persona singleton at its SCHEMA DEFAULTS (`prisma/schema.prisma` —
 * `warm_friendly` / `balanced` / first names / no custom instructions).
 *
 * This is exactly the row `getPersona`'s create-on-first-read materialises on
 * a real box, so the block composed from it is the one a box that has never
 * touched the persona settings actually sends. Matches the rows in
 * `llm-chat.interview.test.ts` and `rbac-tool-narrowing.route.test.ts`.
 */
export const PROMPT_BLOCK_PERSONA_ROW = {
  id: "singleton",
  preset: "warm_friendly",
  verbosity: "balanced",
  useFirstNames: true,
  customInstructions: "",
  updatedBy: null,
  updatedAt: new Date("2026-09-02T00:00:00Z"),
};

/**
 * A COMPLETED business profile — the state the business block exists for.
 *
 * A fresh (`not_started`, all-empty) profile composes to `""` BY DESIGN
 * (`composeBusinessBlock` returns "" when the body is empty), which would
 * leave the block legitimately absent and make a presence assertion untrue
 * rather than merely unenforced. Values are short and obviously fake: the
 * point is that the block renders, not what it says.
 *
 * Deliberately free of words the suites using it assert the ABSENCE of on the
 * assembled prompt — "household", "housemate", and every tool name.
 */
export const PROMPT_BLOCK_BUSINESS_ROW = {
  id: "singleton",
  onboardingState: "completed",
  interviewChatId: null,
  summary: "A fixture business.",
  whatWeDo: "Fixture work.",
  customers: "Fixture customers.",
  teamShape: "Two fixtures.",
  toolsUsed: "Fixture tools.",
  typicalDay: "Fixture days.",
  goals: "Fixture goals.",
  lastSource: "onboarding",
  reviewNudgeState: "none",
  reviewDueAt: null,
  reviewDismissedAt: null,
  updatedBy: null,
  updatedAt: new Date("2026-09-02T00:00:00Z"),
};

/** The BUSINESS-typed workspace singleton the route reads before composing
 *  the business block. A missing `workspace` delegate throws inside the same
 *  try/catch and is indistinguishable, in stderr, from a missing profile. */
export const PROMPT_BLOCK_WORKSPACE_ROW = { id: 1, type: "BUSINESS" };

/**
 * The three Prisma delegates `POST /api/llm/chat` needs to render both blocks.
 *
 * `create` returns the same row as `findUnique` on purpose: both services are
 * create-on-first-read and hand whatever `create` resolved to straight to the
 * composer (`persona.service.ts:116-127`,
 * `business-profile.service.ts:258-269`, both through an `as unknown as`
 * cast), so a bare `vi.fn()` there silently reintroduces the `undefined` that
 * started all of this.
 *
 * Fresh `vi.fn()`s per call — a suite that builds one double per test must not
 * share call history with the previous one.
 */
export function promptBlockPrismaDelegates() {
  return {
    workspace: {
      findUnique: vi.fn(async () => PROMPT_BLOCK_WORKSPACE_ROW),
    },
    businessProfile: {
      findUnique: vi.fn(async () => PROMPT_BLOCK_BUSINESS_ROW),
      create: vi.fn(async () => PROMPT_BLOCK_BUSINESS_ROW),
    },
    assistantPersona: {
      findUnique: vi.fn(async () => PROMPT_BLOCK_PERSONA_ROW),
      create: vi.fn(async () => PROMPT_BLOCK_PERSONA_ROW),
      upsert: vi.fn(),
    },
  };
}

/**
 * Same three delegates, layered over an existing client with a Proxy.
 *
 * For the suites that build the whole app from `new PrismaClient()` — which
 * resolves to the shared in-memory double installed by `src/__tests__/setup.ts`
 * and has none of these three models. A Proxy rather than mutating that double:
 * the seam stays local to the file that opts in, so no other suite's client
 * grows a model behind its back.
 */
export function withPromptBlockDelegates<T extends object>(prisma: T): T {
  const delegates = promptBlockPrismaDelegates() as Record<string, unknown>;
  return new Proxy(prisma, {
    get: (target, prop) =>
      typeof prop === "string" && prop in delegates
        ? delegates[prop]
        : Reflect.get(target, prop),
  });
}

/** The two fail-open log signatures, keyed by the block they belong to. */
const SIGNATURES = {
  persona: "persona load failed",
  business: "business-profile load failed",
} as const;

export type ComposerBlock = keyof typeof SIGNATURES;

/**
 * One `degradeToFit` drop, as `routes/llm.ts:1838` reports it.
 *
 * The route's warn sink is handed the estimator's own event object
 * (`context-budget.service.ts:105-109`) and spreads it into the second
 * `console.warn` argument, so this IS the structured signal — not a parse of
 * the log line. `estimatedTokens` is the estimate AFTER this drop; a run that
 * drops both blocks reports two of these, business first.
 */
export interface ContextBudgetDegradation {
  block: string;
  estimatedTokens: number;
  thresholdTokens: number;
  conversationId: string | null;
  role: string | null;
}

function asDegradation(payload: unknown): ContextBudgetDegradation | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  // Structural, not textual: the degradation warn is the only one in the route
  // whose payload carries this triple, so the selector cannot rot when the log
  // prefix is reworded.
  if (
    typeof p.block !== "string" ||
    typeof p.estimatedTokens !== "number" ||
    typeof p.thresholdTokens !== "number"
  ) {
    return null;
  }
  return p as unknown as ContextBudgetDegradation;
}

export interface ComposerFailOpenGuard {
  /**
   * Declare — from INSIDE a test body — that this one case wants the named
   * composer(s) to fail open, so the guard ignores their warn.
   *
   * Only three cases in the app legitimately need it, and each drives the
   * throw itself (`llm-chat.persona-block.test.ts`,
   * `llm-chat.business-block.test.ts`, `llm-chat.interview.test.ts`).
   * Declaring it opts THAT test out and nothing else — the next test starts
   * guarded again.
   */
  expectFailOpen(...blocks: ComposerBlock[]): void;
  /**
   * WARP-2655 — the context-budget drops the CURRENT test's turns emitted so
   * far, in drop order, read off the same `console.warn` spy the guard already
   * owns.
   *
   * Read through the guard rather than a second `vi.spyOn(console, "warn")` in
   * the calling file: a nested spy on an already-spied method is one
   * `mockRestore()` away from silently disarming the guard for the rest of the
   * file. One spy, two readers.
   */
  degradations(): ContextBudgetDegradation[];
}

/**
 * Fail any test in the calling file whose turn silently swallowed a block
 * composer.
 *
 * Call once at module top level. Installs a `console.warn` spy per test and
 * asserts, after each, that no composer fail-open fired.
 *
 * The spy still calls through, so the stderr line stays visible while it is
 * also being asserted on — the guard makes the noise fatal, it does not hide
 * it.
 *
 * WHAT IT RECORDS INTO, AND WHY NOT `spy.mock.calls` (#1955). The first cut
 * read the spy's own call history, which `vi.clearAllMocks()` empties. That is
 * not a hypothetical: `llm-chat.streaming-reasoning-leak.test.ts:297` calls it
 * MID-TEST, after `runTurn(true)` has already driven a full chat turn — so a
 * fixture regression firing on that first turn was erased before `afterEach`
 * could read it, and that case ran UNGUARDED inside the very sweep meant to
 * guarantee it could not. Recording into a plain array owned by this closure
 * puts the evidence somewhere vitest's mock bookkeeping cannot reach, so the
 * guarantee holds for every caller including ones not yet written.
 * `prompt-block-fixtures.guard.test.ts` pins it.
 *
 * Scoped to the two composer signatures rather than "any warn": the route
 * warns legitimately elsewhere (memory-fact load failures, context-budget
 * degradation, draft adoption), and the WARP-1921 continuity fail-open next
 * door uses `console.error`, which `rbac-tool-narrowing.route.test.ts`
 * exercises deliberately.
 *
 * Not vitest's `onConsoleLog`: that hook is config-level only (there is no
 * per-file form), so using it would impose this guard on all 632 orchestrator
 * test files at once.
 */
export function guardComposerFailOpen(): ComposerFailOpenGuard {
  /** Every `console.warn` argument list of the CURRENT test, in order.
   *  Owned by this closure, so no `vi.clearAllMocks()` can empty it. */
  let seen: unknown[][] = [];
  let restoreWarn: (() => void) | null = null;
  let allowed = new Set<ComposerBlock>();

  beforeEach(() => {
    allowed = new Set();
    seen = [];
    // Captured BEFORE the spy replaces it, so the pass-through writes to
    // whatever console.warn was — the real one, or an outer spy.
    const original = console.warn;
    const spy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      seen.push(args);
      original.apply(console, args);
    });
    restoreWarn = () => spy.mockRestore();
  });

  afterEach(() => {
    const restore = restoreWarn;
    restoreWarn = null;
    if (!restore) return;
    const swallowed = seen
      .map((args) => String(args[0]))
      .filter((first) =>
        (Object.keys(SIGNATURES) as ComposerBlock[]).some(
          (block) => !allowed.has(block) && first.includes(SIGNATURES[block]),
        ),
      );
    restore();
    // Named so a failure reads as "this fixture stopped rendering a block",
    // not as an unexplained console assertion.
    expect(swallowed, "prompt block composer fail-open swallowed").toEqual([]);
  });

  return {
    expectFailOpen: (...blocks: ComposerBlock[]) => {
      for (const block of blocks) allowed.add(block);
    },
    degradations: () =>
      seen
        .map((args) => asDegradation(args[1]))
        .filter((d): d is ContextBudgetDegradation => d !== null),
  };
}
