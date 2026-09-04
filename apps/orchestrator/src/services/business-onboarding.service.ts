/**
 * WARP-1121 (Phase 3, §9) — the first-chat business-onboarding interview.
 *
 * State machine + interview lifecycle for `BusinessProfile.onboardingState`.
 * Every transition is an ATOMIC CONDITIONAL update (`updateMany … WHERE
 * onboardingState = <expected>`; zero rows = somebody else moved first =
 * `OnboardingStateConflictError` → HTTP 409). The §9.2 legal-transition
 * table is the whole contract — anything not in it must throw:
 *
 *   not_started  --start-------------------→ in_progress
 *   not_started  --skip--------------------→ skipped
 *   not_started  --PATCH manual fill-------→ completed   (Phase 2, business-profile.service)
 *   in_progress  --commit------------------→ completed
 *   in_progress  --skip (API-only)---------→ skipped
 *   in_progress  --interview chat deleted--→ not_started (reset, audited)
 *   skipped      --start-------------------→ in_progress
 *   skipped      --PATCH manual fill-------→ completed   (Phase 2)
 *   completed    --start (re-run)----------→ re_running
 *   re_running   --commit (supersedes)-----→ completed
 *   re_running   --skip / chat deleted-----→ completed   (restore; profile untouched)
 *
 * The interview itself is an ordinary persisted chat conversation — the
 * orchestrator overlays the conductor block and strips write tools when
 * `conversationId === interviewChatId` (routes/llm.ts). No SSE changes, no
 * new chat wire schema (§12).
 *
 * PRIVACY: interview transcripts, the profile, and every fact are LOCAL box
 * state — never sent off the box (§5-12).
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  BUSINESS_PROFILE_SINGLETON_ID,
  BUSINESS_PROFILE_FIELD_MAX_CHARS,
  BUSINESS_PROFILE_SUMMARY_MAX_CHARS,
  checkContentHygiene,
  type BusinessOnboardingStateName,
} from "./business-profile.service.js";
import { INTERVIEW_PROMPT_MAX_CHARS } from "./prompt-budget.consts.js";

/** Sidebar title for the persisted interview session (design brief §9). */
export const INTERVIEW_SESSION_TITLE = "Getting to know your business";

/** The canonical wrap-up user turn (design brief §9). The CLIENT sends this
 *  verbatim when the user clicks `Skip the rest`; the conductor block below
 *  contractually answers it with the proposal JSON. Exported so the
 *  dashboard constant and this contract can never drift apart in tests. */
export const WRAP_UP_TURN =
  "That's enough — sum up what you have so far.";

/**
 * The server-authored OPENING turn, written into the interview session the
 * moment it is created (§9.2 start) so the walkthrough actually walks.
 *
 * Why the server authors it rather than the model: `/llm/chat` refuses a
 * thread that carries no user turn (`empty_replay`, routes/llm.ts) — a
 * deliberate guard against replay bugs. So the model CANNOT open a
 * conversation, and an interview session created empty just sits there
 * looking like an ordinary blank chat: no question, no `[topic n/7]` marker,
 * dots stuck on 0 of 7, until the user happens to type something. That is
 * the whole of the "the walkthrough drops me into a chat" defect.
 *
 * Same contract as CLOSING_TURN: verbatim from here, never dependent on the
 * model reproducing copy. Only the OPENER is fixed — topics 2-7 stay
 * model-generated under INTERVIEW_CONDUCTOR_BLOCK, which the model reads off
 * this turn's marker. Copy is the interview transcript's first line in the
 * design handoff prototype (shared_brain personality-onboarding,
 * prototype/src-decoded/copy-data.jsx), where Droplet speaks first.
 *
 * The marker is part of the string on purpose: the dashboard parses it, so
 * the progress eyebrow reads `1 of 7` from first paint instead of holding on
 * an unmarked turn.
 */
export const OPENING_TURN =
  "[topic 1/7] To start — in a sentence or two, what does your business do?";

/** The server-authored closing turn appended on commit success (§9.2 /
 *  design brief §9). Ships verbatim from here — it never depends on the
 *  model reproducing copy. */
export const CLOSING_TURN =
  "Thanks — I'll keep this in mind. If you drop things like price lists or how-to docs into Files, I'll read those too.";

/** Provenance marker for interview-committed MemoryFact rows (`addedBy`).
 *  Explicit-column provenance (§5-2): re-run supersession deactivates
 *  active facts with THIS marker whose evidenceChatId is not the current
 *  interview — robust across any number of re-runs, no title matching, no
 *  captured-id bookkeeping to lose. Chat-extracted facts (addedBy =
 *  username/"agent") are never touched by supersession. */
export const ONBOARDING_FACTS_ADDED_BY = "onboarding";

/** Commit bounds (§9.2) — mirrored in the route zod schema. ≤20 facts
 *  matches MEMORY_FACTS_LIMIT; ≤280 chars per fact. */
export const ONBOARDING_MAX_FACTS = 20;
export const ONBOARDING_FACT_MAX_CHARS = 280;

/**
 * The interview conductor block (§9.3) — a code-versioned prompt fragment
 * appended AFTER the base prompt on interview turns only. ≤900 chars
 * (INTERVIEW_PROMPT_MAX_CHARS, asserted below at module load and in tests);
 * never dropped by the context-budget estimator on interview sessions.
 *
 * The topic-marker line is the ENTIRE progress protocol: the dashboard
 * parses `[topic n/7]`, strips it before render, and advances the dots /
 * chip sets / aria counter. No per-turn server bookkeeping, no SSE changes.
 */
export const INTERVIEW_CONDUCTOR_BLOCK = [
  "--- onboarding interview (conductor) ---",
  "Run Droplet's business onboarding interview: warm, curious, ONE question per turn.",
  "Topics in order: 1 what the business does; 2 customers; 3 team & roles; 4 tools & systems; 5 a typical day; 6 goals & pain points; 7 communication preferences.",
  "Start every question with its marker, e.g. [topic 3/7]. One topic at a time.",
  "Topic 7 answers are facts to remember, never settings changes.",
  `When every topic is covered, or the user says "${WRAP_UP_TURN}", reply with exactly one fenced json code block and nothing else:`,
  '{"profile":{"whatWeDo":"","customers":"","teamShape":"","toolsUsed":"","typicalDay":"","goals":""},"summary":"","facts":[{"category":"Business","fact":"","audience":"family"}]}',
  "Omit what you did not learn. Max 20 facts under 280 chars; fields under 600; summary under 1500.",
  "--- end onboarding interview ---",
].join("\n");

// Budget canary — a copy edit that blows the §10 budget fails at import
// time in every test run, not on the box.
if (INTERVIEW_CONDUCTOR_BLOCK.length > INTERVIEW_PROMPT_MAX_CHARS) {
  throw new Error(
    `INTERVIEW_CONDUCTOR_BLOCK is ${INTERVIEW_CONDUCTOR_BLOCK.length} chars — over the ${INTERVIEW_PROMPT_MAX_CHARS} budget (§10)`,
  );
}

/** A transition raced or was illegal from the current state — HTTP 409 at
 *  the route. Carries the state the loser actually found so the dashboard
 *  can render the "another admin finished this" banner (design brief §7.10). */
export class OnboardingStateConflictError extends Error {
  readonly current: BusinessOnboardingStateName | null;
  constructor(current: BusinessOnboardingStateName | null, message?: string) {
    super(message ?? `illegal onboarding transition from ${current ?? "missing"}`);
    this.name = "OnboardingStateConflictError";
    this.current = current;
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Read (or materialise) the singleton — same create-on-read semantics as
 *  business-profile.service.getBusinessProfile, kept tx-compatible. */
async function readProfile(db: Db) {
  const existing = await db.businessProfile.findUnique({
    where: { id: BUSINESS_PROFILE_SINGLETON_ID },
  });
  if (existing) return existing;
  return db.businessProfile.create({
    data: { id: BUSINESS_PROFILE_SINGLETON_ID },
  });
}

/**
 * Append a SERVER-AUTHORED assistant turn to an interview session.
 *
 * The lifecycle writes three of these — the opener on a fresh start (§9.2),
 * the opener on a self-healed session, and the closing turn on commit — and
 * they are one shape, not three: copy that ships verbatim from this module
 * rather than depending on the model to reproduce it, written as an ordinary
 * ChatMessage so reopening the session simply shows it, and always inside the
 * caller's transaction so a lost race rolls the turn back with whatever it was
 * appended to.
 *
 * One helper because the contract is the part that moves. An explicit
 * provenance / system-turn column is the obvious next thing to want here, and
 * hand-copied call sites drift quietly: the copy string is the only visible
 * difference between them, so a divergence reads as a wording change rather
 * than a missed edit (pr-reviewer, #1987).
 */
async function appendServerAuthoredTurn(
  db: Db,
  sessionId: string,
  content: string,
): Promise<void> {
  await db.chatMessage.create({
    data: { sessionId, role: "assistant", content },
  });
}

/**
 * The llm.ts overlay probe (§9.3): is `conversationId` the live interview?
 * One indexed read; returns the state so the caller can also distinguish
 * in_progress from re_running if it ever needs to.
 */
export async function getInterviewOverlay(
  prisma: PrismaClient,
  conversationId: string,
): Promise<{ active: boolean; state: BusinessOnboardingStateName | null }> {
  const row = await prisma.businessProfile.findUnique({
    where: { id: BUSINESS_PROFILE_SINGLETON_ID },
    select: { onboardingState: true, interviewChatId: true },
  });
  if (!row) return { active: false, state: null };
  const state = row.onboardingState as BusinessOnboardingStateName;
  const active =
    row.interviewChatId === conversationId &&
    (state === "in_progress" || state === "re_running");
  return { active, state };
}

export interface StartResult {
  conversationId: string;
  state: BusinessOnboardingStateName;
  /** false = idempotent resume of an interview already in flight. */
  created: boolean;
}

/**
 * §9.2 start: not_started|skipped → in_progress · completed → re_running ·
 * in_progress|re_running → idempotent resume (existing conversationId).
 * Session create + conditional transition run in ONE transaction so a lost
 * race can't leak an orphaned "Getting to know your business" session.
 */
export async function startOnboarding(
  prisma: PrismaClient,
  userId: string,
): Promise<StartResult> {
  return prisma.$transaction(async (tx) => {
    const profile = await readProfile(tx);
    const state = profile.onboardingState as BusinessOnboardingStateName;

    if (state === "in_progress" || state === "re_running") {
      if (profile.interviewChatId) {
        return {
          conversationId: profile.interviewChatId,
          state,
          created: false,
        };
      }
      // Self-heal: state says an interview is live but the session link is
      // gone (pre-hook data). Recreate the session, keep the state.
      const healed = await tx.chatSession.create({
        data: { userId, title: INTERVIEW_SESSION_TITLE },
      });
      await appendServerAuthoredTurn(tx, healed.id, OPENING_TURN);
      await tx.businessProfile.update({
        where: { id: BUSINESS_PROFILE_SINGLETON_ID },
        data: { interviewChatId: healed.id },
      });
      return { conversationId: healed.id, state, created: true };
    }

    const target: BusinessOnboardingStateName =
      state === "completed" ? "re_running" : "in_progress";
    const legalFrom: BusinessOnboardingStateName[] =
      state === "completed" ? ["completed"] : ["not_started", "skipped"];

    const session = await tx.chatSession.create({
      data: { userId, title: INTERVIEW_SESSION_TITLE },
    });
    // The opener goes in with the session, inside the same transaction: a
    // lost race below rolls BOTH back, so a losing start can never leave a
    // stray "what does your business do?" in somebody's sidebar.
    await appendServerAuthoredTurn(tx, session.id, OPENING_TURN);
    const moved = await tx.businessProfile.updateMany({
      where: {
        id: BUSINESS_PROFILE_SINGLETON_ID,
        onboardingState: { in: legalFrom },
      },
      data: {
        onboardingState: target,
        interviewChatId: session.id,
        updatedBy: userId,
      },
    });
    if (moved.count === 0) {
      // Lost the race — throwing rolls the session create back too.
      throw new OnboardingStateConflictError(state);
    }
    return { conversationId: session.id, state: target, created: true };
  });
}

export interface SkipResult {
  from: BusinessOnboardingStateName;
  state: BusinessOnboardingStateName;
}

/**
 * §9.2 skip: not_started → skipped (intro card `Skip for now`) ·
 * in_progress → skipped (API-only; the dashboard's `Skip the rest` wraps up
 * instead) · re_running → completed (restore; committed profile untouched).
 */
export async function skipOnboarding(
  prisma: PrismaClient,
  userId: string,
): Promise<SkipResult> {
  const profile = await readProfile(prisma);
  const state = profile.onboardingState as BusinessOnboardingStateName;
  const target: BusinessOnboardingStateName | null =
    state === "not_started" || state === "in_progress"
      ? "skipped"
      : state === "re_running"
        ? "completed"
        : null;
  if (!target) throw new OnboardingStateConflictError(state);

  const moved = await prisma.businessProfile.updateMany({
    where: { id: BUSINESS_PROFILE_SINGLETON_ID, onboardingState: state },
    data: { onboardingState: target, updatedBy: userId },
  });
  if (moved.count === 0) throw new OnboardingStateConflictError(state);
  return { from: state, state: target };
}

/** One approved fact from the review card. `audience` is CLAMPED server-side
 *  (D-11): exactly "admin" stays admin, anything else becomes "family". */
export interface CommitFact {
  category: "Business" | "Tone" | "Workflow" | "Schedule" | "Scope" | "Other";
  fact: string;
  audience?: string;
}

export interface CommitPayload {
  profile?: Partial<{
    whatWeDo: string;
    customers: string;
    teamShape: string;
    toolsUsed: string;
    typicalDay: string;
    goals: string;
  }>;
  summary?: string;
  facts?: CommitFact[];
}

export interface CommitResult {
  state: BusinessOnboardingStateName;
  factsSaved: number;
  factsSuperseded: number;
}

/** Thrown when a commit payload fails bounds/hygiene the route zod let
 *  through (service-level defense in depth) — HTTP 400 at the route. */
export class OnboardingPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingPayloadError";
  }
}

const PROFILE_FIELDS = [
  "whatWeDo",
  "customers",
  "teamShape",
  "toolsUsed",
  "typicalDay",
  "goals",
] as const;

/**
 * §9.2 commit — ONE transaction: conditional in_progress|re_running →
 * completed (409 for the racing loser), profile upsert with
 * `lastSource=onboarding`, fact batch stamped `evidenceChatId` +
 * `addedBy="onboarding"`, re-run supersession (deactivate prior onboarding
 * facts), and the server-authored closing ChatMessage. Fact-batch failure
 * rolls the profile write back — never a half-committed onboarding.
 */
export async function commitOnboarding(
  prisma: PrismaClient,
  userId: string,
  payload: CommitPayload,
): Promise<CommitResult> {
  // Service-level bounds + hygiene (§15) — the route zod already rejects
  // these, but the service is the last line before the transaction.
  const facts = payload.facts ?? [];
  if (facts.length > ONBOARDING_MAX_FACTS) {
    throw new OnboardingPayloadError(
      `at most ${ONBOARDING_MAX_FACTS} facts per commit`,
    );
  }
  const textsToCheck: string[] = [payload.summary ?? ""];
  for (const f of PROFILE_FIELDS) {
    const v = payload.profile?.[f];
    if (v && v.length > BUSINESS_PROFILE_FIELD_MAX_CHARS) {
      throw new OnboardingPayloadError(`${f} over ${BUSINESS_PROFILE_FIELD_MAX_CHARS} chars`);
    }
    if (v) textsToCheck.push(v);
  }
  if ((payload.summary ?? "").length > BUSINESS_PROFILE_SUMMARY_MAX_CHARS) {
    throw new OnboardingPayloadError(
      `summary over ${BUSINESS_PROFILE_SUMMARY_MAX_CHARS} chars`,
    );
  }
  for (const f of facts) {
    if (f.fact.length > ONBOARDING_FACT_MAX_CHARS) {
      throw new OnboardingPayloadError(
        `fact over ${ONBOARDING_FACT_MAX_CHARS} chars`,
      );
    }
    textsToCheck.push(f.fact);
  }
  for (const text of textsToCheck) {
    if (!text) continue;
    const hygiene = checkContentHygiene(text);
    if (!hygiene.ok) {
      throw new OnboardingPayloadError(`content rejected: ${hygiene.reason}`);
    }
  }

  return prisma.$transaction(async (tx) => {
    const profile = await readProfile(tx);
    const state = profile.onboardingState as BusinessOnboardingStateName;
    if (state !== "in_progress" && state !== "re_running") {
      // Another admin committed or skipped first (design brief §7.10).
      throw new OnboardingStateConflictError(state);
    }
    const interviewChatId = profile.interviewChatId;
    if (!interviewChatId) {
      // Session vanished without the reset hook — unrecoverable mid-commit.
      throw new OnboardingStateConflictError(state, "interview session missing");
    }

    // Profile fields + summary + provenance + the conditional transition,
    // all guarded on the state we just read (atomic against a racer).
    const fieldData: Record<string, string> = {};
    for (const f of PROFILE_FIELDS) {
      const v = payload.profile?.[f];
      if (v !== undefined) fieldData[f] = v;
    }
    if (payload.summary !== undefined) fieldData.summary = payload.summary;
    const moved = await tx.businessProfile.updateMany({
      where: { id: BUSINESS_PROFILE_SINGLETON_ID, onboardingState: state },
      data: {
        ...fieldData,
        onboardingState: "completed",
        lastSource: "onboarding",
        updatedBy: userId,
      },
    });
    if (moved.count === 0) throw new OnboardingStateConflictError(state);

    // Re-run supersession (§9.2): deactivate the PRIOR interview's facts —
    // provenance-matched (addedBy marker), excluding the current session's.
    let superseded = 0;
    if (state === "re_running") {
      const res = await tx.memoryFact.updateMany({
        where: {
          active: true,
          addedBy: ONBOARDING_FACTS_ADDED_BY,
          NOT: { evidenceChatId: interviewChatId },
        },
        data: { active: false },
      });
      superseded = res.count;
    }

    // The approved facts, stamped with evidence + provenance (D-11 clamp).
    if (facts.length > 0) {
      await tx.memoryFact.createMany({
        data: facts.map((f) => ({
          category: f.category,
          fact: f.fact,
          addedBy: ONBOARDING_FACTS_ADDED_BY,
          evidenceChatId: interviewChatId,
          audience: f.audience === "admin" ? "admin" : "family",
        })),
      });
    }

    // The server-authored closing turn (§9.2).
    await appendServerAuthoredTurn(tx, interviewChatId, CLOSING_TURN);
    await tx.chatSession.update({
      where: { id: interviewChatId },
      data: { updatedAt: new Date() },
    });

    return {
      state: "completed" as const,
      factsSaved: facts.length,
      factsSuperseded: superseded,
    };
  });
}

export interface ResetResult {
  from: BusinessOnboardingStateName;
  state: BusinessOnboardingStateName;
}

/**
 * §9.2 deletion hook — called by the conversation DELETE route AFTER a
 * successful delete when the deleted session was the live interview.
 * Prisma's `onDelete: SetNull` has already cleared `interviewChatId`, so
 * the conditional matches on state + the now-null link (which also
 * self-heals pre-hook data where the link died without a transition).
 * Returns null when the profile was not mid-interview (nothing to reset).
 */
export async function resetOnboardingForDeletedSession(
  prisma: PrismaClient,
): Promise<ResetResult | null> {
  const inProgress = await prisma.businessProfile.updateMany({
    where: {
      id: BUSINESS_PROFILE_SINGLETON_ID,
      onboardingState: "in_progress",
      interviewChatId: null,
    },
    data: { onboardingState: "not_started" },
  });
  if (inProgress.count > 0) {
    return { from: "in_progress", state: "not_started" };
  }
  const reRunning = await prisma.businessProfile.updateMany({
    where: {
      id: BUSINESS_PROFILE_SINGLETON_ID,
      onboardingState: "re_running",
      interviewChatId: null,
    },
    data: { onboardingState: "completed" },
  });
  if (reRunning.count > 0) {
    return { from: "re_running", state: "completed" };
  }
  return null;
}
