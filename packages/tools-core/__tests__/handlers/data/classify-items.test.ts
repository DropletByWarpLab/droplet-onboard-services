/**
 * WARP-3074 — `classify_items`: bulk labelling through `POST /api/llm/decide`
 * (orchestrator → DecisionModelClient → ai-gateway Decide → Kev).
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import classifyItems from "../../../src/handlers/data/classify-items.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(post: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const OK = {
  status: "ok",
  model: "kev-0.8b",
  latencyMs: 400,
  answers: {
    dept: { type: "choice", choice: "billing", confidence: 0.91, probabilities: { billing: 0.91, support: 0.09 } },
    urgent: { type: "noul", noul: 0.2 },
    tone: {
      type: "score",
      score: 1.8,
      confidence: 0.7,
      probabilities: { "0": 0.05, "1": 0.2, "2": 0.75 },
      legend: { "0": "calm", "1": "annoyed", "2": "angry" },
    },
  },
};

const QUESTIONS = {
  dept: { type: "choice", instructions: "Which department handles this?", options: ["billing", "support"] },
  urgent: { type: "noul", instructions: "Is this urgent?" },
  tone: { type: "score", instructions: "How upset is the sender?", options: ["calm", "annoyed", "angry"] },
};

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, text: `mail ${i}` }));

describe("classify_items", () => {
  it("sends one Decide call per item in the gateway's question shape and renders a table", async () => {
    const post = vi.fn().mockImplementation(async () => json(OK));
    const res = await classifyItems.handler({ items: items(2), questions: QUESTIONS }, ctxWith(post));

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/api/llm/decide",
      {
        state: "mail 0",
        questions: {
          dept: { type: "choice", instructions: "Which department handles this?", options: [{ name: "billing" }, { name: "support" }] },
          urgent: { type: "noul", instructions: "Is this urgent?" },
          tone: { type: "score", instructions: "How upset is the sender?", levels: ["calm", "annoyed", "angry"] },
        },
        timeoutMs: 3000,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { classified: number; total: number; model: string; table: string; note?: string };
    expect(data).toMatchObject({ classified: 2, total: 2, model: "kev-0.8b" });
    expect(data.note).toBeUndefined();
    expect(data.table.split("\n")).toEqual([
      "| id | status | dept | urgent | tone |",
      "|---|---|---|---|---|",
      "| m0 | ok | billing 91% | no 80% | angry 75% |",
      "| m1 | ok | billing 91% | no 80% | angry 75% |",
    ]);
  });

  it("returns CLASSIFIER_UNAVAILABLE and stops after the first failure when the sidecar is off", async () => {
    const post = vi.fn().mockResolvedValue(json({ status: "unavailable", detail: "gRPC 14: connect refused" }));
    const res = await classifyItems.handler({ items: items(5), questions: QUESTIONS }, ctxWith(post));
    expect(post).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: false, error: { code: "CLASSIFIER_UNAVAILABLE" } });
    if (!res.ok) expect(res.error.message).toMatch(/yourself/);
  });

  it("treats a thrown request or a 5xx as unavailable", async () => {
    for (const post of [vi.fn().mockRejectedValue(new Error("ECONNREFUSED")), vi.fn().mockResolvedValue(json({}, 502))]) {
      const res = await classifyItems.handler({ items: items(1), questions: QUESTIONS }, ctxWith(post));
      expect(res).toMatchObject({ ok: false, error: { code: "CLASSIFIER_UNAVAILABLE" } });
    }
  });

  it("keeps finished rows and marks the rest not_run when the classifier drops mid-batch", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(json(OK))
      .mockResolvedValueOnce(json({ status: "unavailable", detail: "deadline" }));
    const res = await classifyItems.handler({ items: items(3), questions: QUESTIONS }, ctxWith(post));
    expect(post).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { classified: number; table: string; note: string };
    expect(data.classified).toBe(1);
    expect(data.table).toContain("| m1 | unavailable |");
    expect(data.table).toContain("| m2 | not_run |");
    expect(data.note).toMatch(/call again/);
  });

  it("reports an item Kev refused as invalid and carries on", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(json({ status: "invalid", detail: "state too long" }))
      .mockResolvedValueOnce(json(OK));
    const res = await classifyItems.handler({ items: items(2), questions: QUESTIONS }, ctxWith(post));
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { table: string }).table).toContain("| m0 | invalid: state too long |");
  });

  it.each([
    [{ items: [], questions: QUESTIONS }, /non-empty array/],
    [{ items: items(26), questions: QUESTIONS }, /at most 25 items/],
    [{ items: [{ id: "a", text: "x" }, { id: "a", text: "y" }], questions: QUESTIONS }, /duplicate item id/],
    [{ items: [{ id: "a", text: "" }], questions: QUESTIONS }, /items\[0\]\.text/],
    [{ items: items(1), questions: {} }, /1 to 3 entries/],
    [{ items: items(1), questions: { ...QUESTIONS, extra: QUESTIONS.urgent } }, /1 to 3 entries/],
    [{ items: items(1), questions: { q: { type: "rank", instructions: "x" } } }, /noul, choice or score/],
    [{ items: items(1), questions: { q: { type: "choice", instructions: "x" } } }, /distinct non-empty strings/],
    [{ items: items(1), questions: { q: { type: "score", instructions: "x", options: ["only"] } } }, /2-20/],
    [{ items: items(1), questions: { q: { type: "choice", instructions: "x", options: ["a", "a"] } } }, /distinct/],
    [{ items: items(1), questions: { "bad name": QUESTIONS.urgent } }, /question name/],
  ])("rejects bad input without calling the classifier (%#)", async (args, message) => {
    const post = vi.fn();
    const res = await classifyItems.handler(args as Record<string, unknown>, ctxWith(post));
    expect(post).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    if (!res.ok) expect(res.error.message).toMatch(message);
  });

  it("stops starting new items once the time budget is spent", async () => {
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const post = vi.fn().mockImplementation(async () => {
        now += 25_000; // each call takes 25 s of wall time
        return json(OK);
      });
      const res = await classifyItems.handler({ items: items(4), questions: QUESTIONS }, ctxWith(post));
      expect(post).toHaveBeenCalledTimes(2);
      if (res.ok) expect((res.data as { table: string }).table).toContain("| m2 | not_run |");
    } finally {
      spy.mockRestore();
    }
  });

  it("is read-only", () => {
    expect(classifyItems.requiresWrite).toBe(false);
    expect(classifyItems.requiresConfirmation).toBe(false);
  });
});
