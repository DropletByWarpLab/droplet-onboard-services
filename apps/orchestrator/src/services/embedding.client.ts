/**
 * gRPC client for ai-gateway's `EmbedText` RPC.
 *
 * Mirrors `services/file-indexer/embedder.py`:
 *   - Lazy stub creation (the channel is built on first call so process
 *     startup doesn't fail when ai-gateway isn't reachable yet).
 *   - Empty input returns `[]` without making an RPC.
 *   - gRPC errors propagate as thrown `Error`s — callers translate to
 *     domain errors (e.g. `search-content.ts` → `EMBEDDING_FAILED`).
 *
 * The `stubFactory` constructor option is a test seam: production callers
 * pass `{ url }` only; tests inject a mock stub to avoid touching the
 * gRPC channel.
 *
 * NOTE: ts-proto generated method names use lower-camelCase (`embedText`),
 * matching the JS gRPC convention. The proto definition itself uses
 * `EmbedText` (UpperCamelCase) per Google style — both are equivalent on
 * the wire.
 */

import { credentials, type ServiceError } from "@grpc/grpc-js";
import { InferenceServiceClient, type EmbedRequest, type EmbedResponse } from "../grpc-generated/inference.js";

/**
 * The minimal stub shape we depend on. Keeping this narrow lets tests
 * pass a tiny mock without having to satisfy the full
 * `InferenceServiceClient` interface (which extends `Client` with many
 * inherited members).
 */
export interface EmbedTextStub {
  embedText: (
    req: EmbedRequest,
    cb: (err: ServiceError | null, res: EmbedResponse | null) => void,
  ) => unknown;
}

export interface EmbeddingClientOptions {
  /** ai-gateway gRPC endpoint, e.g. `ai-gateway:50051`. */
  url: string;
  /** Test seam — production paths instantiate `InferenceServiceClient` directly. */
  stubFactory?: (url: string) => EmbedTextStub;
}

export class EmbeddingClient {
  private readonly stub: EmbedTextStub;

  constructor(opts: EmbeddingClientOptions) {
    if (opts.stubFactory) {
      this.stub = opts.stubFactory(opts.url);
    } else {
      // The InferenceServiceClient constructor is the generic gRPC client
      // factory from grpc-js. We use insecure credentials because the
      // ai-gateway runs on the internal Docker network behind nginx —
      // the trust boundary is the host, not the gRPC channel itself.
      this.stub = new InferenceServiceClient(
        opts.url,
        credentials.createInsecure(),
      ) as unknown as EmbedTextStub;
    }
  }

  /**
   * Embed a batch of strings via the ai-gateway's `EmbedText` RPC.
   *
   * @returns one `number[]` vector per input text, in the same order.
   *          Empty input returns `[]` without an RPC.
   * @throws  the underlying `ServiceError` on gRPC failure (e.g.
   *          `UNAVAILABLE` when the ai-gateway is down).
   */
  async embed(texts: string[], model?: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    return new Promise<number[][]>((resolve, reject) => {
      this.stub.embedText(
        { texts, model },
        (err: ServiceError | null, res: EmbedResponse | null) => {
          if (err) {
            reject(err);
            return;
          }
          // ts-proto's generated `EmbedResponse` has `embeddings: FloatArray[]`
          // and `FloatArray.values: number[]`. Defensive on missing arrays so
          // a partial response can't crash the caller — we mirror what
          // `embedder.py` does (`[list(arr.values) for arr in response.embeddings]`).
          const out = (res?.embeddings ?? []).map((e) => e?.values ?? []);
          resolve(out);
        },
      );
    });
  }
}
