# Business Identity + Full-Surface Tool Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the base-prompt identity to business voice and replace the 3-line inline tool guidance with a gated, category-level composer covering the full ~68-tool chat surface (notably `calculate`).

**Architecture:** The identity text is a data file (`data/droplet-identity.md`) loaded by `identity-prompt.ts`. Tool guidance moves out of `routes/llm.ts` into a new pure composer `tool-guidance.service.ts` (same pattern as `persona.service.ts`), gated per-fragment on the caller's effective tool set. Budget caps live in `prompt-budget.consts.ts` and are enforced by the WARP-1118 canary.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, npm workspaces monorepo.

**Spec:** `docs/superpowers/specs/2026-07-23-business-identity-and-tool-guidance-design.md`

## Global Constraints

- Working dir: `/Users/rjouffret/Projects/Droplet/droplet-onboard-services/.worktrees/business-identity-prompt`, branch `WARP/business-identity-prompt`. First run: `npm install` at the worktree root.
- All test commands run from `apps/orchestrator/` with `npx vitest run <path>`.
- **WARP-642 invariant:** no rendered guidance line may name a tool absent from the caller's effective set. This is the load-bearing rule of the whole change.
- Wire tool names are snake_case (`search_content`, `email_send`, `calculate`).
- No new dependencies. Match the codebase's dense-comment style (every non-obvious decision gets a WHY comment referencing its ticket).
- Never-dropped prompt chars are permanent context cost: full-set guidance must stay ≤ `TOOL_GUIDANCE_MAX_CHARS = 2200`.
- Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Business identity rewrite

**Files:**
- Modify: `apps/orchestrator/data/droplet-identity.md` (full replacement)
- Modify: `apps/orchestrator/src/services/identity-prompt.ts:21-22` (FALLBACK_IDENTITY)
- Test: `apps/orchestrator/src/__tests__/llm-chat.base-prompt.test.ts` (identity-block test)

**Interfaces:**
- Consumes: nothing.
- Produces: identity text with headings `# Droplet — identity & what this box does`, `## What the box does`, `## How you speak` and lead phrase `You are Droplet` (both already asserted by existing tests — keep them); new `FALLBACK_IDENTITY` string (exact value in Step 3).

- [ ] **Step 1: Extend the identity test to pin business voice**

In `apps/orchestrator/src/__tests__/llm-chat.base-prompt.test.ts`, find the test `"leads the base system message with the shared Droplet identity block"` and add these assertions immediately after `expect(sys.content).toContain("What the box does");`:

```ts
    // Business-voice rollout (2026-07-23 spec): the identity is business-
    // framed on every box; the household voice is gone.
    expect(sys.content).toContain("for this business");
    expect(sys.content).not.toContain("household");
    expect(sys.content).not.toContain("housemate");
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-chat.base-prompt.test.ts -t "identity block"
```

Expected: FAIL — `expected … to contain 'for this business'` (current file says "household").

- [ ] **Step 3: Replace the identity file and fallback**

Replace the ENTIRE content of `apps/orchestrator/data/droplet-identity.md` with:

```markdown
# Droplet — identity & what this box does

You are Droplet, the AI assistant for this business, running locally
on its appliance. Think of yourself as a sharp, reliable colleague
who handles the busywork, not a corporate chatbot.

## What the box does

- Runs you — a local AI the team can chat with from the dashboard, by
  voice ("hey droplet"), or from connected apps.
- Keeps and searches the business's files, documents, emails, and
  notes.
- Manages email, calendar, contacts, and reminders for the team.
- Does everyday computation on request: arithmetic, unit and currency
  conversion, dates and times, translation.
- Watches the premises' cameras with on-device detection.
- Runs the network: Wi-Fi, routing, device blocking, and remote
  access over VPN.
- Connects to smart devices over Matter (lights, plugs, thermostats,
  and more).
- Remembers durable facts about the business when asked, and recalls
  them later.

## How you speak

- Professional, plain, and direct — like a capable colleague, not a
  press release. Contractions are fine; filler and jargon are not.
- Be honest about limits: if a tool fails or you don't know, say so
  plainly, once, without over-apologizing.
- Privacy first: never suggest a cloud service for something the box
  already does on-site.
```

In `apps/orchestrator/src/services/identity-prompt.ts`, replace:

```ts
/** Legacy identity line — also the fail-open fallback. */
export const FALLBACK_IDENTITY =
  "You are the Droplet AI assistant, running locally on the user's Droplet appliance.";
```

with:

```ts
/** Minimal identity line — the fail-open fallback when the identity file
 *  is missing/empty/unreadable. Business-voiced (2026-07-23 spec). */
export const FALLBACK_IDENTITY =
  "You are Droplet, the AI assistant for this business, running locally on its appliance.";
```

- [ ] **Step 4: Run identity-touching tests, verify pass**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-chat.base-prompt.test.ts src/__tests__/identity-prompt.test.ts
```

Expected: PASS (all). `identity-prompt.test.ts` asserts against the `FALLBACK_IDENTITY` const, so it follows the new string automatically.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/data/droplet-identity.md apps/orchestrator/src/services/identity-prompt.ts apps/orchestrator/src/__tests__/llm-chat.base-prompt.test.ts
git commit -m "feat(prompt): business-voice identity rewrite

Identity is business-framed on every box (spec 2026-07-23): functional
capability list, no ownership or anti-cloud marketing framing.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Tool-guidance composer

**Files:**
- Create: `apps/orchestrator/src/services/tool-guidance.service.ts`
- Modify: `apps/orchestrator/src/services/prompt-budget.consts.ts` (add one const)
- Create (test): `apps/orchestrator/src/services/tool-guidance.service.test.ts`

**Interfaces:**
- Consumes: `TOOL_GUIDANCE_MAX_CHARS` from `./prompt-budget.consts.js`.
- Produces: `composeToolGuidance(allowed: string[] | undefined): string` — returns the full `"Tool guidance:\n- …"` block; `allowed === undefined` means privileged (every tool passes). The memory-pointer line always renders (it references the durable-memory block the route appends regardless of tools); every tool-naming fragment is gated. Task 3 imports this function; Task 4 imports the const.

- [ ] **Step 1: Add the budget const**

In `apps/orchestrator/src/services/prompt-budget.consts.ts`, after `BUSINESS_CONTEXT_MAX_CHARS`:

```ts
/** 2026-07-23 business-identity rollout — ceiling for the full-set render of
 *  composeToolGuidance (tool-guidance.service.ts). Guidance is folded into
 *  the NEVER-DROPPED identity part of the WARP-1118 estimate, so every char
 *  is permanent context cost on every turn; the composer's own test asserts
 *  the real render stays under this. */
export const TOOL_GUIDANCE_MAX_CHARS = 2200;
```

- [ ] **Step 2: Write the failing test file**

Create `apps/orchestrator/src/services/tool-guidance.service.test.ts`:

```ts
/**
 * 2026-07-23 business-identity rollout — composeToolGuidance unit tests.
 *
 * The load-bearing assertion is the WARP-642 invariant: no rendered line
 * may name a tool outside the caller's effective set (instructing a
 * stripped tool steers small local models into the hallucinated-tool
 * guard → 3 guard-only iterations → a failed turn).
 */
import { describe, it, expect } from "vitest";
import { composeToolGuidance } from "./tool-guidance.service.js";
import { TOOL_GUIDANCE_MAX_CHARS } from "./prompt-budget.consts.js";

/** Every wire name the composer may emit. Kept in lockstep with the
 *  renderer fragments — the invariant test sweeps this list. */
const NAMEABLE_TOOLS = [
  "search_content",
  "read_file",
  "summarize_file",
  "email_search",
  "email_read",
  "email_summarize_thread",
  "email_draft_reply",
  "email_send",
  "search_calendar_events",
  "list_events",
  "list_reminders",
  "search_contacts",
  "set_timer",
  "calculate",
  "unit_convert",
  "currency_convert",
  "date_math",
  "get_current_datetime",
  "list_smart_home_devices",
  "control_device",
  "run_scene",
  "list_cameras",
  "search_camera_events",
  "get_camera_snapshot",
  "network_summary",
  "get_network_status",
  "get_system_health",
  "get_drive_health",
  "memory_recall",
  "memory_extract_fact",
  "memory_forget",
  "business_profile_get",
];

describe("composeToolGuidance", () => {
  it("renders every category for a privileged caller (allowed undefined)", () => {
    const block = composeToolGuidance(undefined);
    expect(block.startsWith("Tool guidance:")).toBe(true);
    for (const name of NAMEABLE_TOOLS) {
      expect(block).toContain(name);
    }
    expect(block).toContain("Never do arithmetic in your head");
    expect(block).toContain("never invent one");
  });

  it("stays under TOOL_GUIDANCE_MAX_CHARS at full render", () => {
    expect(composeToolGuidance(undefined).length).toBeLessThanOrEqual(
      TOOL_GUIDANCE_MAX_CHARS,
    );
  });

  it("never names a stripped tool (WARP-642 invariant)", () => {
    const allowed = ["search_content", "memory_recall", "calculate"];
    const block = composeToolGuidance(allowed);
    for (const name of NAMEABLE_TOOLS) {
      if (!allowed.includes(name)) {
        expect(block, `stripped tool leaked: ${name}`).not.toContain(name);
      }
    }
    // The allowed three ARE steered.
    for (const name of allowed) {
      expect(block).toContain(name);
    }
  });

  it("keeps only the bare memory pointer when everything is stripped", () => {
    // allowed=[] is the family-role reality (mcpClient.listTools() → []).
    // The durable-memory block is appended by the route regardless of
    // tools, so its pointer line survives — with zero tool names in it.
    const block = composeToolGuidance([]);
    expect(block).toContain("durable memory");
    for (const name of NAMEABLE_TOOLS) {
      expect(block).not.toContain(name);
    }
    // No tool-naming line rendered → the never-invent rule is pointless.
    expect(block).not.toContain("never invent one");
  });

  it("gates the email draft/send fragments independently", () => {
    const withSend = composeToolGuidance([
      "email_search",
      "email_draft_reply",
      "email_send",
    ]);
    expect(withSend).toContain("confirm before sending with email_send");
    const noSend = composeToolGuidance(["email_search", "email_draft_reply"]);
    expect(noSend).toContain("email_draft_reply");
    expect(noSend).not.toContain("email_send");
  });

  it("scopes the calculate mandate and gates its converter fragments", () => {
    const block = composeToolGuidance(["calculate"]);
    expect(block).toContain("Never do arithmetic in your head");
    expect(block).toContain(
      "don't use it for simple counting or solving for unknowns",
    );
    expect(block).not.toContain("unit_convert");
    expect(block).not.toContain("currency_convert");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/orchestrator && npx vitest run src/services/tool-guidance.service.test.ts
```

Expected: FAIL — `Cannot find module './tool-guidance.service.js'`.

- [ ] **Step 4: Implement the composer**

Create `apps/orchestrator/src/services/tool-guidance.service.ts`:

```ts
/**
 * 2026-07-23 business-identity rollout — category-level tool guidance.
 *
 * Pure composer for the "Tool guidance:" block of the base system prompt
 * (routes/llm.ts buildBaseSystemPrompt). Default chat advertises ~68 tools
 * (registry minus chat-tool-scope.ts exclusions, WARP-1424) but the old
 * inline guidance steered only 3 of them; small local models under-call
 * the rest and do arithmetic mentally instead of calling `calculate`.
 * One line per tool family keeps steering broad without per-tool bloat.
 *
 * WARP-642 INVARIANT: a rendered line must never name a tool that fails
 * `can()` — instructing a stripped tool steers small local models into the
 * hallucinated-tool guard (3 guard-only iterations → a failed turn). Every
 * tool-naming fragment below is individually gated; a category whose
 * anchors are all stripped renders nothing.
 *
 * Sizing: the full-set render is capped by TOOL_GUIDANCE_MAX_CHARS
 * (prompt-budget.consts.ts, asserted in the test file). Guidance is folded
 * into the NEVER-DROPPED identity part of the WARP-1118 estimate, so every
 * char here is permanent context cost on every turn.
 */

type Can = (name: string) => boolean;

/** Render one category line from the passing subset, or null to omit. */
type CategoryRenderer = (can: Can) => string | null;

const contentSearch: CategoryRenderer = (can) => {
  if (!can("search_content")) return null;
  const deeper = [
    can("read_file") ? "read_file" : null,
    can("summarize_file") ? "summarize_file" : null,
  ].filter((n): n is string => n !== null);
  return (
    "- For questions about the business's files, documents, notes, or emails, call search_content and ground your answer in the returned passages (cite their path values)" +
    (deeper.length > 0
      ? `; go deeper on a specific file with ${deeper.join(" or ")}`
      : "") +
    "."
  );
};

const email: CategoryRenderer = (can) => {
  if (!can("email_search")) return null;
  let line =
    "- For email questions, search the mailbox with email_search" +
    (can("email_read") ? " and read messages with email_read" : "") +
    (can("email_summarize_thread")
      ? "; summarize long threads with email_summarize_thread"
      : "") +
    " before answering";
  if (can("email_draft_reply")) {
    line += can("email_send")
      ? ". Draft replies with email_draft_reply and confirm before sending with email_send"
      : ". Prepare replies with email_draft_reply";
  }
  return line + ".";
};

const calendar: CategoryRenderer = (can) => {
  const check = [
    can("search_calendar_events") ? "search_calendar_events" : null,
    can("list_events") ? "list_events" : null,
  ].filter((n): n is string => n !== null);
  if (check.length === 0) return null;
  return (
    `- Never guess schedules: check the calendar with ${check.join(" or ")}` +
    (can("list_reminders") ? "; track reminders with list_reminders" : "") +
    (can("search_contacts") ? "; look people up with search_contacts" : "") +
    (can("set_timer") ? "; set countdowns with set_timer" : "") +
    "."
  );
};

const computation: CategoryRenderer = (can) => {
  if (!can("calculate")) return null;
  const extras: string[] = [];
  if (can("unit_convert")) extras.push("unit_convert for units");
  if (can("currency_convert")) extras.push("currency_convert for money");
  if (can("date_math")) extras.push("date_math for date arithmetic");
  if (can("get_current_datetime"))
    extras.push("get_current_datetime for the current date and time");
  // Strong-but-scoped mandate (locked in the 2026-07-23 spec): "never
  // mentally" steering without routing counting or algebra into a tool
  // that rejects unknown identifiers at parse time.
  return (
    "- Never do arithmetic in your head. For any computation — totals, percentages, margins, conversions — call calculate and report its formatted result. It evaluates plain numeric expressions only: reduce the problem to numbers first, and don't use it for simple counting or solving for unknowns" +
    (extras.length > 0 ? `. Use ${extras.join(", ")}` : "") +
    "."
  );
};

const smartDevices: CategoryRenderer = (can) => {
  if (!can("list_smart_home_devices")) return null;
  return (
    "- For smart devices, check list_smart_home_devices first" +
    (can("control_device") ? "; act with control_device" : "") +
    (can("run_scene") ? "; run scenes with run_scene" : "") +
    " — confirm which device is meant when a reference is ambiguous."
  );
};

const cameras: CategoryRenderer = (can) => {
  const ground = [
    can("list_cameras") ? "list_cameras" : null,
    can("search_camera_events") ? "search_camera_events" : null,
  ].filter((n): n is string => n !== null);
  if (ground.length === 0) return null;
  return (
    `- For camera questions, ground answers in ${ground.join(" and ")} results` +
    (can("get_camera_snapshot")
      ? "; fetch a current view with get_camera_snapshot"
      : "") +
    "."
  );
};

const networkSystem: CategoryRenderer = (can) => {
  const status = [
    can("network_summary") ? "network_summary" : null,
    can("get_network_status") ? "get_network_status" : null,
    can("get_system_health") ? "get_system_health" : null,
    can("get_drive_health") ? "get_drive_health" : null,
  ].filter((n): n is string => n !== null);
  if (status.length === 0) return null;
  return `- Report network and box health from live status tools (${status.join(", ")}), never from memory.`;
};

/** ALWAYS renders: the durable-memory block is appended by the route
 *  regardless of the tool set, so pointing at it is valid even for a
 *  zero-tool caller — only the memory_recall fragment is gated. */
const memoryPointer: CategoryRenderer = (can) => {
  return (
    "- Before answering questions about the business's preferences or how the team likes things done, check the durable memory below" +
    (can("memory_recall") ? "; call memory_recall for anything not listed." : ".")
  );
};

const memoryWrite: CategoryRenderer = (can) => {
  if (!can("memory_extract_fact")) return null;
  return "- When someone states a durable preference or fact worth keeping, save it with memory_extract_fact.";
};

const memoryForget: CategoryRenderer = (can) => {
  if (!can("memory_forget")) return null;
  return "- When asked to forget or delete a remembered fact, remove it with memory_forget.";
};

const businessContext: CategoryRenderer = (can) => {
  if (!can("business_profile_get")) return null;
  return "- For questions about the business itself (what it does, customers, goals), use the business context above; call business_profile_get for the full profile.";
};

const CATEGORY_RENDERERS: CategoryRenderer[] = [
  contentSearch,
  email,
  calendar,
  computation,
  smartDevices,
  cameras,
  networkSystem,
  memoryPointer,
  memoryWrite,
  memoryForget,
  businessContext,
];

const NEVER_INVENT_LINE =
  "- Use tool names exactly as advertised — never invent one.";

/**
 * Compose the tool-guidance block from the caller's EFFECTIVE tool set.
 * `allowed` undefined = privileged caller = every tool passes (the same
 * `can()` contract buildBaseSystemPrompt has always used).
 */
export function composeToolGuidance(allowed: string[] | undefined): string {
  const can: Can = (name) => !allowed || allowed.includes(name);
  const rendered = CATEGORY_RENDERERS.map((render) => render(can)).filter(
    (line): line is string => line !== null,
  );
  // memoryPointer always renders, so rendered.length >= 1. Any OTHER
  // surviving line names a tool — as does the pointer's own memory_recall
  // fragment. Only then does the never-invent rule earn its chars.
  const namesATool = rendered.length > 1 || can("memory_recall");
  const lines = namesATool ? [...rendered, NEVER_INVENT_LINE] : rendered;
  return ["Tool guidance:", ...lines].join("\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/orchestrator && npx vitest run src/services/tool-guidance.service.test.ts
```

Expected: PASS (6 tests). If the budget test fails, trim wording — do NOT raise `TOOL_GUIDANCE_MAX_CHARS` without re-running Task 4's canary math.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/tool-guidance.service.ts apps/orchestrator/src/services/tool-guidance.service.test.ts apps/orchestrator/src/services/prompt-budget.consts.ts
git commit -m "feat(prompt): category-level tool-guidance composer

One gated line per tool family across the ~68-tool chat surface, with a
strong-but-scoped calculate mandate. WARP-642 invariant: a line never
names a tool outside the caller's effective set.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire the composer into the route + business-voice sweep

**Files:**
- Modify: `apps/orchestrator/src/routes/llm.ts` (buildBaseSystemPrompt guidance section ~lines 475-510; memory header ~line 578)
- Test: `apps/orchestrator/src/__tests__/llm-chat.base-prompt.test.ts`

**Interfaces:**
- Consumes: `composeToolGuidance(allowed: string[] | undefined): string` from `../services/tool-guidance.service.js` (Task 2).
- Produces: unchanged `buildBaseSystemPrompt(allowed, personaBlock?, businessBlock?)` signature — callers (the route body and the WARP-1118 estimator call `buildBaseSystemPrompt(allowedForUser, "")`) need no edits.

- [ ] **Step 1: Add wiring tests (failing first)**

In `apps/orchestrator/src/__tests__/llm-chat.base-prompt.test.ts`, add inside the main describe block:

```ts
  it("steers calculate and the wider tool surface for privileged callers", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "what is 15% of 2400?" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    // The mocked auth user is privileged → allowed=undefined → full render.
    expect(sys.content).toContain("Never do arithmetic in your head");
    expect(sys.content).toContain("calculate");
    expect(sys.content).toContain("email_search");
    expect(sys.content).toContain("business_profile_get");
  });

  it("renders guidance from an explicit allowed_tools list only", async () => {
    const app = buildApp(createPrismaMock([]));

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        allowed_tools: ["calculate"],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.content).toContain("Never do arithmetic in your head");
    // WARP-642: nothing outside the explicit list may be named.
    expect(sys.content).not.toContain("unit_convert");
    expect(sys.content).not.toContain("search_content");
    expect(sys.content).not.toContain("email_search");
  });

  it("frames the durable-memory block for the business, not a household", async () => {
    const app = buildApp(
      createPrismaMock([
        {
          category: "Workflow",
          fact: "Invoices go out on the 1st",
          active: true,
          addedAt: new Date("2026-06-01T00:00:00Z"),
        },
      ]),
    );

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "m1",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    const sys = agentMessages()[0]!;
    expect(sys.content).toContain("facts previously saved for this business");
    expect(sys.content).not.toContain("household");
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-chat.base-prompt.test.ts
```

Expected: the three new tests FAIL (old inline guidance has no calculate line; memory header still says household). Pre-existing tests PASS.

- [ ] **Step 3: Replace the inline guidance with the composer**

In `apps/orchestrator/src/routes/llm.ts`:

(a) Add the import next to the existing `identity-prompt.js` import:

```ts
import { composeToolGuidance } from "../services/tool-guidance.service.js";
```

(b) Inside `buildBaseSystemPrompt`, DELETE from `const can = (name: string) => …` down to (and including) the `if (guidance.length > 0) { lines.push("", "Tool guidance:", ...guidance); }` block, and replace with:

```ts
  // Tool guidance is composed per-category from the caller's EFFECTIVE
  // set (tool-guidance.service.ts) — the WARP-642 never-name-a-stripped-
  // tool invariant lives there, with its own unit tests.
  const guidanceBlock = composeToolGuidance(allowed);
  if (guidanceBlock.length > 0) {
    lines.push("", guidanceBlock);
  }
```

Keep everything else in the function (identity, persona, business splices, final `return lines.join("\n");`) exactly as is. Note the JSDoc above the function still accurately describes the `allowed` contract — leave it.

(c) At ~line 578 in `buildMemoryFactsBlock`, change:

```ts
    "\n\nDurable memory — facts previously saved for this household:\n" +
```

to:

```ts
    "\n\nDurable memory — facts previously saved for this business:\n" +
```

- [ ] **Step 4: Run the route suites, verify pass**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-chat.base-prompt.test.ts src/__tests__/llm-chat.persona-block.test.ts src/__tests__/llm-chat.business-block.test.ts src/__tests__/llm-chat.interview.test.ts src/__tests__/llm-chat.max-tokens.test.ts src/__tests__/llm-chat.attachments.test.ts
```

Expected: PASS. Watch specifically the pre-existing family-role test (`"omits stripped write tools…"`): with `allowed=[]` the composer emits only the bare memory pointer — no `search_content`, no `memory_extract_fact` — so it must stay green. If a persona/business-block test pins the exact old guidance wording, update that pin to the composer's wording (same tool names, so `toContain("search_content")`-style assertions survive untouched).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/routes/llm.ts apps/orchestrator/src/__tests__/llm-chat.base-prompt.test.ts
git commit -m "feat(prompt): wire tool-guidance composer into chat base prompt

buildBaseSystemPrompt delegates guidance to composeToolGuidance;
durable-memory header reframed for the business voice.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Budget canary re-pin + full verification

**Files:**
- Modify: `apps/orchestrator/src/services/prompt-budget.consts.ts` (BASE_PROMPT_MAX_CHARS)
- Modify: `apps/orchestrator/src/services/base-prompt-budget.test.ts` (sum pin + comment)

**Interfaces:**
- Consumes: `TOOL_GUIDANCE_MAX_CHARS` (Task 2).
- Produces: nothing downstream — this is the CI safety net.

- [ ] **Step 1: Update the canary to count guidance (failing first)**

In `apps/orchestrator/src/services/base-prompt-budget.test.ts`:

(a) Extend the consts import:

```ts
import {
  PERSONA_PROMPT_MAX_CHARS,
  BUSINESS_CONTEXT_MAX_CHARS,
  INTERVIEW_PROMPT_MAX_CHARS,
  TOOL_GUIDANCE_MAX_CHARS,
  BASE_PROMPT_MAX_CHARS,
  OUTPUT_RESERVE,
} from "./prompt-budget.consts.js";
```

(b) In the first test, add the new term and re-pin the sum:

```ts
    const fixedBlockChars =
      IDENTITY_MAX_CHARS +
      PERSONA_PROMPT_MAX_CHARS +
      BUSINESS_CONTEXT_MAX_CHARS +
      TOOL_GUIDANCE_MAX_CHARS +
      MEMORY_FACTS_CHAR_BUDGET +
      INTERVIEW_PROMPT_MAX_CHARS;
    // 4000 + 1200 + 1500 + 2200 + 2000 + 900 = 11800. (2026-07-23: tool
    // guidance became a counted, capped block — it was previously ~600
    // uncounted chars riding inside the identity fold.)
    expect(fixedBlockChars).toBe(11800);
    expect(fixedBlockChars).toBeLessThanOrEqual(BASE_PROMPT_MAX_CHARS);
```

(c) Update the file-header comment's arithmetic line to match (identity 4000 + persona 1200 + business 1500 + guidance 2200 + memory 2000 + interview 900 = 11800, slack 400).

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/services/base-prompt-budget.test.ts
```

Expected: FAIL — `11800 > BASE_PROMPT_MAX_CHARS (10000)`.

- [ ] **Step 3: Bump the ceiling**

In `apps/orchestrator/src/services/prompt-budget.consts.ts`:

```ts
export const BASE_PROMPT_MAX_CHARS = 12200;
```

(11800 + the same 400-char slack the old ceiling carried. Deliberate bump, 2026-07-23 spec §4: ~+550 never-dropped tokens against the 16384 window.)

- [ ] **Step 4: Run the canary, verify BOTH assertions pass**

```bash
cd apps/orchestrator && npx vitest run src/services/base-prompt-budget.test.ts src/services/context-budget.service.test.ts
```

Expected: PASS — including the window-fit test (fixed blocks + scoped tools[] under 16384 − OUTPUT_RESERVE). **If the window-fit assertion fails, STOP and flag it** — that means the real headroom is gone and guidance wording must shrink (start by dropping the `extras` fragments from `computation` and the `get_camera_snapshot`/`set_timer` fragments), not the window grow.

- [ ] **Step 5: Full orchestrator suite + typecheck**

```bash
cd apps/orchestrator && npx tsc -p . --noEmit && npx vitest run
```

Expected: typecheck clean; suite green. Any failure outside the files this plan touches is pre-existing — verify by `git stash && npx vitest run <failing file> && git stash pop` before blaming the change.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/prompt-budget.consts.ts apps/orchestrator/src/services/base-prompt-budget.test.ts
git commit -m "test(budget): count tool guidance as a capped fixed block

BASE_PROMPT_MAX_CHARS 10000 -> 12200: guidance (2200-char cap) is now a
counted block instead of ~600 uncounted chars in the identity fold.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
