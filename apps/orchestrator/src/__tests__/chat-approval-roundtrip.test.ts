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
 * tool whose schema does not declare `confirmed`, so the legacy
 * `confirmed: true` path is unavailable to it and a real token is the
 * only way through. That is the class this ticket exists for.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createToolCallInterceptor,
  interceptOutcomeToToolResult,
  type InterceptableTool,
} from "@droplet/tools-core";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import { createChatApprovalStore } from "../services/chat-approval.service.js";
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

const TOOLS = [NAKED, DELETE_FILE];

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
      handler(name, args);
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

    // MUTATION (bind by tool name only): `/b` executes on `/a`'s
    // approval → red. This is WARP-2305's binding test, now exercised
    // through the chat approval path.
    expect(handler).not.toHaveBeenCalled();
    const ctx = callTool.mock.calls[1]![2] as { confirmationToken?: string };
    expect(ctx.confirmationToken).toBeUndefined();
    expect(confirmationHandle(events2)).toBeDefined();

    // …and the original approval is untouched, so the user does not have
    // to re-approve the call they already approved.
    expect(approvals.get(handle.challengeId!, clock.now)!.status).toBe("approved");
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
