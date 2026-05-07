/**
 * EmbeddingClient — unit tests.
 *
 * The client wraps the auto-generated `InferenceServiceClient.embedText`
 * (gRPC-js) and matches the shape of `services/file-indexer/embedder.py`:
 * lazy stub creation, empty-input short-circuit, error propagation.
 *
 * Tests use a `stubFactory` seam to inject a mock without touching the
 * gRPC channel — production paths instantiate `InferenceServiceClient`
 * directly against the ai-gateway URL.
 */

import { describe, it, expect, vi } from "vitest";
import { EmbeddingClient } from "../services/embedding.client.js";

describe("EmbeddingClient", () => {
  it("calls embedText and returns float vectors", async () => {
    const stub = {
      embedText: vi.fn(
        (
          _req: { texts: string[]; model?: string },
          cb: (err: Error | null, res: { embeddings: { values: number[] }[] } | null) => void,
        ) => {
          cb(null, { embeddings: [{ values: [0.1, 0.2, 0.3] }] });
        },
      ),
    };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    const vecs = await client.embed(["hello"]);
    expect(vecs).toEqual([[0.1, 0.2, 0.3]]);
    expect(stub.embedText).toHaveBeenCalledWith(
      { texts: ["hello"], model: undefined },
      expect.any(Function),
    );
  });

  it("returns empty array for empty input (no RPC)", async () => {
    const stub = { embedText: vi.fn() };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    expect(await client.embed([])).toEqual([]);
    expect(stub.embedText).not.toHaveBeenCalled();
  });

  it("propagates gRPC errors as a thrown Error", async () => {
    const stub = {
      embedText: vi.fn(
        (
          _req: unknown,
          cb: (err: Error | null, res: unknown) => void,
        ) => cb(new Error("UNAVAILABLE: ai-gateway is down"), null),
      ),
    };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    await expect(client.embed(["x"])).rejects.toThrow(/UNAVAILABLE/);
  });

  it("forwards the optional model parameter", async () => {
    const stub = {
      embedText: vi.fn(
        (
          _req: unknown,
          cb: (err: Error | null, res: { embeddings: { values: number[] }[] } | null) => void,
        ) => cb(null, { embeddings: [{ values: [1] }] }),
      ),
    };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    await client.embed(["x"], "custom-model");
    expect(stub.embedText).toHaveBeenCalledWith(
      { texts: ["x"], model: "custom-model" },
      expect.any(Function),
    );
  });

  it("tolerates a malformed gRPC response (missing values)", async () => {
    const stub = {
      embedText: vi.fn(
        (
          _req: unknown,
          cb: (err: Error | null, res: { embeddings: { values?: number[] }[] } | null) => void,
        ) => cb(null, { embeddings: [{}, { values: [0.5] }] }),
      ),
    };
    const client = new EmbeddingClient({ url: "fake", stubFactory: () => stub as never });
    const vecs = await client.embed(["a", "b"]);
    expect(vecs).toEqual([[], [0.5]]);
  });
});
