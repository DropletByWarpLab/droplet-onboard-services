/**
 * WARP-2544 — the answer must not claim work the tools did not do.
 *
 * Two failure modes shipped, both invisible:
 *   1. "I've turned the camera off" on a turn with an EMPTY trace.
 *   2. "I've turned the camera off" when the dispatch returned status:"error".
 *
 * Both matter more on this product than on a cloud assistant, because the
 * tools are physical — cameras, locks, network rules, power.
 *
 * The hard requirement on the other side is NO FALSE POSITIVES. A warning that
 * fires on healthy turns gets ignored, and then the guard is worse than
 * nothing. Most of this file is therefore negative cases.
 */
import { describe, it, expect } from "vitest";
import type { AgentTraceEntry } from "./llm-agent.service.js";
import {
  classifyToolOutcome,
  detectCompletionClaims,
  validateAnswerAgainstTrace,
  describeToolUseVerdict,
} from "./tool-use-validation.js";

const entry = (tool: string, result: unknown): AgentTraceEntry => ({
  tool_call_id: `call_${tool}`,
  tool,
  args: {},
  result,
});

// mcp-server emits the handler payload UNWRAPPED on success (WARP-1604), so a
// successful result usually has no `status` key at all.
const OK_RESULT = { cameraId: "cam-1", state: "off" };
const ERR_RESULT = { status: "error", error: { code: "EDEVICE", message: "unreachable" } };
const PENDING_RESULT = {
  status: "confirmation_required",
  error: { message: "Approve turning off the front door camera?" },
};

const validate = (
  answer: string,
  trace: AgentTraceEntry[],
  toolsAdvertised = true,
) => validateAnswerAgainstTrace({ answer, trace, toolsAdvertised });

describe("classifyToolOutcome", () => {
  it("treats a bare unwrapped payload as success (the WARP-1604 wire shape)", () => {
    expect(classifyToolOutcome(OK_RESULT)).toBe("success");
    expect(classifyToolOutcome({ path: "/x/y.txt" })).toBe("success");
    expect(classifyToolOutcome({ results: [] })).toBe("success");
  });

  it("reads status:error as a failure", () => {
    expect(classifyToolOutcome(ERR_RESULT)).toBe("error");
  });

  it("reads confirmation_required as pending, not as success or failure", () => {
    // The loop deliberately surfaces this as ok:true so the dashboard shows an
    // approval chip. Folding it into "success" would let a completion claim
    // ride on an action nobody has approved yet.
    expect(classifyToolOutcome(PENDING_RESULT)).toBe("pending");
  });

  it("does not throw on null / primitives / arrays", () => {
    expect(classifyToolOutcome(null)).toBe("success");
    expect(classifyToolOutcome("text")).toBe("success");
    expect(classifyToolOutcome(42)).toBe("success");
    expect(classifyToolOutcome([1, 2])).toBe("success");
  });
});

describe("detectCompletionClaims — positives", () => {
  it.each([
    "I've turned off the front door camera.",
    "I have disabled the guest network.",
    "I turned off the porch light.",
    "I've created the folder for you.",
    "I deleted the old recordings.",
    "Done — the camera is now off.",
    "Done! I've disabled the guest network.",
    "The firewall rule has been removed.",
    "The camera was successfully disabled.",
    "Successfully updated the schedule.",
    "I've already restarted the service.",
    "I checked the logs and everything looks fine.",
  ])("flags %j", (text) => {
    expect(detectCompletionClaims(text).length).toBeGreaterThan(0);
  });
});

describe("detectCompletionClaims — negatives (false positives are the real risk)", () => {
  it.each([
    // offers and future tense — not claims
    "I can turn off the camera if you'd like.",
    "I'll disable it once you confirm.",
    "Would you like me to turn it off?",
    "Shall I restart the service?",
    "You can disable it from the Devices page.",
    // honest failure reports — the model behaving CORRECTLY
    "I couldn't turn off the camera — it didn't respond.",
    "I was unable to disable the rule.",
    "I haven't changed anything yet.",
    "I don't have access to that device.",
    "I failed to connect to the switch.",
    // subject negation — found by this file's own run: "Nothing was changed"
    // matched the passive pattern on "was changed" and flagged an HONEST
    // failure report. The guard firing hardest when the model is telling the
    // truth is the worst false positive available.
    "Nothing was changed.",
    "None of the rules were removed.",
    "No changes were applied.",
    "The configuration is unchanged.",
    // pure conversation
    "Hello! How can I help you today?",
    "That depends on which camera you mean.",
    // A BARE "done" asserts nothing checkable, and nine existing agent-loop
    // fixtures use `content: "done"` as filler — matching it put a WARN in
    // every run of that suite. A guard that fires on every CI run is one
    // people mute, so it needs an object after the word.
    "done",
    "Done.",
    "Done!",
    "I think the living room camera is the one you want.",
  ])("does NOT flag %j", (text) => {
    expect(detectCompletionClaims(text)).toEqual([]);
  });

  it("evaluates each sentence on its own, not the whole answer", () => {
    // Whole-text matching gets this wrong in BOTH directions: a negation
    // anywhere would excuse a fabrication three sentences later, and a claim
    // anywhere would override an honest failure report.
    const honest = "I couldn't reach the camera. I've left everything as it was.";
    expect(detectCompletionClaims(honest)).toEqual([]);

    const mixed = "The switch was unreachable. I've disabled the guest network.";
    expect(detectCompletionClaims(mixed)).toEqual([
      "I've disabled the guest network.",
    ]);
  });

  it("caps a long claim excerpt (these reach logs and the SSE frame)", () => {
    const long = `I've disabled ${"the guest network ".repeat(40)}.`;
    const [claim] = detectCompletionClaims(long);
    expect(claim.length).toBeLessThanOrEqual(160);
    expect(claim.endsWith("…")).toBe(true);
  });
});

describe("validateAnswerAgainstTrace", () => {
  it("FLAGS a completion claim on an empty trace as unsupported", () => {
    // Shipped failure mode #1.
    const v = validate("I've turned off the front door camera.", []);
    expect(v.status).toBe("unsupported");
    expect(v.claims).toEqual(["I've turned off the front door camera."]);
    expect(v.counts).toEqual({ total: 0, success: 0, error: 0, pending: 0 });
  });

  it("FLAGS a completion claim over a failed dispatch as contradicted", () => {
    // Shipped failure mode #2 — WARP-1480 logs the error, the user still reads
    // a success sentence.
    const v = validate("I've turned off the front door camera.", [
      entry("camera_set_state", ERR_RESULT),
    ]);
    expect(v.status).toBe("contradicted");
    expect(v.counts.error).toBe(1);
    expect(v.tools).toEqual(["camera_set_state"]);
  });

  it("distinguishes unsupported from contradicted", () => {
    // They need different fixes: one is a model that never called a tool, the
    // other is a model ignoring a tool's error. Collapsing them would hide
    // which is happening.
    expect(validate("I've disabled it.", []).status).toBe("unsupported");
    expect(
      validate("I've disabled it.", [entry("t", ERR_RESULT)]).status,
    ).toBe("contradicted");
  });

  it("passes a claim backed by a successful dispatch", () => {
    const v = validate("I've turned off the front door camera.", [
      entry("camera_set_state", OK_RESULT),
    ]);
    expect(v.status).toBe("ok");
    expect(v.claims).toEqual([]);
  });

  it("passes when one dispatch failed but another succeeded", () => {
    // A retry that eventually worked is a healthy turn. Flagging it would
    // punish exactly the recovery behaviour the loop is designed to do.
    const v = validate("I've turned off the camera.", [
      entry("camera_set_state", ERR_RESULT),
      entry("camera_set_state", OK_RESULT),
    ]);
    expect(v.status).toBe("ok");
  });

  it("does not flag a turn awaiting confirmation", () => {
    // Legitimately "not done yet"; the dashboard already renders an approval
    // chip for it.
    // The answer MUST carry a real completion claim, or this test passes for
    // the wrong reason. It originally said "I've queued …" — `queued` is not
    // an action verb, so no claim was ever detected and the assertion held
    // even with the pending exemption deleted. Caught by mutation testing:
    // removing `if (counts.pending > 0) return ok()` left the suite green.
    expect(detectCompletionClaims("I've turned off the camera.").length)
      .toBeGreaterThan(0);
    const v = validate("I've turned off the camera.", [
      entry("camera_set_state", PENDING_RESULT),
    ]);
    expect(v.status).toBe("ok");
  });

  it("does not flag a conversational turn that advertised no tools", () => {
    // tool_choice:"none" — the model could not have dispatched anything, so
    // "I checked" here is chat, not a fabricated call. Checking these would
    // fire constantly on turns working exactly as designed.
    const v = validate("I checked and I think it's the living room one.", [], false);
    expect(v.status).toBe("ok");
  });

  it("does not flag an honest failure report over a failed dispatch", () => {
    // The MOST important negative case: this is the model doing the right
    // thing. A guard that fires hardest when the model is honest would be
    // actively harmful.
    const v = validate(
      "I couldn't turn off the camera — it didn't respond. Nothing was changed.",
      [entry("camera_set_state", ERR_RESULT)],
    );
    expect(v.status).toBe("ok");
  });

  it("does not flag an answer with no completion claim at all", () => {
    const v = validate("There are three cameras on the network.", [
      entry("camera_list", ERR_RESULT),
    ]);
    expect(v.status).toBe("ok");
  });

  it("handles an empty answer without throwing", () => {
    // WARP-854/1479 blank turns already have their own owner; this must not
    // add a second, contradictory diagnosis.
    expect(validate("", []).status).toBe("ok");
    expect(validate("", [entry("t", ERR_RESULT)]).status).toBe("ok");
  });

  it("reports counts and tools so a log line explains itself", () => {
    const v = validate("I've disabled it.", [
      entry("a", ERR_RESULT),
      entry("b", ERR_RESULT),
    ]);
    expect(v.counts).toEqual({ total: 2, success: 0, error: 2, pending: 0 });
    expect(v.tools).toEqual(["a", "b"]);
  });
});

describe("describeToolUseVerdict", () => {
  it("names which failure it is and carries the evidence", () => {
    const v = validate("I've turned off the camera.", []);
    const line = describeToolUseVerdict(v);
    expect(line).toContain("NO tool was dispatched");
    expect(line).toContain("dispatches=0");
    expect(line).toContain("I've turned off the camera.");
  });

  it("distinguishes the contradicted wording", () => {
    const v = validate("I've turned off the camera.", [
      entry("camera_set_state", ERR_RESULT),
    ]);
    expect(describeToolUseVerdict(v)).toContain("EVERY dispatch failed");
  });
});
