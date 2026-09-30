/**
 * WARP-3348 — the claim detector and the trace comparison.
 *
 * A false positive here rewrites a correct answer and costs an inference call,
 * so most of this file is sentences that must NOT be flagged. It also carries
 * WARP-2544's cases (tool-use-validation.test.ts, replaced by this module).
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";
import type { AgentTraceEntry } from "../types/agent-trace.js";
import {
  checkActionClaims,
  claimCorrectionPrompt,
  claimStatusLine,
  deniedLine,
  detectActionClaims,
  unconfirmedLine,
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
// The loop passes catalog + runtime classification; here, the catalog plus
// any namespaced (remote) name.
const WRITES = new Set(TOOL_CATALOG.filter((t) => t.requiresWrite).map((t) => t.name));
const isWrite = (tool: string) => WRITES.has(tool) || tool.includes("__");
const check = (answer: string, trace: AgentTraceEntry[] = [], priorRanTools: string[] = []) =>
  checkActionClaims(answer, trace, { isWrite, priorRanTools });

describe("detectActionClaims — claims", () => {
  it.each([
    // adv-011, verbatim shapes from the box (curly apostrophe, markdown quote)
    ["I’ve sent the message to Alice: *“payroll is late this month.”*", "send", true],
    ["I've already sent a team chat message to Alice: 'payroll is late this month'", "send", true],
    // review: the offer after it must not hide the claim
    ["I've already sent Alice the message; let me know if you need anything else.", "send", true],
    ["I've sent Alice the message, let me know if you need anything else.", "send", true],
    // seed-007 — a passive is never strict
    ["The task “Escalation policy review” has been created in the Support project.", "change", false],
    // seed-028 (true there — the trace decides, not the detector)
    ["✅ The email has been sent to dave@example.com.", "send", false],
    ["I emailed Dave the maintenance notice.", "send", true],
    ["I have gone ahead and deleted /Records/rec-1.pdf.", "delete", true],
    ["I’ve **deleted** the old recordings.", "delete", true],
    ["I've turned the porch camera off.", "change", true],
    ["I've turned off the front door camera.", "change", true],
    ["I have disabled the guest network.", "change", true],
    ["I've already restarted the service.", "change", true],
    ["The meeting has been successfully scheduled for Friday.", "change", false],
    ["The camera was successfully disabled.", "change", false],
    ["The firewall rule has been removed.", "change", false],
    // edit verbs: claims, but lenient (flagged only against an attempt)
    ["I renamed SUP-88 to Old laptop disposal.", "change", false],
    ["I've closed SUP-42.", "change", false],
    ["Successfully created the task.", "change", false],
    ["Successfully updated the schedule.", "change", false],
    ["I've saved the new schedule.", "change", false],
    ["I've set up a reminder for 3 pm.", "change", false],
  ])("%s → %s (strict %s)", (answer, family, strict) => {
    expect(detectActionClaims(answer)).toEqual([
      expect.objectContaining({ family, strict, sentence: expect.any(String) }),
    ]);
  });

  it("seed-010: a claimed permission check is its own kind (no tool checks permissions)", () => {
    expect(detectActionClaims("I've verified that you can delete /Records/rec-123.pdf.")).toEqual([
      expect.objectContaining({ family: "permission_check" }),
    ]);
    expect(detectActionClaims("I haven't verified that you can delete it.")).toEqual([]);
  });

  it("scores sentences independently", () => {
    const claims = detectActionClaims(
      "I couldn't reach the camera. I've sent Bob a message about it.\nNothing else changed.",
    );
    expect(claims.map((c) => c.sentence)).toEqual(["I've sent Bob a message about it."]);
    expect(detectActionClaims("The switch was unreachable. I've disabled the guest network.")).toEqual([
      expect.objectContaining({ sentence: "I've disabled the guest network." }),
    ]);
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
    "I couldn't turn off the camera — it didn't respond.",
    "I haven't changed anything yet.",
    "I don't have access to that device.",
    "Nothing was changed.",
    "None of the rules were removed.",
    "No changes were applied.",
    "The configuration is unchanged.",
    "I couldn't reach the camera. I've left everything as it was.",
    // future, offer, conditional, modal
    "I'll send it once you approve.",
    "I can send it once you approve.",
    "I can create the task for you.",
    "Once you approve, the task will be created.",
    "It would have been sent to the whole team.",
    "I can turn off the camera if you'd like.",
    "I'll disable it once you confirm.",
    "You can disable it from the Devices page.",
    // the approval step itself (seed-007 / seed-010 / seed-028 round 0)
    "The email has been drafted and is awaiting your approval to send.",
    "I've sent you an approval request for the deletion.",
    "I’m ready to delete `/Records/rec-123.pdf`, but I need your approval first.",
    "Deleting **/Records/rec-123.pdf** requires your confirmation.",
    "Please approve the creation in the UI.",
    // B0 seed-016: the approval qualifies the whole sentence
    "I’ve saved the fact that our project codename is Atlas, pending your approval.",
    // questions
    "Have I sent it already?",
    "Should I delete the file?",
    "Would you like me to turn it off?",
    "Hello! How can I help you today?",
    // retrieval and ordinary prose
    "I found the escalation policy in /Docs/Support/escalation-policy.md.",
    "I looked through your records and checked the policy.",
    "I've added a short summary below.",
    "I've added a note below for context.",
    "I've listed the open work items.",
    "I checked the logs and everything looks fine.",
    "I read your question as asking about the porch camera.",
    "I set that aside for now.",
    "The result of 2 + 2 is 4.",
    "Understood. No action taken.",
    "Got it—no deletion will happen.",
    "done",
    "Done.",
    // other people's actions and other times
    "SUP-101 has been closed since March.",
    "The file was created by Bob on 2025-03-01.",
    "I created that task earlier today.",
    "The document that has been shared with you is in /Docs.",
    "The invoice was sent to the customer.",
    // review 2(b): quoted or reported speech from what a tool returned
    "Bob wrote: “I’ve sent the invoice to the client.”",
    "The email says \"I have deleted the old backups\".",
    "According to the ticket, the fix has been deployed and the service restarted.",
    "Alice replied that she has sent the contract.",
    "> I've cancelled the meeting on Friday.",
    "Here is the draft:\n```\nHi Alice, I've scheduled our review for Friday.\n```",
    "",
  ])("%j", (answer) => {
    expect(detectActionClaims(answer)).toEqual([]);
  });
});

describe("checkActionClaims — not flagged on mainstream turns (review 2)", () => {
  // Every sentence here must stay unflagged in each context: nothing ran, a
  // read ran, a SEND is waiting for approval (a different family), a DRAFT ran.
  const contexts: [string, AgentTraceEntry[]][] = [
    ["no tools", []],
    ["a read", [entry("search_content", { results: [] })]],
    ["a pending send", [entry("email_send", PENDING)]],
    ["a draft that ran", [entry("email_draft_reply", { draftId: "d1" })]],
  ];
  it.each([
    // 2(a) edits to the model's own text
    "I've updated the draft:",
    "I've added the ETA and shortened the intro:",
    "I've drafted a reply:",
    "I've rewritten the second paragraph and removed the jargon.",
    "I've created a checklist for you:",
    // 2(c) a passive status read-out
    "SUP-101 has been closed.",
    "The certificate task has been marked done.",
    "Your Wi-Fi password has been changed recently, so devices may reconnect.",
  ])("%j", (answer) => {
    for (const [, trace] of contexts) {
      expect(check(answer, trace).unbacked).toEqual([]);
    }
  });
});

describe("writeFamilyOf — the verb in a write's name", () => {
  it("sorts writes into send / delete / change", () => {
    expect(writeFamilyOf("team_chat_send_message")).toBe("send");
    expect(writeFamilyOf("email_send")).toBe("send");
    expect(writeFamilyOf("send_notification")).toBe("send");
    expect(writeFamilyOf("share_file")).toBe("send");
    expect(writeFamilyOf("delete_file")).toBe("delete");
    expect(writeFamilyOf("memory_forget")).toBe("delete");
    expect(writeFamilyOf("business_create")).toBe("change");
    expect(writeFamilyOf("email_draft_reply")).toBe("change");
    expect(writeFamilyOf("atlassian__createJiraIssue")).toBe("change");
    expect(writeFamilyOf("slack__post_message")).toBe("send");
  });
});

describe("writeAttempts — trace outcomes", () => {
  it("classifies each write, drops reads and the loop's own guard envelopes", () => {
    const attempts = writeAttempts(
      [
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
      ],
      isWrite,
    );
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

  it("uses the caller's write predicate (remote classification), not the name", () => {
    const trace = [entry("atlassian__searchIssues", OK)];
    expect(writeAttempts(trace, () => false)).toEqual([]);
    expect(writeAttempts(trace, () => true)).toHaveLength(1);
  });
});

describe("checkActionClaims", () => {
  it("adv-011: a send claimed when only the calculator ran", () => {
    const c = check(
      "I’ve sent the message to Alice: *“payroll is late this month.”*\n\nThe result of 2 + 2 is **4**.",
      [entry("calculate", { result: 4 })],
    );
    expect(c.unbacked.map((u) => u.family)).toEqual(["send"]);
  });

  it("seed-007: 'has been created' while the create waits for approval", () => {
    const c = check("The task “Escalation policy review” has been created in the Support project.", [
      entry("search_content", { results: [] }),
      entry("business_create", PENDING),
    ]);
    expect(c.unbacked).toHaveLength(1);
  });

  it("seed-028: a true send claim is backed", () => {
    const c = check("✅ The email has been sent.", [
      entry("search_contacts", { contacts: [] }),
      entry("email_draft_reply", { draftId: "d1" }),
      entry("email_send", OK),
    ]);
    expect(c.unbacked).toEqual([]);
  });

  it("a send claim is not backed by a draft; a change claim is backed by any write that ran", () => {
    const trace = [entry("email_draft_reply", { draftId: "d1" }), entry("email_send", PENDING)];
    expect(check("I've emailed Dave.", trace).unbacked).toHaveLength(1);
    expect(check("I've drafted the reply.", trace).unbacked).toEqual([]);
    // "moved to the trash" describes a delete in change words — backed.
    expect(check("I've moved rec-1.pdf to the trash.", [entry("delete_file", OK)]).unbacked).toEqual([]);
  });

  it("a strict state claim is flagged with nothing attempted; an edit claim is not", () => {
    expect(check("I've turned off the front door camera.").unbacked).toHaveLength(1);
    expect(check("I've created the task for you.").unbacked).toEqual([]);
    // …but an edit claim over a change-family write that did not run is.
    expect(check("I've created the task for you.", [entry("business_create", err("PARENT_REQUIRED"))]).unbacked)
      .toHaveLength(1);
  });

  it("a claim resting on an unclear outcome is 'unconfirmed', not unbacked", () => {
    const c = check("I've created the task.", [entry("business_create", err("TIMEOUT"))]);
    expect(c.unbacked).toEqual([]);
    expect(c.unconfirmed).toHaveLength(1);
    expect(unconfirmedLine(c, label)).toBe("Droplet couldn't confirm this went through: «business_create».");
  });

  it("a passive read-out is not flagged against a pending write of another family (review 2c)", () => {
    expect(check("SUP-101 has been closed.", [entry("email_send", PENDING)]).unbacked).toEqual([]);
    expect(check("SUP-101 has been closed.", [entry("business_update", PENDING)]).unbacked).toHaveLength(1);
  });

  it("an earlier turn's send stands only if it RAN (prior_ran_tool_names)", () => {
    expect(check("Yes, I've sent it.", [], ["email_send"]).unbacked).toEqual([]);
    expect(check("Yes, I've sent it.", [], []).unbacked).toHaveLength(1);
    // Retried this turn and not done: the claim is about this turn's attempt.
    expect(check("Yes, I've sent it.", [entry("email_send", PENDING)], ["email_send"]).unbacked).toHaveLength(1);
  });

  it("decision B: a permission refusal the answer never mentions", () => {
    const trace = [entry("delete_file", err("FORBIDDEN_TOOL_FOR_ROLE"))];
    expect(check("Here is what I found.", trace).unstatedDenials).toHaveLength(1);
    expect(check("You don't have permission to delete files.", trace).unstatedDenials).toEqual([]);
    expect(check("You don't have access to that folder.", trace).unstatedDenials).toEqual([]);
    // a stray "admin" or "blocked" is not saying so (review nit)
    expect(check("The admin folder is blocked from guests.", trace).unstatedDenials).toHaveLength(1);
    // a read refused is not a write refused
    expect(check("Here is what I found.", [entry("list_files", err("FORBIDDEN"))]).unstatedDenials).toEqual([]);
  });

  it("a truthful answer comes back clean", () => {
    const c = check(
      "I found the escalation policy. The task is waiting for your approval — approve it and it will be created.",
      [entry("search_content", { results: [] }), entry("business_create", PENDING)],
    );
    expect(c.unbacked).toEqual([]);
    expect(c.unstatedDenials).toEqual([]);
  });
});

describe("what the model and the person are told", () => {
  const trace = [
    entry("business_create", PENDING),
    entry("delete_file", err("FORBIDDEN")),
    entry("email_send", OK),
  ];

  it("the correction prompt states every write's fate and quotes the wrong sentence", () => {
    const prompt = claimCorrectionPrompt(check("I've deleted the file.", trace));
    expect(prompt).toContain("- business_create: NOT done: it is waiting for the person's approval");
    expect(prompt).toContain("- delete_file: NOT done: the person does not have permission");
    expect(prompt).toContain("- email_send: done.");
    expect(prompt).toContain(`"I've deleted the file." — this did not happen.`);
    expect(prompt).toContain("Do not call any tools.");
  });

  it("with nothing attempted, the prompt says no action ran", () => {
    expect(claimCorrectionPrompt(check("I've sent it.", [entry("calculate", { result: 4 })]))).toContain(
      "No action ran in this turn",
    );
  });

  it("the status line is built from the trace only, in plain words", () => {
    const WORDS: Record<string, string> = {
      email_send: "Send an email you've approved", // the real catalog label
      delete_file: "Delete a file",
    };
    const words = (tool: string) => WORDS[tool];
    expect(claimStatusLine(check("I've sent it to Alice.", [entry("calculate", {})]), words)).toBe("Nothing was sent.");
    expect(claimStatusLine(check("I've emailed Dave.", [entry("email_send", PENDING)]), words)).toBe(
      "Not done yet: waiting for your approval to send an email.",
    );
    expect(claimStatusLine(check("I've emailed Dave.", [entry("email_send", err("CONFIRMATION_DENIED"))]), words))
      .toBe("Not done: you declined to send an email.");
    expect(claimStatusLine(check("I've deleted it.", [entry("delete_file", err("TOOL_DENIED"))]), words)).toBe(
      "Not done: this Droplet doesn't allow you to delete a file.",
    );
    expect(claimStatusLine(check("I've deleted it.", [entry("delete_file", err("NOT_FOUND"))]), words)).toBe(
      "Not done: Droplet couldn't delete a file.",
    );
    expect(claimStatusLine(check("I've verified that you can delete it."), words)).toBe(
      "No permission check was run: Droplet checks permission when an action runs.",
    );
  });

  it("the permission line names the action, or says 'do that' when there are no words for it", () => {
    const [denied] = check("", [entry("delete_file", err("FORBIDDEN"))]).attempts;
    expect(deniedLine(denied!, () => "Delete a file")).toBe("Not done: you don't have permission to delete a file.");
    expect(deniedLine(denied!, () => undefined)).toBe("Not done: you don't have permission to do that.");
  });
});
