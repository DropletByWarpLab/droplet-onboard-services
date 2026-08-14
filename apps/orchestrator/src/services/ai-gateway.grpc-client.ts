/**
 * gRPC client for the AI Gateway InferenceService.
 *
 * Used for latency-sensitive inference calls per design doc Section 7:
 * "gRPC is used for latency-sensitive internal calls between the orchestrator
 * and the LLM service."
 *
 * Falls back to HTTP if gRPC is unavailable.
 */

import * as path from "node:path";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("ai-gateway-grpc");

// Dynamic imports for gRPC (optional dependency)
let grpc: typeof import("@grpc/grpc-js") | null = null;
let protoLoader: typeof import("@grpc/proto-loader") | null = null;

let client: any = null;
let _initPromise: Promise<boolean> | null = null;
let _available = false;

/**
 * Initialize the gRPC client. Safe to call from concurrent request paths:
 * the first caller kicks off the init and every caller — including ones
 * arriving while it is still in flight — awaits the same promise, so a
 * cold-start race can never surface a stale "unavailable" (WARP-1914).
 * If gRPC packages are not installed, silently falls back to HTTP.
 */
export function initGrpcClient(): Promise<boolean> {
  if (!_initPromise) {
    _initPromise = doInit();
  }
  return _initPromise;
}

async function doInit(): Promise<boolean> {
  try {
    grpc = await import("@grpc/grpc-js");
    protoLoader = await import("@grpc/proto-loader");
  } catch {
    logger.info("gRPC packages not available — using HTTP fallback for AI Gateway");
    return false;
  }

  try {
    // Resolve proto relative to this file: services/ -> orchestrator/ -> apps/ -> repo root
    const protoPath = path.resolve(__dirname, "..", "..", "..", "..", "proto", "inference.proto");
    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    const InferenceService = proto.droplet.inference.InferenceService;

    client = new InferenceService(
      config.AI_GATEWAY_GRPC_URL,
      grpc.credentials.createInsecure()
    );

    _available = true;
    logger.info({ target: config.AI_GATEWAY_GRPC_URL }, "gRPC client initialized");
    return true;
  } catch (err) {
    logger.warn({ err }, "Failed to initialize gRPC client — using HTTP fallback");
    return false;
  }
}

export function isGrpcAvailable(): boolean {
  return _available;
}

export interface GrpcChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  provider?: string;
  priority?: number;
}

export interface GrpcChatResponse {
  content: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  finish_reason: string;
}

/**
 * Unary chat completion via gRPC.
 */
export function grpcChat(request: GrpcChatRequest): Promise<GrpcChatResponse> {
  if (!client || !_available) {
    return Promise.reject(new Error("gRPC client not available"));
  }

  return new Promise((resolve, reject) => {
    client.Chat(
      {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.max_tokens,
        provider: request.provider,
        priority: request.priority ?? 0,
      },
      { deadline: Date.now() + 300_000 }, // 5 minute timeout for inference
      (err: any, response: any) => {
        if (err) {
          // Check for queue full (RESOURCE_EXHAUSTED)
          if (err.code === 8) {
            reject(new QueueFullError(err.details || "Queue full"));
            return;
          }
          reject(err);
          return;
        }
        resolve({
          content: response.content || "",
          model: response.model || request.model,
          usage: {
            prompt_tokens: response.usage?.prompt_tokens || 0,
            completion_tokens: response.usage?.completion_tokens || 0,
          },
          finish_reason: response.finish_reason || "stop",
        });
      }
    );
  });
}

/**
 * Server-streaming chat completion via gRPC.
 * Returns an async generator of content deltas.
 */
export async function* grpcStreamChat(
  request: GrpcChatRequest
): AsyncGenerator<string, void, unknown> {
  if (!client || !_available) {
    throw new Error("gRPC client not available");
  }

  const call = client.StreamChat({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.7,
    max_tokens: request.max_tokens,
    provider: request.provider,
    priority: request.priority ?? 0,
  });

  for await (const chunk of call) {
    if (chunk.done) break;
    if (chunk.delta) {
      yield chunk.delta;
    }
  }
}

/**
 * List models via gRPC.
 */
export function grpcListModels(): Promise<Array<{ id: string; provider: string; name: string; context_window?: number }>> {
  if (!client || !_available) {
    return Promise.reject(new Error("gRPC client not available"));
  }

  return new Promise((resolve, reject) => {
    client.ListModels({}, (err: any, response: any) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(response.models || []);
    });
  });
}

/**
 * Embed a batch of texts via gRPC. Returns one float[] per input text.
 * Uses the ai-gateway's EmbedText RPC (sentence-transformers on CPU).
 */
export function grpcEmbedText(
  texts: string[],
  model?: string
): Promise<number[][]> {
  if (!client || !_available) {
    return Promise.reject(new Error("gRPC client not available"));
  }

  return new Promise((resolve, reject) => {
    const req: Record<string, unknown> = { texts };
    if (model) req.model = model;

    client.EmbedText(
      req,
      { deadline: Date.now() + 60_000 }, // 60s timeout for large batches
      (err: any, response: any) => {
        if (err) {
          reject(err);
          return;
        }
        const embeddings: number[][] = (response.embeddings || []).map(
          (arr: any) => arr.values || []
        );
        resolve(embeddings);
      }
    );
  });
}

export class QueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueFullError";
  }
}

/**
 * Close the gRPC client connection.
 */
export function closeGrpcClient(): void {
  if (client) {
    client.close();
    client = null;
    _available = false;
  }
}
