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
