/**
 * WARP-2469 — the approval round-trip, end to end through the agent
 * loop.
 *
 * WHAT MAKES THIS A REAL TEST AND NOT A MOCK CHOREOGRAPHY: the tool
 * dispatch below is backed by the REAL WARP-2305 interceptor
 * (`createToolCallInterceptor` from `@droplet/tools-core`), wired exactly
 * as `services/mcp-server/src/server.ts:159` wires it — intercept, and
 * only on `proceed` call the handler. Nothing about the gate is stubbed.
 * So when a call executes here it is because the interceptor's binding
 * hash actually admitted the token, and when it is refused it is the
 * shipped code refusing it.
 *
 * The model is injected and re-issues the call, which is the half that
 * did not exist before this ticket: a challenge is only useful if the
 * thing that re-issues the call can present the approval.
 *
 * The fixture tool is the WARP-2305 NAKED-HANDLER class — a confirming
 * tool whose schema does not declare `confirmed`. Since WARP-2002 a real
 * token is the only way through for EVERY confirming tool; this class
 * was the one this ticket (WARP-2469) was written for.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createToolCallInterceptor,
  interceptOutcomeToToolResult,
  type InterceptableTool,
} from "@droplet/tools-core";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import { createChatApprovalStore } from "../services/chat-approval.service.js";
import { DENY_ALL_TOOL_SCOPE } from "../services/tool-access.service.js";
import type { SSEEvent } from "../types/sse-events.js";

const USER = "romain";

/** A confirming tool with NO handler-side confirmation code at all. */
const NAKED: InterceptableTool = {
  name: "pm_create_project",
  requiresConfirmation: true,
  requiresWrite: true,
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
};

const DELETE_FILE: InterceptableTool = {
  name: "delete_file",
  requiresConfirmation: true,
  requiresWrite: true,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

/**
 * WARP-2002 — shaped like the hand-rolled two-phase tools (`remove_device`,
 * `memory_forget`, …): its schema DECLARES `confirmed`. A fixture name, not a
 * catalog one, so the per-turn catalog/domain gates do not filter it out.
 */
const DECLARING: InterceptableTool = {
  name: "declaring_write",
  requiresConfirmation: true,
  requiresWrite: true,
  inputSchema: {
    type: "object",
    properties: { nodeId: { type: "string" }, confirmed: { type: "boolean" } },
  },
};

const TOOLS = [NAKED, DELETE_FILE, DECLARING];

/**
 * A faithful stand-in for the one `tool.handler(...)` call site.
 * Mirrors `services/mcp-server/src/server.ts`: intercept first, run the
 * handler only on `proceed`, and wrap whatever comes out in the MCP
 * text-content envelope the agent loop parses.
 */
function makeDispatch(now: () => number) {
  const interceptor = createToolCallInterceptor();
  const handler = vi.fn();
  const callTool = vi.fn(
    async (
      name: string,
      args: Record<string, unknown>,
      ctx?: { confirmationToken?: string },
    ) => {
      const tool = TOOLS.find((t) => t.name === name)!;
      const outcome = interceptor.intercept(
        tool,
        args,
        { confirmationToken: ctx?.confirmationToken },
        now(),
      );
      const refusal = interceptOutcomeToToolResult(tool, outcome);
      if (refusal) {
        return {
          // mcp-server sets `isError` only for `status === "error"`, so a
          // `confirmation_required` refusal is NOT an error — the same
          // distinction the agent loop reads downstream.
          isError: "status" in refusal && refusal.status === "error",
          content: [{ type: "text", text: JSON.stringify(refusal) }],
        };
      }
      // A test can make the tool itself fail (e.g. AUTH_REQUIRED) by having
      // the handler return an MCP result.
      const override = handler(name, args) as
        | { isError: boolean; content: { type: string; text: string }[] }
        | undefined;
      if (override) return override;
      return {
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, status: "ok", data: { created: true } }),
          },
        ],
      };
    },
  );
  return { interceptor, handler, callTool };
}

function toolCallTurn(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call-${name}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/**
 * One chat turn. Each `runAgent` call is a separate turn, which is what
 * a user sending "yes, go ahead" after approving actually produces.
 */
async function runTurn(args: {
  callTool: ReturnType<typeof makeDispatch>["callTool"];
  approvals: ReturnType<typeof createChatApprovalStore>;
  turns: unknown[];
  events: SSEEvent[];
  /** Receives the model stub, so a test can read what the model was sent. */
  onChat?: (chat: ReturnType<typeof vi.fn>) => void;
  /** WARP-3279 — the persisted conversation this turn belongs to. */
  threadId?: string;
  /** WARP-3279 — this turn's RBAC: the scope and the client's tool shelf. */
  toolAccessScope?: typeof DENY_ALL_TOOL_SCOPE;
  allowed_tools?: string[];
}) {
  const chat = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message:
            args.turns[Math.min(chat.mock.calls.length - 1, args.turns.length - 1)],
        },
      ],
    }),
  }));
  args.onChat?.(chat);
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue(
          TOOLS.map((t) => ({
            name: t.name,
            description: "d",
            inputSchema: t.inputSchema,
          })),
        ),
      callTool: args.callTool,
    } as never,
    aiGateway: { chat } as never,
    approvals: args.approvals,
    onEvent: (e) => args.events.push(e),
  };
  return runAgent(deps, {
    model: "m",
    messages: [{ role: "user", content: "do the thing" }],
    max_iter: 4,
    toolCallContext: { userId: USER },
    ...(args.toolAccessScope ? { toolAccessScope: args.toolAccessScope } : {}),
    ...(args.allowed_tools ? { allowed_tools: args.allowed_tools } : {}),
    ...(args.threadId
      ? { citationContext: { userId: USER, threadId: args.threadId, messageId: "msg" } }
      : {}),
  });
}

/** The `tool_confirmation` handle the chat surface renders. */
function confirmationHandle(events: SSEEvent[]) {
  for (const e of events) {
    if (e.type === "tool_result" && e.confirmation?.kind === "tool_confirmation") {
      return e.confirmation;
    }
  }
  return undefined;
}

describe("WARP-2469 — challenge → approve → bound token → execution", () => {
  it("completes end to end for a tool with no handler-side confirmation code", async () => {
    const clock = { now: Date.now() };
    const { handler, callTool, interceptor } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];

    // ── turn 1: the model calls, the interceptor refuses ──
    await runTurn({
      callTool,
      approvals,
      turns: [toolCallTurn("pm_create_project", { name: "Q3 rollout" }), {
        role: "assistant",
        content: "I need your approval first.",
      }],
      events,
    });

    expect(handler).not.toHaveBeenCalled();
    const handle = confirmationHandle(events);
    expect(handle).toBeDefined();
    expect(handle!.challengeId).toBeTruthy();
    expect(handle!.tool).toBe("pm_create_project");
    expect(handle!.status).toBe("pending");

    // ── the user approves; only now does a token exist for the loop ──
    const approved = approvals.approve(handle!.challengeId!, USER, clock.now);
    expect(approved.ok).toBe(true);

    // ── turn 2: the model re-issues the SAME call ──
    const events2: SSEEvent[] = [];
    await runTurn({
      callTool,
      approvals,
      turns: [toolCallTurn("pm_create_project", { name: "Q3 rollout" }), {
        role: "assistant",
        content: "Done.",
      }],
      events: events2,
    });

    // MUTATION (drop the `_meta` attachment in llm-agent.service.ts):
    // the second call is challenged again, the handler never runs → red.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("pm_create_project", { name: "Q3 rollout" });
    expect(confirmationHandle(events2)).toBeUndefined();

    // The token really was presented on `_meta`, and really was spent.
    const secondCallCtx = callTool.mock.calls[1]![2] as { confirmationToken?: string };
    expect(typeof secondCallCtx.confirmationToken).toBe("string");
    expect(interceptor.tokens.size()).toBeGreaterThan(0);
  });

  it("never puts the interceptor's token — or the arguments — on the wire", async () => {
    const clock = { now: Date.now() };
    const { callTool, interceptor } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];
    const mintSpy = vi.spyOn(interceptor.tokens, "mint");

    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("pm_create_project", {
          name: "Camille Moreau intake",
          owner: "camille.moreau@example-clinic.test",
        }),
        { role: "assistant", content: "needs approval" },
      ],
      events,
    });

    const minted = mintSpy.mock.results[0]!.value as { token: string };
    const handle = confirmationHandle(events);
    expect(handle).toBeDefined();

    // MUTATION (render raw arguments into the summary): the PHI
    // assertions below go red.
    const rendered = JSON.stringify(handle);
    expect(rendered).not.toContain(minted.token);
    expect(rendered).not.toContain("camille.moreau@example-clinic.test");
    expect(rendered).not.toContain("Moreau");
    // …and it is still a reviewable prompt.
    expect(handle!.summary!.fields.map((f) => f.key)).toEqual(["name", "owner"]);
  });
});

describe("WARP-2002 — the model cannot approve its own write", () => {
  it("a same-turn re-issue with `confirmed: true` is challenged again and never executes", async () => {
    const clock = { now: Date.now() };
    const { handler, callTool } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];

    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("declaring_write", { nodeId: "7" }),
        // The model, unprompted by any human, sets the flag itself.
        toolCallTurn("declaring_write", { nodeId: "7", confirmed: true }),
        { role: "assistant", content: "Removed." },
      ],
      events,
    });

    // MUTATION (restore the live-challenge acceptance in interceptor.ts):
    // the second call proceeds and the device is unpaired → red.
    expect(handler).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("after a HUMAN approves, the re-issue executes even though it carries `confirmed: true`", async () => {
    const clock = { now: Date.now() };
    const { handler, callTool } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];

    await runTurn({
      callTool,
      approvals,
      turns: [toolCallTurn("declaring_write", { nodeId: "7" }), { role: "assistant", content: "ok" }],
      events,
    });
    const handle = confirmationHandle(events);
    expect(approvals.approve(handle!.challengeId!, USER, clock.now).ok).toBe(true);

    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("declaring_write", { nodeId: "7", confirmed: true }),
        { role: "assistant", content: "Removed." },
      ],
      events: [],
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the model is never handed the confirmation token", async () => {
    const clock = { now: Date.now() };
    const { callTool, interceptor } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const mintSpy = vi.spyOn(interceptor.tokens, "mint");
    let chat: ReturnType<typeof vi.fn> | undefined;

    await runTurn({
      callTool,
      approvals,
      turns: [toolCallTurn("declaring_write", { nodeId: "7" }), { role: "assistant", content: "ok" }],
      events: [],
      onChat: (c) => (chat = c),
    });

    const minted = mintSpy.mock.results[0]!.value as { token: string };
    // The model's second request carries the tool result for the challenge.
    expect(chat!.mock.calls.length).toBeGreaterThanOrEqual(2);
    const sentToModel = JSON.stringify(chat!.mock.calls[1]);
    // Non-vacuous: the challenge itself really reached the model…
    expect(sentToModel).toContain("CONFIRMATION_REQUIRED");
    // …but its secret did not. MUTATION (drop the redaction in
    // llm-agent.service.ts) → red.
    expect(sentToModel).not.toContain(minted.token);
  });
});

describe("WARP-2469 — deny invalidates", () => {
  it("leaves the model challenged afresh and never executes the write", async () => {
    const clock = { now: Date.now() };
    const { handler, callTool } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];

    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("pm_create_project", { name: "Q3 rollout" }),
        { role: "assistant", content: "needs approval" },
      ],
      events,
    });
    const first = confirmationHandle(events)!;

    expect(approvals.deny(first.challengeId!, USER, clock.now)).toEqual({
      ok: true,
      tool: "pm_create_project",
    });

    const events2: SSEEvent[] = [];
    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("pm_create_project", { name: "Q3 rollout" }),
        { role: "assistant", content: "still needs approval" },
      ],
      events: events2,
    });

    // MUTATION (let deny leave the challenge live): the re-issued call
    // finds a claimable grant and executes with no prompt → red.
    expect(handler).not.toHaveBeenCalled();
    const second = confirmationHandle(events2);
    expect(second).toBeDefined();
    expect(second!.challengeId).not.toBe(first.challengeId);
    expect(approvals.get(first.challengeId!, clock.now)!.status).toBe("denied");
  });
});

describe("WARP-2469 — the token is bound, through the chat path", () => {
  it("refuses delete_file(b) after the user approved delete_file(a)", async () => {
    const clock = { now: Date.now() };
    const { handler, callTool } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];

    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("delete_file", { path: "/a" }),
        { role: "assistant", content: "needs approval" },
      ],
      events,
    });
    const handle = confirmationHandle(events)!;
    approvals.approve(handle.challengeId!, USER, clock.now);

    // The model now calls the same tool with DIFFERENT arguments.
    const events2: SSEEvent[] = [];
    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("delete_file", { path: "/b" }),
        { role: "assistant", content: "needs approval" },
      ],
      events: events2,
    });

    // WARP-3279 — the approved call (`/a`) replays server-side, exactly as
    // approved; the model's `/b` is answered from that result and never
    // reaches the dispatch port, let alone with `/a`'s token.
    // MUTATION (replay the MODEL's args, or bind by tool name only): `/b`
    // executes on `/a`'s approval → red.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("delete_file", { path: "/a" });
    expect(callTool.mock.calls.some((c) => (c[1] as { path?: string }).path === "/b")).toBe(false);
    expect(confirmationHandle(events2)).toBeUndefined();
    expect(approvals.get(handle.challengeId!, clock.now)!.status).toBe("spent");
  });
});

describe("WARP-2469 — expiry is visible, and re-requestable", () => {
  it("renders as expired past the interceptor TTL, and a fresh ask mints a new challenge", async () => {
    const clock = { now: Date.now() };
    const { handler, callTool } = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];

    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("pm_create_project", { name: "Q3 rollout" }),
        { role: "assistant", content: "needs approval" },
      ],
      events,
    });
    const handle = confirmationHandle(events)!;
    expect(approvals.get(handle.challengeId!, clock.now)!.status).toBe("pending");

    // Advance the clock past the interceptor's 5-minute TTL.
    clock.now += 5 * 60_000 + 1;

    // MUTATION (drop the expiry materialisation in `settle`): this stays
    // `pending` and the user is offered an approval that cannot work → red.
    expect(approvals.get(handle.challengeId!, clock.now)!.status).toBe("expired");
    expect(approvals.approve(handle.challengeId!, USER, clock.now)).toEqual({
      ok: false,
      reason: "expired",
    });

    // Re-request: asking again is challenged afresh, so the user is never
    // stuck with a dead prompt.
    const events2: SSEEvent[] = [];
    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("pm_create_project", { name: "Q3 rollout" }),
        { role: "assistant", content: "needs approval" },
      ],
      events: events2,
    });
    const second = confirmationHandle(events2)!;
    expect(second.challengeId).not.toBe(handle.challengeId);
    expect(second.status).toBe("pending");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("WARP-2469 — no approval store wired (voice, ToolSpec runs)", () => {
  it("still refuses the write and never leaks the token to the wire", async () => {
    const clock = { now: Date.now() };
    const { handler, callTool, interceptor } = makeDispatch(() => clock.now);
    const events: SSEEvent[] = [];
    const mintSpy = vi.spyOn(interceptor.tokens, "mint");

    const chat = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message:
              chat.mock.calls.length === 1
                ? toolCallTurn("pm_create_project", { name: "Q3" })
                : { role: "assistant", content: "needs approval" },
          },
        ],
      }),
    }));
    await runAgent(
      {
        mcp: {
          listTools: vi
            .fn()
            .mockResolvedValue(
              TOOLS.map((t) => ({ name: t.name, description: "d", inputSchema: {} })),
            ),
          callTool,
        } as never,
        aiGateway: { chat } as never,
        onEvent: (e) => events.push(e),
      },
      {
        model: "m",
        messages: [{ role: "user", content: "go" }],
        max_iter: 3,
        toolCallContext: { userId: USER },
      },
    );

    expect(handler).not.toHaveBeenCalled();
    const minted = mintSpy.mock.results[0]!.value as { token: string };
    // MUTATION (fall through to the WARP-640 branch when no store is
    // wired): the raw interceptor secret appears on the wire → red.
    expect(JSON.stringify(events)).not.toContain(minted.token);
  });
});

describe("WARP-3279 — an approved chat call replays server-side, exactly as approved", () => {
  async function challengeAndApprove(
    threadId?: string,
    tool = "pm_create_project",
    args: Record<string, unknown> = { name: "Q3 rollout" },
  ) {
    const clock = { now: Date.now() };
    const dispatch = makeDispatch(() => clock.now);
    const approvals = createChatApprovalStore();
    const events: SSEEvent[] = [];
    let turn1Chat: ReturnType<typeof vi.fn> | undefined;
    await runTurn({
      callTool: dispatch.callTool,
      approvals,
      turns: [
        toolCallTurn(tool, args),
        { role: "assistant", content: "Waiting for your approval." },
      ],
      events,
      threadId,
      onChat: (c) => (turn1Chat = c),
    });
    const handle = confirmationHandle(events)!;
    expect(approvals.approve(handle.challengeId!, USER, clock.now).ok).toBe(true);
    return { ...dispatch, approvals, handle, turn1Chat: turn1Chat! };
  }

  it("a model that REWORDS the args on the approval turn still gets exactly one execution, of the approved args", async () => {
    const { handler, callTool, approvals, handle } = await challengeAndApprove();
    const events2: SSEEvent[] = [];
    let chat: ReturnType<typeof vi.fn> | undefined;
    await runTurn({
      callTool,
      approvals,
      turns: [
        // gpt-oss reconstructing the call from its own prose.
        toolCallTurn("pm_create_project", { name: "Q3 roll-out plan", description: "as discussed" }),
        { role: "assistant", content: "Done — the project is created." },
      ],
      events: events2,
      onChat: (c) => (chat = c),
    });

    // MUTATION (drop the replay; fall back to the model re-issue path): the
    // reworded call is challenged again and nothing executes → red.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("pm_create_project", { name: "Q3 rollout" });
    // No second approval prompt for the user.
    expect(confirmationHandle(events2)).toBeUndefined();
    expect(approvals.get(handle.challengeId!)!.status).toBe("spent");

    // The model saw the replayed call and its result before its first answer.
    const firstRequest = JSON.stringify(chat!.mock.calls[0]);
    expect(firstRequest).toContain("pm_create_project");
    expect(firstRequest).toContain('\\"created\\":true');

    // The dashboard sees the call like any other.
    const call = events2.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ name: "pm_create_project", args: { name: "Q3 rollout" } });
    const result = events2.find(
      (e) => e.type === "tool_result" && e.id === (call as { id: string }).id,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("replays once: a later turn does not run it again", async () => {
    const { handler, callTool, approvals } = await challengeAndApprove();
    for (let i = 0; i < 2; i++) {
      await runTurn({
        callTool,
        approvals,
        turns: [{ role: "assistant", content: "ok" }],
        events: [],
      });
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not replay into another conversation", async () => {
    const { handler, callTool, approvals, handle } = await challengeAndApprove("thread-a");
    await runTurn({
      callTool,
      approvals,
      turns: [{ role: "assistant", content: "ok" }],
      events: [],
      threadId: "thread-b",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(approvals.get(handle.challengeId!)!.status).toBe("approved");

    await runTurn({
      callTool,
      approvals,
      turns: [{ role: "assistant", content: "ok" }],
      events: [],
      threadId: "thread-a",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never tells the model to present a token in chat", async () => {
    const { turn1Chat } = await challengeAndApprove();
    const challengeSeen = JSON.stringify(turn1Chat.mock.calls[1]);
    expect(challengeSeen).toContain("CONFIRMATION_REQUIRED");
    // MUTATION (forward the interceptor's generic text): "presenting this
    // confirmationToken" reaches the model → red.
    expect(challengeSeen).not.toMatch(/confirmationToken|present/i);
  });

  it.each([
    // `delete_file` is a catalog tool, so the scope applies to it. The scope
    // narrows this turn's pool first, so the replay meets it as unavailable.
    ["the current scope denies it", "delete_file", { toolAccessScope: DENY_ALL_TOOL_SCOPE }, "TOOL_UNAVAILABLE"],
    ["allowed_tools omits it", "pm_create_project", { allowed_tools: ["declaring_write"] }, "TOOL_UNAVAILABLE"],
  ])("RBAC is re-decided at replay: not executed when %s", async (_label, tool, rbac, code) => {
    const { handler, callTool, approvals, handle } = await challengeAndApprove(undefined, tool, { path: "/a" });
    const events2: SSEEvent[] = [];
    await runTurn({
      callTool,
      approvals,
      turns: [{ role: "assistant", content: "ok" }],
      events: events2,
      ...rbac,
    });
    // MUTATION (skip the denial check on the replay path): the approved
    // call dispatches despite the turn's scope → red.
    expect(handler).not.toHaveBeenCalled();
    expect(callTool.mock.calls.some((c) => c[2]?.confirmationToken)).toBe(false);
    const result = events2.find((e) => e.type === "tool_result" && e.id === `approved-${handle.challengeId}`);
    expect(result).toMatchObject({ ok: false, data: { error: { code } } });
  });

  it.each([
    [
      "the tool returned an error (AUTH_REQUIRED)",
      "handler",
      { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: "AUTH_REQUIRED", message: "sign in to Nextcloud" } }) }] },
    ],
    [
      "the interceptor refused the token (CONFIRMATION_REJECTED)",
      "dispatch",
      { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "confirmation_required", error: { code: "CONFIRMATION_REJECTED", message: "expired" } }) }] },
    ],
  ])("a replay that did not run is reported as failed, and the model's re-issue is challenged afresh: %s", async (_label, where, outcome) => {
    const { handler, callTool, approvals, handle } = await challengeAndApprove();
    if (where === "handler") handler.mockReturnValueOnce(outcome);
    else callTool.mockResolvedValueOnce(outcome);

    const events2: SSEEvent[] = [];
    let chat: ReturnType<typeof vi.fn> | undefined;
    await runTurn({
      callTool,
      approvals,
      turns: [
        toolCallTurn("pm_create_project", { name: "Q3 rollout" }),
        { role: "assistant", content: "Waiting for your approval." },
      ],
      events: events2,
      onChat: (c) => (chat = c),
    });

    // MUTATION (emit `ok: !isError`): the refused token reads as a green chip → red.
    const replay = events2.find((e) => e.type === "tool_result" && e.id === `approved-${handle.challengeId}`);
    expect(replay).toMatchObject({ ok: false });
    // MUTATION (add to replayedTools unconditionally): the re-issue is
    // answered "it has already run" and no new prompt appears → red.
    expect(JSON.stringify(chat!.mock.calls[1])).not.toContain("already run");
    const fresh = confirmationHandle(events2);
    expect(fresh).toBeDefined();
    expect(fresh!.challengeId).not.toBe(handle.challengeId);

    // The user can approve again, and the next turn runs it.
    expect(approvals.approve(fresh!.challengeId!, USER).ok).toBe(true);
    const events3: SSEEvent[] = [];
    await runTurn({ callTool, approvals, turns: [{ role: "assistant", content: "Done." }], events: events3 });
    expect(handler).toHaveBeenLastCalledWith("pm_create_project", { name: "Q3 rollout" });
    expect(events3.find((e) => e.type === "tool_result")).toMatchObject({ ok: true });
  });
});
