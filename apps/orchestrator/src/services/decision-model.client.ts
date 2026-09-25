/**
 * WARP-3070 — gRPC client for ai-gateway's `Decide` RPC (the Kev decision
 * model, droplet-local-LLM ADR-006; rules in docs/agentic-workflows.md
 * § "Decision model (Kev)").
 *
 * Mirrors `query-classifier.client.ts` (lazy stub, `stubFactory` test seam,
 * insecure credentials on the internal network), with one deliberate
 * difference: it NEVER throws for an unavailable gateway. Kev is optional,
 * so every failure is data — a gRPC error (including UNIMPLEMENTED from a
 * gateway that predates this RPC) or a missed deadline becomes
 * `{ status: "unavailable" }`, and callers keep their non-Kev behaviour.
 * Not for the write-approval path: a probability may annotate a
 * confirmation, never approve one.
 */

import { credentials, Metadata, type ServiceError } from "@grpc/grpc-js";
import {
  DecideQuestionType,
  DecideStatus,
  InferenceServiceClient,
  type DecideAnswer as PbDecideAnswer,
  type DecideQuestion as PbDecideQuestion,
  type DecideRequest,
  type DecideResponse,
} from "../grpc-generated/inference.js";

/** Gateway-side sidecar timeout when the caller passes none (mirrors grpc_server.py). */
export const DECIDE_DEFAULT_TIMEOUT_MS = 2000;
/**
 * Headroom on the gRPC deadline over the sidecar timeout, so the gateway's
 * own timeout normally fires first and reports it as UNAVAILABLE data.
 */
const DEADLINE_MARGIN_MS = 500;

export type DecideQuestion =
  | { type: "noul"; instructions: string; trueDescription?: string; falseDescription?: string }
  /** Options are sent in array order; Kev reads the order. */
  | { type: "choice"; instructions: string; options: Array<{ name: string; description?: string }> }
  /** Levels ordered lowest to highest. */
  | { type: "score"; instructions: string; levels: string[] };

export type DecideAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: "score";
      /** Mean level index, from 0. */
      score: number;
      confidence: number;
      /** Level index as a string -> p. */
      probabilities: Record<string, number>;
      legend: Record<string, string>;
    };

export type DecideResult =
  | { status: "ok"; answers: Record<string, DecideAnswer>; latencyMs: number; model: string }
  | { status: "unavailable" | "invalid"; detail: string };

/** Narrow stub surface — keeps the mock shape small in tests. */
export interface DecideStub {
  decide: (
    req: DecideRequest,
    metadata: Metadata,
    options: { deadline: Date },
    cb: (err: ServiceError | null, res: DecideResponse | null) => void,
  ) => unknown;
}

export interface DecisionModelClientOptions {
  /** ai-gateway gRPC endpoint, e.g. `ai-gateway:50051`. */
  url: string;
  /** Test seam — production paths instantiate `InferenceServiceClient` directly. */
  stubFactory?: (url: string) => DecideStub;
}

const TYPE_TO_PB = {
  noul: DecideQuestionType.DECIDE_QUESTION_TYPE_NOUL,
  choice: DecideQuestionType.DECIDE_QUESTION_TYPE_CHOICE,
  score: DecideQuestionType.DECIDE_QUESTION_TYPE_SCORE,
} as const;

function toPbQuestion(q: DecideQuestion): PbDecideQuestion {
  return {
    type: TYPE_TO_PB[q.type],
    instructions: q.instructions,
    trueDescription: q.type === "noul" ? (q.trueDescription ?? "") : "",
    falseDescription: q.type === "noul" ? (q.falseDescription ?? "") : "",
    options: q.type === "choice" ? q.options.map((o) => ({ name: o.name, description: o.description ?? "" })) : [],
    levels: q.type === "score" ? q.levels : [],
  };
}

function fromPbAnswer(a: PbDecideAnswer): DecideAnswer | null {
  switch (a.type) {
    case DecideQuestionType.DECIDE_QUESTION_TYPE_NOUL:
      return { type: "noul", noul: a.noul };
    case DecideQuestionType.DECIDE_QUESTION_TYPE_CHOICE:
      return { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
    case DecideQuestionType.DECIDE_QUESTION_TYPE_SCORE:
      return {
        type: "score",
        score: a.score,
        confidence: a.confidence,
        probabilities: a.probabilities,
        legend: a.legend,
      };
    default:
      return null;
  }
}

function fromPbResponse(res: DecideResponse | null): DecideResult {
  switch (res?.status) {
    case DecideStatus.DECIDE_STATUS_OK: {
      const answers: Record<string, DecideAnswer> = {};
      for (const [id, a] of Object.entries(res.answers)) {
        const mapped = fromPbAnswer(a);
        if (!mapped) return { status: "unavailable", detail: `answer ${id} has an unknown type` };
        answers[id] = mapped;
      }
      return { status: "ok", answers, latencyMs: res.latencyMs, model: res.model };
    }
    case DecideStatus.DECIDE_STATUS_INVALID:
      return { status: "invalid", detail: res.detail };
    case DecideStatus.DECIDE_STATUS_UNAVAILABLE:
      return { status: "unavailable", detail: res.detail };
    default:
      // UNSPECIFIED / unknown: never guess OK from an unset status.
      return { status: "unavailable", detail: `unexpected Decide status ${String(res?.status)}` };
  }
}

export class DecisionModelClient {
  private readonly stub: DecideStub;

  constructor(opts: DecisionModelClientOptions) {
    if (opts.stubFactory) {
      this.stub = opts.stubFactory(opts.url);
    } else {
      // Insecure credentials: same trust boundary as the classifier/reranker clients.
      this.stub = new InferenceServiceClient(opts.url, credentials.createInsecure()) as unknown as DecideStub;
    }
  }

  /** Ask Kev typed questions about `state`. Never throws for gateway/sidecar unavailability. */
  async decide(args: {
    state: string;
    questions: Record<string, DecideQuestion>;
    timeoutMs?: number;
  }): Promise<DecideResult> {
    const timeoutMs = args.timeoutMs ?? DECIDE_DEFAULT_TIMEOUT_MS;
    const questions: Record<string, PbDecideQuestion> = {};
    for (const [id, q] of Object.entries(args.questions)) questions[id] = toPbQuestion(q);
    const req: DecideRequest = { state: args.state, questions, timeoutMs, model: "" };
    const deadline = new Date(Date.now() + timeoutMs + DEADLINE_MARGIN_MS);

    return new Promise<DecideResult>((resolve) => {
      try {
        this.stub.decide(req, new Metadata(), { deadline }, (err, res) => {
          if (err) {
            resolve({ status: "unavailable", detail: `gRPC ${err.code}: ${err.details || err.message}` });
            return;
          }
          resolve(fromPbResponse(res));
        });
      } catch (e) {
        resolve({ status: "unavailable", detail: e instanceof Error ? e.message : String(e) });
      }
    });
  }
}
