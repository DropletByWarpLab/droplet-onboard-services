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
  "team_chat_send_message",
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
  "create_pdf_report",
  "create_slide_deck",
  "create_spreadsheet",
  "create_artifact",
  "analyze_data",
  "create_audio",
  "generate_media",
  "office_file",
  "web_search",
  "web_fetch",
  "start_agent_run",
  "network_summary",
  "get_network_status",
  "get_system_health",
  "get_drive_health",
  "memory_recall",
  "memory_extract_fact",
  "memory_forget",
  "business_profile_get",
  "find_dashboard_page",
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

  it("WARP-3282 — tells the model never to repeat a credential from a result, whatever the tool set", () => {
    // Any tool can return one (read_file, email_read, a remote MCP page), so
    // the rule rides with the always-on never-invent line, not with search.
    for (const set of [["search_content"], ["email_read"], ["calculate"], undefined]) {
      expect(composeToolGuidance(set)).toContain("Never repeat a password, key or token");
    }
    // No tools, no tool results: no rule.
    expect(composeToolGuidance([])).not.toContain("password");
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

  it.each([
    ["create_pdf_report", "PDF: create_pdf_report"],
    ["create_slide_deck", "PDF/PPTX decks: create_slide_deck"],
    ["create_spreadsheet", "Excel/formulas/charts: create_spreadsheet"],
  ])("guides %s without naming unavailable writers", (tool, fragment) => {
    const block = composeToolGuidance([tool]);
    expect(block).toContain(fragment);
    expect(block).toContain("Use supplied or retrieved data; never invent it");
    expect(block).toContain("Claim success only after the tool succeeds");
    expect(block).toContain("link only returned download URLs");
    for (const other of ["create_pdf_report", "create_slide_deck", "create_spreadsheet"]) {
      if (other !== tool) expect(block).not.toContain(other);
    }
  });

  it("omits creation guidance when all writers are withheld", () => {
    const block = composeToolGuidance(
      undefined,
      new Set(["create_pdf_report", "create_slide_deck", "create_spreadsheet"]),
    );
    expect(block).not.toContain("Create files");
    expect(block).not.toContain("create_slide_deck");
    expect(composeToolGuidance(["search_content"])).not.toContain("Create files");
  });

  it("makes team chat the default way to message someone, email only when asked (WARP-3340)", () => {
    const line = "- Message people with team_chat_send_message unless asked for email.";
    expect(composeToolGuidance(["team_chat_send_message"])).toContain(line);
    expect(composeToolGuidance(undefined)).toContain(line);
    // A caller whose tool pool lacks team chat (a role without it): no line,
    // and email is the only channel left. Switching Messages off does not
    // reach this pool for an owner or admin; the tool is still offered and
    // refuses before the approval with TEAM_CHAT_UNAVAILABLE (WARP-3349).
    const noChat = composeToolGuidance(["email_search", "email_draft_reply", "email_send"]);
    expect(noChat).not.toContain("team_chat_send_message");
    expect(noChat).not.toContain("Message people");
    // The trims that paid for the line kept the business line's pointer for
    // customer questions (review of #2541).
    expect(composeToolGuidance(["business_profile_get"])).toContain(
      "- For questions about the business or its customers, use the business context above",
    );
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

  it("renders the dashboard-path line only when a navigation tool survives (WARP-3116)", () => {
    // Off the dashboard both tools are withheld, and the line must go with
    // them — it names them.
    expect(composeToolGuidance(["search_content"])).not.toContain("dashboard paths");
    expect(composeToolGuidance(["open_dashboard_page"])).not.toContain("dashboard paths");
    expect(composeToolGuidance(["find_dashboard_page"])).toContain(
      "Never guess dashboard paths: use find_dashboard_page.",
    );
  });

  it("honours `withheld` even for the privileged `undefined` (WARP-3116)", () => {
    // The owner's `undefined` cannot say "not this turn"; the withheld set
    // does, and a line naming a withheld tool is the WARP-642 failure.
    const block = composeToolGuidance(
      undefined,
      new Set(["find_dashboard_page", "open_dashboard_page"]),
    );
    expect(block).not.toContain("find_dashboard_page");
    expect(block).not.toContain("open_dashboard_page");
    expect(block).toContain("search_content");
  });
});
