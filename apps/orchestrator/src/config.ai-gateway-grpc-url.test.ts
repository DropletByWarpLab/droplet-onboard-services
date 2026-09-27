/**
 * WARP-3193 ARCH-6 — AI_GATEWAY_GRPC_URL has ONE default, in config.ts.
 *
 * The routes used to read `process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051"`
 * while config.ts defaulted to `localhost:50051`, so with the variable unset
 * (compose sets it only for file-indexer, not the orchestrator) the gRPC
 * client dialled the orchestrator container's own loopback. The compose
 * service name is the default every caller now shares.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("WARP-3193 ARCH-6 — AI_GATEWAY_GRPC_URL config", () => {
  const original = process.env.AI_GATEWAY_GRPC_URL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.AI_GATEWAY_GRPC_URL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AI_GATEWAY_GRPC_URL;
    else process.env.AI_GATEWAY_GRPC_URL = original;
  });

  it("defaults to the compose service name when unset", async () => {
    const { config } = await import("./config.js");
    expect(config.AI_GATEWAY_GRPC_URL).toBe("ai-gateway:50051");
  });

  it("honours an explicit override", async () => {
    process.env.AI_GATEWAY_GRPC_URL = "ai-gateway-disabled:50051";
    const { config } = await import("./config.js");
    expect(config.AI_GATEWAY_GRPC_URL).toBe("ai-gateway-disabled:50051");
  });
});
