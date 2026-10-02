/**
 * WARP-3070 — DecisionModelClient: ok mapping, fail-soft on transport errors,
 * and deadline handling. Uses the `stubFactory` seam; no gRPC channel.
 */

import { status as GrpcStatus } from "@grpc/grpc-js";
import { describe, it, expect, vi } from "vitest";
import { DecisionModelClient, DECIDE_DEFAULT_TIMEOUT_MS, decideRequestSchema } from "../services/decision-model.client.js";
import { DecideQuestionType, DecideStatus } from "../grpc-generated/inference.js";
import { TOOLS } from "@droplet/tools-core";

function clientWith(impl: (req: any, md: any, opts: any, cb: any) => void) {
  const stub = { decide: vi.fn(impl) };
  return { stub, client: new DecisionModelClient({ url: "fake", stubFactory: () => stub }) };
}

const questions = {
  urgent: { type: "noul" as const, instructions: "Today?" },
  domain: {
    type: "choice" as const,
    instructions: "Which area?",
    options: [{ name: "network", description: "LAN" }, { name: "cameras" }],
  },
  severity: { type: "score" as const, instructions: "How bad?", levels: ["minor", "outage"] },
};

describe("DecisionModelClient", () => {
  it("maps an OK response and sends options in order", async () => {
    const { stub, client } = clientWith((_req, _md, _opts, cb) =>
      cb(null, {
        status: DecideStatus.DECIDE_STATUS_OK,
        model: "kev-latest",
        latencyMs: 12,
        detail: "",
        answers: {
          urgent: { type: DecideQuestionType.DECIDE_QUESTION_TYPE_NOUL, noul: 0.9, choice: "", score: 0, confidence: 0, probabilities: {}, legend: {} },
          domain: { type: DecideQuestionType.DECIDE_QUESTION_TYPE_CHOICE, noul: 0, choice: "cameras", score: 0, confidence: 0.7, probabilities: { network: 0.15, cameras: 0.85 }, legend: {} },
          severity: { type: DecideQuestionType.DECIDE_QUESTION_TYPE_SCORE, noul: 0, choice: "", score: 0.8, confidence: 0.6, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "minor", "1": "outage" } },
        },
      }),
    );
    const res = await client.decide({ state: "camera offline", questions });

    expect(res).toEqual({
      status: "ok",
      model: "kev-latest",
      latencyMs: 12,
      answers: {
        urgent: { type: "noul", noul: 0.9 },
        domain: { type: "choice", choice: "cameras", confidence: 0.7, probabilities: { network: 0.15, cameras: 0.85 } },
        severity: { type: "score", score: 0.8, confidence: 0.6, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "minor", "1": "outage" } },
      },
    });
    const sent = stub.decide.mock.calls[0][0];
    expect(sent.questions.domain.options).toEqual([
      { name: "network", description: "LAN" },
      { name: "cameras", description: "" },
    ]);
    expect(sent.questions.severity.levels).toEqual(["minor", "outage"]);
    expect(sent.timeoutMs).toBe(DECIDE_DEFAULT_TIMEOUT_MS);
  });

  it("maps a gRPC transport error to unavailable instead of throwing", async () => {
    const { client } = clientWith((_req, _md, _opts, cb) =>
      cb(Object.assign(new Error("connect ECONNREFUSED"), { code: GrpcStatus.UNAVAILABLE, details: "No connection established" }), null),
    );
    const res = await client.decide({ state: "x", questions });
    expect(res).toEqual({ status: "unavailable", detail: `gRPC ${GrpcStatus.UNAVAILABLE}: No connection established` });
  });

  it("passes the gateway's INVALID and UNAVAILABLE statuses through as data", async () => {
    for (const [pb, want] of [
      [DecideStatus.DECIDE_STATUS_INVALID, "invalid"],
      [DecideStatus.DECIDE_STATUS_UNAVAILABLE, "unavailable"],
      [DecideStatus.DECIDE_STATUS_UNSPECIFIED, "unavailable"],
    ] as const) {
      const { client } = clientWith((_req, _md, _opts, cb) =>
        cb(null, { status: pb, answers: {}, latencyMs: 0, model: "", detail: "why" }),
      );
      expect((await client.decide({ state: "x", questions })).status).toBe(want);
    }
  });

  it("sets a deadline past the sidecar timeout and maps DEADLINE_EXCEEDED to unavailable", async () => {
    const before = Date.now();
    const { stub, client } = clientWith((_req, _md, _opts, cb) =>
      cb(Object.assign(new Error("deadline"), { code: GrpcStatus.DEADLINE_EXCEEDED, details: "Deadline exceeded" }), null),
    );
    const res = await client.decide({ state: "x", questions, timeoutMs: 300 });

    const [req, , opts] = stub.decide.mock.calls[0];
    expect(req.timeoutMs).toBe(300);
    const deadline = (opts.deadline as Date).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + 300);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 300 + 1000);
    expect(res).toEqual({ status: "unavailable", detail: `gRPC ${GrpcStatus.DEADLINE_EXCEEDED}: Deadline exceeded` });
  });

  it("treats timeoutMs 0 (and negative) as the default, matching the proto and the gateway", async () => {
    for (const timeoutMs of [0, -5]) {
      const before = Date.now();
      const { stub, client } = clientWith((_req, _md, _opts, cb) =>
        cb(null, { status: DecideStatus.DECIDE_STATUS_OK, answers: {}, latencyMs: 0, model: "", detail: "" }),
      );
      await client.decide({ state: "x", questions, timeoutMs });
      const [req, , opts] = stub.decide.mock.calls[0];
      expect(req.timeoutMs).toBe(DECIDE_DEFAULT_TIMEOUT_MS);
      // The deadline must leave the gateway's own timeout room to fire first.
      expect((opts.deadline as Date).getTime()).toBeGreaterThanOrEqual(before + DECIDE_DEFAULT_TIMEOUT_MS);
    }
  });
});

// WARP-3074 — the classify_items tool builds this body in another package;
// a shape the route's `.strict()` schema rejects would make the tool a
// silent 400 → "invalid" on every item. Pin the real payload against it.
describe("decideRequestSchema accepts what classify_items sends", () => {
  it("parses the tool's request body for all three question types", async () => {
    const classifyItems = TOOLS.get("classify_items")!;
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "unavailable", detail: "x" })));
    const http = { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() };
    await classifyItems.handler(
      {
        items: [{ id: "a", text: "Invoice 42 is overdue" }],
        questions: {
          dept: { type: "choice", instructions: "Which department?", options: ["billing", "support"] },
          urgent: { type: "noul", instructions: "Urgent?" },
          tone: { type: "score", instructions: "How upset?", options: ["calm", "angry"] },
        },
      },
      { http: { orchestrator: http }, signal: new AbortController().signal } as never,
    );
    expect(post).toHaveBeenCalledWith("/api/llm/decide", expect.anything(), expect.anything());
    const parsed = decideRequestSchema.safeParse(post.mock.calls[0][1]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
