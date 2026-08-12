/**
 * initGrpcClient() concurrency contract (WARP-1914).
 *
 * The /files search endpoints init the gRPC client on demand from two
 * independent request paths (the /search/status probe and the
 * semantic/hybrid query). On a cold orchestrator those can arrive
 * near-simultaneously, so a caller that lands while the first init is
 * still in flight must wait for the real outcome — a check-then-act
 * boolean guard would hand it the stale `_available === false` and the
 * dashboard would render a spurious 503 / gatewayHealthy:false on a
 * healthy box.
 */

import { describe, it, expect, vi } from "vitest";

// A gate the test controls so the "cold import of @grpc/grpc-js" window
// is held open deterministically while the second caller arrives.
const gate = vi.hoisted(() => {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release, grpcImports: { count: 0 } };
});

vi.mock("@grpc/grpc-js", async () => {
  gate.grpcImports.count += 1;
  await gate.opened;
  class FakeInferenceService {
    constructor(_target: string, _creds: unknown) {}
    close(): void {}
  }
  return {
    loadPackageDefinition: () => ({
      droplet: { inference: { InferenceService: FakeInferenceService } },
    }),
    credentials: { createInsecure: () => ({}) },
  };
});

vi.mock("@grpc/proto-loader", () => ({
  loadSync: () => ({}),
}));

describe("initGrpcClient (WARP-1914 cold-start race)", () => {
  it("gives a concurrent caller the real init outcome, not a stale unavailable", async () => {
    const mod = await import("./ai-gateway.grpc-client.js");

    // Two request-driven callers hit a cold orchestrator back to back;
    // the first is parked inside the gated @grpc/grpc-js import when the
    // second arrives.
    const first = mod.initGrpcClient();
    const second = mod.initGrpcClient();

    gate.release();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(mod.isGrpcAvailable()).toBe(true);

    // Both callers shared one underlying init — the module was imported once.
    expect(gate.grpcImports.count).toBe(1);
  });

  it("stays memoized after init settles", async () => {
    const mod = await import("./ai-gateway.grpc-client.js");
    await expect(mod.initGrpcClient()).resolves.toBe(true);
    expect(gate.grpcImports.count).toBe(1);
  });
});
