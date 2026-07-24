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
