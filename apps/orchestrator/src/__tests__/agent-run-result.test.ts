/**
 * WARP-3300 — a chat-started background run's brief, and its result message
 * back into the conversation that started it.
 */
import { describe, it, expect, vi } from "vitest";
import {
  boundSummary,
  chatRunBrief,
  deliverRunResults,
  runArtifacts,
  RESULT_DELIVERY_MAX_ATTEMPTS,
  SUMMARY_MAX_CHARS,
} from "../services/agent-run-result.service.js";

type Run = Record<string, unknown> & { id: string };

/** Just enough Prisma for the sweep: the where-shapes it actually sends. */
function fakePrisma(runs: Run[], sessions: Array<{ id: string; userId: string }>, opts: { failInsert?: boolean } = {}) {
  const messages: Array<Record<string, unknown>> = [];
  const matchRun = (r: Run, where: Record<string, unknown>) => {
    if (where.id !== undefined && r.id !== where.id) return false;
    const rd = where.resultDelivery as { in: string[] } | undefined;
    if (rd && !rd.in.includes(r.resultDelivery as string)) return false;
    return true;
  };
  const tx = {
    chatMessage: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        messages.find((m) => m.sessionId === where.sessionId && m.turnId === where.turnId && m.role === where.role) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.failInsert) throw new Error("db down");
        const row = { id: `msg-${messages.length + 1}`, ...data };
        messages.push(row);
        return row;
      }),
    },
    chatSession: { update: vi.fn(async () => ({})) },
  };
  const prisma = {
    agentRun: {
      findMany: vi.fn(async () =>
        runs.filter(
          (r) =>
            r.origin === "chat" &&
            ["succeeded", "failed", "cancelled"].includes(r.status as string) &&
            (r.resultDelivery === "pending" ||
              (r.resultDelivery === "failed" && (r.resultDeliveryAttempts as number) < RESULT_DELIVERY_MAX_ATTEMPTS)),
        ),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of runs) {
          if (!matchRun(r, where)) continue;
          for (const [k, v] of Object.entries(data)) {
            r[k] = typeof v === "object" && v !== null && "increment" in v ? (r[k] as number) + (v as { increment: number }).increment : v;
          }
          count += 1;
        }
        return { count };
      }),
    },
    chatSession: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null),
    },
    chatMessage: tx.chatMessage,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, messages };
}

const chatRun = (over: Partial<Run> = {}): Run => ({
  id: "run-1",
  origin: "chat",
  status: "succeeded",
  title: "Supplier price check",
  goal: "Compare our three suppliers",
  result: "Brightline is cheapest at $39.",
  error: null,
  stopReason: "model_done",
  sessionId: "conv-1",
  resultDelivery: "pending",
  resultDeliveryAttempts: 0,
  trace: [
    { tool_call_id: "a", tool: "write_file", args: { path: "/Docs/prices.md" }, iteration: 1, dispatchedAt: "", text: '{"ok":true}' },
  ],
  ...over,
});

describe("chatRunBrief", () => {
  it("frames the goal as a bounded brief for a small-context parent", () => {
    const b = chatRunBrief({ goal: "Compare suppliers", title: "Price check", deliverable: "A table" });
    expect(b).toContain("Background task: Price check");
    expect(b).toContain("Compare suppliers");
    expect(b).toContain("A table");
    expect(b).toContain("at most 300 words");
  });
});

describe("boundSummary", () => {
  it("cuts at a word boundary within the column width", () => {
    const s = boundSummary("word ".repeat(600));
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toMatch(/wor…$/);
  });
});

describe("runArtifacts", () => {
  it("includes saved derived files and omits pending, failed or unknown media jobs", () => {
    const trace = [
      { tool: "analyze_data", text: JSON.stringify({ ok: true, data: { artifacts: [{ path: "/Analysis-1/chart.svg" }, { path: "/../escape.csv" }] } }) },
      { tool: "generate_media", args: { path: "/pending.png" }, text: JSON.stringify({ ok: true, data: { status: "running", path: "/pending.png" } }) },
      { tool: "generate_media", text: JSON.stringify({ ok: true, data: { status: "succeeded", path: "/saved.png" } }) },
      { tool: "generate_media", text: JSON.stringify({ ok: true, data: { status: "failed", path: "/failed.png" } }) },
      { tool: "generate_media", text: JSON.stringify({ ok: true, data: { status: "succeeded", path: "/unknown.png" } }), unknownOutcome: true },
      { tool: "create_artifact", args: { path: "/requested.html" }, text: JSON.stringify({ ok: true, data: { path: "/Demo.html" } }) },
      { tool: "create_artifact", args: { path: "/missing.html" }, text: '{"ok":true}' },
      { tool: "create_audio", args: { path: "/Speech.wav" }, text: JSON.stringify({ ok: true, data: { path: "/Speech.wav" } }) },
      { tool: "office_file", text: JSON.stringify({ ok: true, data: { action: "inspect", path: "/original.xlsx" } }) },
      { tool: "office_file", text: JSON.stringify({ ok: true, data: { action: "revise", path: "/revised.xlsx" } }) },
    ];
    expect(runArtifacts(trace).map((a) => a.ref)).toEqual(["/Analysis-1/chart.svg", "/saved.png", "/Demo.html", "/Speech.wav", "/revised.xlsx"]);
  });
  it("keeps only recorded, successful file writes, once each", () => {
    const art = runArtifacts([
      { tool: "write_file", args: { path: "/a.md" }, text: '{"ok":true}' },
      { tool: "write_file", args: { path: "/a.md" }, text: '{"ok":true}' },
      { tool: "copy_file", args: { from_path: "/x", to_path: "/b.md" }, text: "copied" },
      { tool: "write_file", args: { path: "/err.md" }, text: "boom", isError: true },
      { tool: "write_file", args: { path: "/parked.md" }, text: "{}", confirmation: "parked" },
      { tool: "create_document", args: { path: "/refused.md" }, text: '{"status":"error"}' },
      { tool: "write_file", args: { path: "/never.md" } },
      { tool: "search_content", args: { path: "/q" }, text: "{}" },
    ]);
    expect(art.map((a) => a.ref)).toEqual(["/a.md", "/b.md"]);
    expect(art[0]).toEqual({ kind: "file", ref: "/a.md", title: "a.md" });
  });

  it("returns PDF and PowerPoint decks only after a recorded successful render", () => {
    const artifacts = runArtifacts([
      { tool: "create_slide_deck", args: { path: "/Docs/pitch.pdf" }, text: '{"ok":true}' },
      { tool: "create_slide_deck", args: { path: "/Docs/pitch.pptx" }, text: '{"ok":true}' },
      { tool: "create_slide_deck", args: { path: "/Docs/failed.pdf" }, text: '{"ok":false,"status":"error"}' },
      { tool: "create_slide_deck", args: { path: "/Docs/unknown.pptx" }, text: '{"ok":true}', unknownOutcome: true },
      { tool: "create_slide_deck", args: { path: "/Docs/unrecorded.pdf" } },
    ]);
    expect(artifacts).toEqual([
      { kind: "file", ref: "/Docs/pitch.pdf", title: "pitch.pdf" },
      { kind: "file", ref: "/Docs/pitch.pptx", title: "pitch.pptx" },
    ]);
  });
});

describe("deliverRunResults", () => {
  it("posts one agent_run_result message and marks the run delivered", async () => {
    const runs = [chatRun()];
    const { prisma, messages } = fakePrisma(runs, [{ id: "conv-1", userId: "alice" }]);
    const publish = vi.fn();
    expect(await deliverRunResults({ prisma: prisma as never, publish })).toBe(1);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sessionId: "conv-1",
      role: "assistant",
      kind: "agent_run_result",
      turnId: "agent-run:run-1",
      meta: {
        runId: "run-1",
        status: "succeeded",
        title: "Supplier price check",
        summary: "Brightline is cheapest at $39.",
        artifacts: [{ kind: "file", ref: "/Docs/prices.md", title: "prices.md" }],
      },
    });
    expect(messages[0].content).toBe(
      'Background task "Supplier price check" finished: Brightline is cheapest at $39.\n\nFiles: /Docs/prices.md',
    );
    expect(runs[0]).toMatchObject({ resultDelivery: "delivered", summary: "Brightline is cheapest at $39." });
    expect(publish).toHaveBeenCalledWith(
      "droplet/chat/alice/turn-completed",
      expect.objectContaining({ conversationId: "conv-1", messageId: "msg-1", status: "completed" }),
    );

    // Delivered is terminal: the next tick posts nothing.
    expect(await deliverRunResults({ prisma: prisma as never, publish })).toBe(0);
    expect(messages).toHaveLength(1);
  });

  it("says what a stopped run got done", async () => {
    const runs = [chatRun({ status: "cancelled", result: null })];
    const { prisma, messages } = fakePrisma(runs, [{ id: "conv-1", userId: "alice" }]);
    await deliverRunResults({ prisma: prisma as never, publish: vi.fn() });
    expect(messages[0].content).toMatch(/was stopped: It was stopped before it finished\. 1 step completed\./);
  });

  it("marks a run whose conversation was deleted conversation_gone and posts nothing", async () => {
    const runs = [chatRun({ sessionId: "gone" })];
    const { prisma, messages } = fakePrisma(runs, []);
    await deliverRunResults({ prisma: prisma as never, publish: vi.fn() });
    expect(messages).toHaveLength(0);
    expect(runs[0].resultDelivery).toBe("conversation_gone");
  });

  it("retries a failed post, and stops after the attempt cap", async () => {
    const runs = [chatRun()];
    const { prisma } = fakePrisma(runs, [{ id: "conv-1", userId: "alice" }], { failInsert: true });
    for (let i = 0; i < RESULT_DELIVERY_MAX_ATTEMPTS + 2; i++) {
      await deliverRunResults({ prisma: prisma as never, publish: vi.fn() });
    }
    expect(runs[0]).toMatchObject({ resultDelivery: "failed", resultDeliveryAttempts: RESULT_DELIVERY_MAX_ATTEMPTS });
  });
});
