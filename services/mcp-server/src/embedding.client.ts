/**
 * Tiny gRPC client for ai-gateway's `EmbedText` RPC.
 *
 * Duplicated (intentionally) from
 * `apps/orchestrator/src/services/embedding.client.ts`. The mcp-server
 * runs as a separate process from the orchestrator (stdio child or
 * standalone HTTP container), so importing the orchestrator's client
 * across workspaces would require a build-time dependency on
 * `@droplet/orchestrator/dist/...`. We chose the duplicate path the
 * WARP-202 plan calls out: keep it tiny, keep the wire shape matched.
 *
 * Implementation choice: this client uses `@grpc/proto-loader` to load
 * the proto file at runtime, NOT ts-proto-generated stubs. Reasons:
 *   - The mcp-server Dockerfile copies the `proto/` directory at build
 *     time so the file is present at runtime.
 *   - No code generation step is required — fewer moving parts in the
 *     mcp-server build pipeline.
 *   - The wire shape is small (one RPC, two messages). The dynamic
 *     untyped client is acceptable here; we wrap it in a typed
 *     `EmbeddingClient` API so callers see the same `embed(texts) →
 *     number[][]` surface as the orchestrator's client.
 *
 * Reconnect-on-failure mirrors `services/file-indexer/embedder.py`:
 * recreate the channel + stub if the underlying connection enters
 * SHUTDOWN. gRPC-js handles transient reconnects internally for ALL
 * other states (IDLE → CONNECTING → READY), so we only need to react
 * to terminal SHUTDOWN.
 */

import {
  credentials,
  type Channel,
  type ChannelCredentials,
  ChannelOptions,
  connectivityState,
  loadPackageDefinition,
  Metadata,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync, type Options } from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

interface EmbedRequest {
  texts: string[];
  model?: string;
}

interface EmbedResponse {
  embeddings: { values: number[] }[];
}

interface InferenceClient {
  EmbedText: (
    req: EmbedRequest,
    cb: (err: ServiceError | null, res: EmbedResponse | null) => void,
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

/**
 * Resolve the proto path. Handled in this order:
 *   1. `EMBEDDING_PROTO_PATH` env override (test seam).
 *   2. The repo-root layout: `<dist>/embedding.client.js` →
 *      `services/mcp-server/dist/` → `../../proto/inference.proto`.
 *   3. The Docker layout where `proto/` is copied alongside `dist/`.
 *
 * Returns the first existing path or throws — better to fail fast on
 * boot than to silently accept "no embed" forever.
 */
function resolveProtoPath(): string {
  if (process.env.EMBEDDING_PROTO_PATH) return process.env.EMBEDDING_PROTO_PATH;

  // ESM-friendly __dirname — `import.meta.url` is the only portable
  // way to get this in a `"type": "module"` package.
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    resolve(here, "..", "..", "..", "proto", "inference.proto"), // repo dev (services/mcp-server/dist/)
    resolve(here, "..", "..", "proto", "inference.proto"),       // alt layout
    resolve(here, "..", "proto", "inference.proto"),             // Docker (proto/ alongside dist/)
    resolve("/app/proto/inference.proto"),                       // Docker absolute fallback
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `embedding.client: cannot locate inference.proto. Tried: ${candidates.join(", ")}. ` +
      `Set EMBEDDING_PROTO_PATH to override.`,
  );
}

export interface EmbeddingClientOptions {
  /** ai-gateway gRPC endpoint, e.g. `ai-gateway:50051`. */
  url: string;
  /** Test seam — production paths build a real gRPC client. */
  stubFactory?: (url: string) => Pick<InferenceClient, "EmbedText" | "getChannel" | "close">;
}

export class EmbeddingClient {
  private readonly url: string;
  private readonly stubFactory?: (url: string) => Pick<InferenceClient, "EmbedText" | "getChannel" | "close">;
  private stub: Pick<InferenceClient, "EmbedText" | "getChannel" | "close"> | null = null;

  constructor(opts: EmbeddingClientOptions) {
    this.url = opts.url;
    this.stubFactory = opts.stubFactory;
  }

  /**
   * Lazy stub factory. Mirrors `embedder.py._get_stub`: if the existing
   * channel has entered SHUTDOWN we drop the cached stub and recreate.
   * This handles ai-gateway restarts without restarting the mcp-server.
   */
  private getStub(): Pick<InferenceClient, "EmbedText" | "getChannel" | "close"> {
    if (this.stub) {
      try {
        const state = this.stub.getChannel().getConnectivityState(false);
        if (state === connectivityState.SHUTDOWN) {
          // Channel is gone — drop and recreate below.
          try {
            this.stub.close();
          } catch {
            /* ignore */
          }
          this.stub = null;
        }
      } catch {
        // getConnectivityState shouldn't throw, but be defensive.
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
   * Embed a batch of strings via the ai-gateway's `EmbedText` RPC.
   *
   * @returns one `number[]` vector per input text, in the same order.
   *          Empty input returns `[]` without an RPC.
   * @throws  the underlying `ServiceError` on gRPC failure (e.g.
   *          `UNAVAILABLE` when the ai-gateway is down). Callers
   *          translate this into domain errors — `search-content.ts`
   *          maps any thrown Error to `EMBEDDING_UNAVAILABLE`.
   */
  async embed(texts: string[], model?: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    const stub = this.getStub();
    return new Promise<number[][]>((resolve, reject) => {
      const req: EmbedRequest = { texts };
      if (model !== undefined) req.model = model;
      // The proto-loader generated client expects { texts, model? }
      // and a Node-callback `(err, res) => void`. Match the file-indexer
      // Python client exactly so the wire shape stays portable.
      stub.EmbedText(req, (err: ServiceError | null, res: EmbedResponse | null) => {
        if (err) {
          reject(err);
          return;
        }
        const out = (res?.embeddings ?? []).map((e) => e?.values ?? []);
        resolve(out);
      });
    });
  }

  /** Tear down the channel — used by graceful shutdown paths. */
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

// Re-export Metadata so callers in other modules don't need a separate
// @grpc/grpc-js import for type-only purposes.
export { Metadata };
