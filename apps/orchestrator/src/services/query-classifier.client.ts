/**
 * WARP-437 — gRPC client for ai-gateway's `ClassifyQuery` RPC.
 *
 * Mirrors the pattern in `reranker.client.ts`:
 *   - Lazy stub construction so startup doesn't fail when ai-gateway
 *     isn't yet reachable.
 *   - Empty input returns `("unknown", 0.0)` without making an RPC.
 *   - gRPC errors propagate as thrown `ServiceError`s. The caller
 *     (`classifyQuery` in `query-enhancement.service.ts`) catches them
 *     and falls back to `("unknown", 0.0)` so adaptive routing degrades
 *     gracefully to the static default preset.
 *
 * The `stubFactory` constructor option is a test seam: production
 * callers pass `{ url }` only; tests inject a mock stub to avoid
 * touching the gRPC channel.
 */

import { credentials, type ServiceError } from "@grpc/grpc-js";
import {
  InferenceServiceClient,
  type ClassifyQueryRequest,
  type ClassifyQueryResponse,
} from "../grpc-generated/inference.js";

/**
 * Narrow stub surface — keeps the mock shape small in tests.
 */
export interface ClassifyQueryStub {
  classifyQuery: (
    req: ClassifyQueryRequest,
    cb: (err: ServiceError | null, res: ClassifyQueryResponse | null) => void,
  ) => unknown;
}

export interface QueryClassifierClientOptions {
  /** ai-gateway gRPC endpoint, e.g. `ai-gateway:50051`. */
  url: string;
  /** Test seam — production paths instantiate `InferenceServiceClient` directly. */
  stubFactory?: (url: string) => ClassifyQueryStub;
}

export class QueryClassifierClient {
  private readonly stub: ClassifyQueryStub;

  constructor(opts: QueryClassifierClientOptions) {
    if (opts.stubFactory) {
      this.stub = opts.stubFactory(opts.url);
    } else {
      // Insecure credentials: ai-gateway runs on the internal Docker
      // network behind nginx — same trust boundary as the reranker client.
      this.stub = new InferenceServiceClient(
        opts.url,
        credentials.createInsecure(),
      ) as unknown as ClassifyQueryStub;
    }
  }

  /**
   * Classify a query into one of the WARP-437 routing classes.
   *
   * @returns `{ class, confidence }`. Empty input short-circuits to
   *          `("unknown", 0)` without an RPC.
   * @throws  the underlying `ServiceError` on gRPC failure (the caller
   *          translates to a `"unknown"` fallback).
   */
  async classify(args: { query: string }): Promise<{ class: string; confidence: number }> {
    if (!args.query) return { class: "unknown", confidence: 0 };
    return new Promise<{ class: string; confidence: number }>((resolve, reject) => {
      this.stub.classifyQuery(
        { query: args.query, model: "" },
        (err: ServiceError | null, res: ClassifyQueryResponse | null) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            class: res?.class ?? "unknown",
            confidence: res?.confidence ?? 0,
          });
        },
      );
    });
  }
}
