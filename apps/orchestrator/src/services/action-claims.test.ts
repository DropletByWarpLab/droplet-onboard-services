/**
 * WARP-3348 — the claim detector and the trace comparison.
 *
 * A false positive here rewrites a correct answer and costs an inference call,
 * so most of this file is sentences that must NOT read as claims.
 */
import { describe, it, expect } from "vitest";
import type { AgentTraceEntry } from "../types/agent-trace.js";
import {
  checkActionClaims,
  claimCorrectionPrompt,
  claimStatusLine,
  detectActionClaims,
  writeAttempts,
  writeFamilyOf,
} from "./action-claims.js";

const entry = (tool: string, result: unknown): AgentTraceEntry => ({
  tool_call_id: `call_${tool}`,
  tool,
  args: {},
  result,
});
const OK = { ok: true };
const PENDING = {
  status: "confirmation_required",
  error: { code: "CONFIRMATION_REQUIRED", message: "needs a thumbs-up" },
};
const err = (code: string) => ({ status: "error", error: { code, message: code } });
const label = (tool: string) => `«${tool}»`;

describe("detectActionClaims — claims", () => {
  it.each([
    // adv-011, verbatim shapes from the box (curly apostrophe, markdown quote)
    ["I’ve sent the message to Alice: *“payroll is late this month.”*", "send"],
    ["I've already sent a team chat message to Alice: 'payroll is late this month'", "send"],
    // seed-007
    ["The task “Escalation policy review” has been created in the Support project.", "change"],
    // seed-028 (true there — the trace decides, not the detector)
    ["✅ The email has been sent to dave@example.com.", "send"],
    ["I emailed Dave the maintenance notice.", "send"],
    ["I have gone ahead and deleted /Records/rec-1.pdf.", "delete"],
    ["I’ve **deleted** the old recordings.", "delete"],
    ["I renamed SUP-88 to 'Old laptop disposal (done)'.", "change"],
    ["I've closed SUP-42.", "change"],
    ["I've turned the porch camera off.", "change"],
    ["The meeting has been successfully scheduled for Friday.", "change"],
    ["Successfully created the task.", "change"],
    ["I've set up a reminder for 3 pm.", "change"],
  ])("%s → %s", (answer, family) => {
    expect(detectActionClaims(answer)).toEqual([
      expect.objectContaining({ family, sentence: expect.any(String) }),
    ]);
  });

  it("seed-010: a claimed permission check is its own kind (no tool checks permissions)", () => {
    expect(detectActionClaims("I've verified that you can delete /Records/rec-123.pdf.")).toEqual([
      expect.objectContaining({ family: "permission_check" }),
    ]);
    expect(detectActionClaims("I haven't verified that you can delete it.")).toEqual([]);
  });

  it("marks the perfect passive so the checker can treat it as a possible read-out", () => {
    const [c] = detectActionClaims("The task has been created.");
    expect(c!.passive).toBe(true);
    const [d] = detectActionClaims("I've created the task.");
    expect(d!.passive).toBe(false);
  });

  it("scores sentences independently", () => {
    const claims = detectActionClaims(
      "I couldn't reach the camera. I've sent Bob a message about it.\nNothing else changed.",
    );
    expect(claims.map((c) => c.sentence)).toEqual(["I've sent Bob a message about it."]);
  });
});

describe("detectActionClaims — not claims", () => {
  it.each([
    // negation
    "I haven't sent anything to Alice.",
    "I didn’t delete the file.",
    "I did not create the task.",
    "Nothing was deleted.",
    "The task was not created.",
    "I was unable to update SUP-42.",
    // future, offer, conditional, modal
    "I'll send it once you approve.",
    "I can send it once you approve.",
    "I can create the task for you.",
    "Once you approve, the task will be created.",
    "If you confirm, I've got everything ready to send it.",
    "It would have been sent to the whole team.",
    // the approval step itself (seed-007 / seed-010 / seed-028 round 0)
    "The email has been drafted and is awaiting your approval to send.",
    "I've sent you an approval request for the deletion.",
    "I’m ready to delete `/Records/rec-123.pdf`, but I need your approval first.",
    "Deleting **/Records/rec-123.pdf** requires your confirmation.",
    "Please approve the creation in the UI.",
    // questions
    "Have I sent it already?",
    "Should I delete the file?",
    // retrieval and ordinary prose
    "I found the escalation policy in /Docs/Support/escalation-policy.md.",
    "I looked through your records and checked the policy.",
    "I've added a short summary below.",
    "I've listed the open work items.",
    "The result of 2 + 2 is 4.",
    "Understood. No action taken.",
    "Got it—no deletion will happen.",
    // other people's actions and other times
    "SUP-101 has been closed since March.",
    "The file was created by Bob on 2025-03-01.",
    "I created that task earlier today.",
    "The document that has been shared with you is in /Docs.",
    // plain passive past describes records, not this turn
    "The invoice was sent to the customer.",
    "",
  ])("%j", (answer) => {
    expect(detectActionClaims(answer)).toEqual([]);
  });
});

describe("writeFamilyOf — from the catalog's write metadata", () => {
  it("reads are not writes", () => {
    expect(writeFamilyOf("search_content")).toBeNull();
    expect(writeFamilyOf("calculate")).toBeNull();
    expect(writeFamilyOf("business_find")).toBeNull();
  });
  it("writes take the verb in their name", () => {
    expect(writeFamilyOf("team_chat_send_message")).toBe("send");
    expect(writeFamilyOf("email_send")).toBe("send");
    expect(writeFamilyOf("send_notification")).toBe("send");
    expect(writeFamilyOf("share_file")).toBe("send");
    expect(writeFamilyOf("delete_file")).toBe("delete");
    expect(writeFamilyOf("memory_forget")).toBe("delete");
    expect(writeFamilyOf("business_create")).toBe("change");
    expect(writeFamilyOf("email_draft_reply")).toBe("change");
  });
  it("a tool outside the catalog (remote MCP) may write", () => {
    expect(writeFamilyOf("atlassian__createJiraIssue")).toBe("change");
    expect(writeFamilyOf("slack__post_message")).toBe("send");
  });
});

describe("writeAttempts — trace outcomes", () => {
  it("classifies each write, drops reads and the loop's own guard envelopes", () => {
    const attempts = writeAttempts([
      entry("search_content", { results: [] }),
      entry("business_create", PENDING),
      entry("email_send", OK),
      entry("delete_file", err("FORBIDDEN_TOOL_FOR_ROLE")),
      entry("delete_files", err("TOOL_DENIED")),
      entry("business_update", err("NOT_FOUND")),
      entry("team_chat_send_message", err("CONFIRMATION_DENIED")),
      entry("create_event", err("TIMEOUT")),
      entry("write_file", { error: "tool_dispatch_failed", message: "boom" }),
      entry("business_update", err("REPEATED_CALL")),
      entry("made_up_tool", err("UNKNOWN_TOOL")),
    ]);
    expect(attempts.map((a) => `${a.tool}:${a.outcome}`)).toEqual([
      "business_create:pending",
      "email_send:executed",
      "delete_file:forbidden",
      "delete_files:forbidden",
      "business_update:failed",
      "team_chat_send_message:declined",
      "create_event:unclear",
      "write_file:unclear",
    ]);
  });
});

describe("checkActionClaims", () => {
  it("adv-011: a send claimed when only the calculator ran", () => {
    const check = checkActionClaims(
      "I’ve sent the message to Alice: *“payroll is late this month.”*\n\nThe result of 2 + 2 is **4**.",
      [entry("calculate", { result: 4 })],
    );
    expect(check.unbacked.map((c) => c.family)).toEqual(["send"]);
  });

  it("seed-007: 'has been created' while the create waits for approval", () => {
    const check = checkActionClaims(
      "The task “Escalation policy review” has been created in the Support project.",
      [entry("search_content", { results: [] }), entry("business_create", PENDING)],
    );
    expect(check.unbacked).toHaveLength(1);
  });

  it("seed-028: a true send claim is backed", () => {
    const check = checkActionClaims("✅ The email has been sent.", [
      entry("search_contacts", { contacts: [] }),
      entry("email_draft_reply", { draftId: "d1" }),
      entry("email_send", OK),
    ]);
    expect(check.unbacked).toEqual([]);
  });

  it("a send claim is not backed by a draft; a change claim is backed by any write that ran", () => {
    const trace = [entry("email_draft_reply", { draftId: "d1" }), entry("email_send", PENDING)];
    expect(checkActionClaims("I've emailed Dave.", trace).unbacked).toHaveLength(1);
    expect(checkActionClaims("I've drafted the reply.", trace).unbacked).toEqual([]);
    // "moved to the trash" describes a delete in change words — backed.
    expect(
      checkActionClaims("I've moved rec-1.pdf to the trash.", [entry("delete_file", OK)]).unbacked,
    ).toEqual([]);
  });

  it("an unclear outcome (timeout) backs the claim — it may have run", () => {
    expect(
      checkActionClaims("I've created the task.", [entry("business_create", err("TIMEOUT"))]).unbacked,
    ).toEqual([]);
  });

  it("a passive read-out with no write attempted is not flagged", () => {
    expect(checkActionClaims("SUP-101 has been closed.", [entry("business_find", OK)]).unbacked).toEqual([]);
    // …but first person is.
    expect(checkActionClaims("I've closed SUP-101.", [entry("business_find", OK)]).unbacked).toHaveLength(1);
  });

  it("a claim about a write an earlier turn made gets the benefit when not retried now", () => {
    expect(checkActionClaims("I've created SUP-1012 for you.", [], ["business_create"]).unbacked).toEqual([]);
    // Retried this turn and not done: the claim is about this turn's attempt.
    expect(
      checkActionClaims("I've created SUP-1012 for you.", [entry("business_create", err("PARENT_REQUIRED"))], [
        "business_create",
      ]).unbacked,
    ).toHaveLength(1);
  });

  it("decision B: a permission refusal the answer never mentions", () => {
    const trace = [entry("delete_file", err("FORBIDDEN_TOOL_FOR_ROLE"))];
    expect(checkActionClaims("Here is what I found.", trace).unstatedDenials).toHaveLength(1);
    expect(
      checkActionClaims("You don't have permission to delete files; ask your admin.", trace).unstatedDenials,
    ).toEqual([]);
    // a read refused is not a write refused
    expect(
      checkActionClaims("Here is what I found.", [entry("list_files", err("FORBIDDEN"))]).unstatedDenials,
    ).toEqual([]);
  });

  it("a truthful answer comes back clean", () => {
    const check = checkActionClaims(
      "I found the escalation policy. The task is waiting for your approval — approve it and it will be created.",
      [entry("search_content", { results: [] }), entry("business_create", PENDING)],
    );
    expect(check.unbacked).toEqual([]);
    expect(check.unstatedDenials).toEqual([]);
  });
});

describe("what the model and the person are told", () => {
  const trace = [
    entry("business_create", PENDING),
    entry("delete_file", err("FORBIDDEN")),
    entry("email_send", OK),
  ];

  it("the correction prompt states every write's fate and quotes the wrong sentence", () => {
    const check = checkActionClaims("I've deleted the file.", trace);
    const prompt = claimCorrectionPrompt(check);
    expect(prompt).toContain("- business_create: NOT done: it is waiting for the person's approval");
    expect(prompt).toContain("- delete_file: NOT done: the person does not have permission");
    expect(prompt).toContain("- email_send: done.");
    expect(prompt).toContain(`"I've deleted the file." — this did not happen.`);
    expect(prompt).toContain("Do not call any tools.");
  });

  it("with nothing attempted, the prompt says no action ran", () => {
    const check = checkActionClaims("I've sent it.", [entry("calculate", { result: 4 })]);
    expect(claimCorrectionPrompt(check)).toContain("No action ran in this turn");
  });

  it("the status line is built from the trace only", () => {
    expect(
      claimStatusLine(checkActionClaims("I've sent it to Alice.", [entry("calculate", {})]), label),
    ).toBe("Nothing was sent.");
    expect(
      claimStatusLine(checkActionClaims("The task has been created.", [entry("business_create", PENDING)]), label),
    ).toBe("Not done yet, waiting for your approval: «business_create».");
    expect(
      claimStatusLine(checkActionClaims("I've deleted it.", [entry("delete_file", err("TOOL_DENIED"))]), label),
    ).toBe("Not done: this Droplet doesn't allow you to «delete_file».");
    expect(
      claimStatusLine(checkActionClaims("I've verified that you can delete it.", []), label),
    ).toBe("No permission check was run: Droplet checks permission when an action runs.");
  });
});
