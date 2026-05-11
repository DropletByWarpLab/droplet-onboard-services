/**
 * WARP-286 — tiny gRPC client for ai-gateway's `Rerank` RPC.
 *
 * Same shape and rationale as `embedding.client.ts`:
 *   - Duplicated (intentionally) from the orchestrator's
 *     `reranker.client.ts` so the mcp-server stays a standalone process.
 *   - Uses `@grpc/proto-loader` at runtime, not ts-proto stubs — fewer
 *     build steps in the mcp-server pipeline.
 *   - Reconnects on SHUTDOWN like the embedding client so ai-gateway
 *     restarts don't require mcp-server restarts.
 *
 * Surfaces the `RerankerLike` shape consumed by `file-search.service.ts`
 * in this same workspace.
 */

import {
  credentials,
  type Channel,
  type ChannelCredentials,
  ChannelOptions,
  connectivityState,
  loadPackageDefinition,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync, type Options } from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

interface RerankRequest {
  query: string;
  passages: string[];
  model?: string;
}

interface RerankResponse {
  scores: number[];
}

interface InferenceClient {
  Rerank: (
    req: RerankRequest,
    cb: (err: ServiceError | null, res: RerankResponse | null) => void,
  ) => unknown;
  getChannel: () => Channel;
  close: () => void;
}

interface InferencePackage {
  droplet: {
    inference: {
      InferenceService: new (
        address: string,
        credentials: ChannelCredentials,
        options?: ChannelOptions,
      ) => InferenceClient;
    };
  };
}

const PROTO_LOADER_OPTIONS: Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

function resolveProtoPath(): string {
  if (process.env.RERANKER_PROTO_PATH) return process.env.RERANKER_PROTO_PATH;
  if (process.env.EMBEDDING_PROTO_PATH) return process.env.EMBEDDING_PROTO_PATH;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "proto", "inference.proto"),
    resolve(here, "..", "..", "proto", "inference.proto"),
    resolve(here, "..", "proto", "inference.proto"),
    resolve("/app/proto/inference.proto"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `reranker.client: cannot locate inference.proto. Tried: ${candidates.join(", ")}. ` +
      `Set RERANKER_PROTO_PATH or EMBEDDING_PROTO_PATH to override.`,
  );
}

export interface RerankerClientOptions {
  /** ai-gateway gRPC endpoint, e.g. `ai-gateway:50051`. */
  url: string;
  /** Test seam — production paths build a real gRPC client. */
  stubFactory?: (
    url: string,
  ) => Pick<InferenceClient, "Rerank" | "getChannel" | "close">;
}

export class RerankerClient {
  private readonly url: string;
  private readonly stubFactory?: (
    url: string,
  ) => Pick<InferenceClient, "Rerank" | "getChannel" | "close">;
  private stub: Pick<InferenceClient, "Rerank" | "getChannel" | "close"> | null =
    null;

  constructor(opts: RerankerClientOptions) {
    this.url = opts.url;
    this.stubFactory = opts.stubFactory;
  }

  private getStub(): Pick<InferenceClient, "Rerank" | "getChannel" | "close"> {
    if (this.stub) {
      try {
        const state = this.stub.getChannel().getConnectivityState(false);
        if (state === connectivityState.SHUTDOWN) {
          try {
            this.stub.close();
          } catch {
            /* ignore */
          }
          this.stub = null;
        }
      } catch {
        this.stub = null;
      }
    }

    if (this.stub) return this.stub;

    if (this.stubFactory) {
      this.stub = this.stubFactory(this.url);
      return this.stub;
    }

    const protoPath = resolveProtoPath();
    const packageDef = loadSync(protoPath, PROTO_LOADER_OPTIONS);
    const proto = loadPackageDefinition(packageDef) as unknown as InferencePackage;
    const InferenceService = proto.droplet.inference.InferenceService;
    this.stub = new InferenceService(this.url, credentials.createInsecure());
    return this.stub;
  }

  /**
   * Rerank a batch of passages for a query.
   *
   * @returns one float `score` per input passage, in the same order.
   *          Empty input returns `{ scores: [] }` without an RPC.
   * @throws  the underlying `ServiceError` on gRPC failure (the caller
   *          in file-search.service.ts catches and pass-throughs).
   */
  async rerank(args: {
    query: string;
    passages: string[];
    model?: string;
  }): Promise<{ scores: number[] }> {
    if (args.passages.length === 0) return { scores: [] };
    const stub = this.getStub();
    return new Promise<{ scores: number[] }>((resolve, reject) => {
      const req: RerankRequest = {
        query: args.query,
        passages: args.passages,
      };
      if (args.model !== undefined) req.model = args.model;
      stub.Rerank(req, (err: ServiceError | null, res: RerankResponse | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ scores: res?.scores ?? [] });
      });
    });
  }

  close(): void {
    if (this.stub) {
      try {
        this.stub.close();
      } catch {
        /* ignore */
      }
      this.stub = null;
    }
  }
}
