/**
 * WARP-286 — gRPC client for ai-gateway's `Rerank` RPC.
 *
 * Mirrors the pattern in `embedding.client.ts`:
 *   - Lazy stub construction so startup doesn't fail when ai-gateway
 *     isn't yet reachable.
 *   - Empty input returns `{ scores: [] }` without making an RPC.
 *   - gRPC errors propagate as thrown `ServiceError`s. The caller
 *     (`rerankPassages` in `file-search.service.ts`) catches them and
 *     falls back to unranked input — so a reranker outage degrades
 *     gracefully to RRF-only results.
 *
 * The `stubFactory` constructor option is a test seam: production
 * callers pass `{ url }` only; tests inject a mock stub to avoid
 * touching the gRPC channel.
 */

import { credentials, type ServiceError } from "@grpc/grpc-js";
import {
  InferenceServiceClient,
  type RerankRequest,
  type RerankResponse,
} from "../grpc-generated/inference.js";

/**
 * Narrow stub surface — keeps the mock shape small in tests.
 */
export interface RerankStub {
  rerank: (
    req: RerankRequest,
    cb: (err: ServiceError | null, res: RerankResponse | null) => void,
  ) => unknown;
}

export interface RerankerClientOptions {
  /** ai-gateway gRPC endpoint, e.g. `ai-gateway:50051`. */
  url: string;
  /** Test seam — production paths instantiate `InferenceServiceClient` directly. */
  stubFactory?: (url: string) => RerankStub;
}

export class RerankerClient {
  private readonly stub: RerankStub;

  constructor(opts: RerankerClientOptions) {
    if (opts.stubFactory) {
      this.stub = opts.stubFactory(opts.url);
    } else {
      // Insecure credentials: ai-gateway runs on the internal Docker
      // network behind nginx — same trust boundary as the embedding client.
      this.stub = new InferenceServiceClient(
        opts.url,
        credentials.createInsecure(),
      ) as unknown as RerankStub;
    }
  }

  /**
   * Rerank a batch of passages for a query.
   *
   * @returns one float `score` per input passage, in the same order.
   *          Empty input returns `{ scores: [] }` without an RPC.
   * @throws  the underlying `ServiceError` on gRPC failure (the caller
   *          translates to a pass-through unranked result).
   */
  async rerank(args: {
    query: string;
    passages: string[];
    model?: string;
  }): Promise<{ scores: number[] }> {
    if (args.passages.length === 0) return { scores: [] };
    return new Promise<{ scores: number[] }>((resolve, reject) => {
      this.stub.rerank(
        { query: args.query, passages: args.passages, model: args.model },
        (err: ServiceError | null, res: RerankResponse | null) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({ scores: res?.scores ?? [] });
        },
      );
    });
  }
}
