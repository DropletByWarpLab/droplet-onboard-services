import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import {
  fetchHealth,
  fetchDevices,
  fetchModels,
  saveProviderKey,
  listProviderKeys,
  deleteProviderKey,
  fetchNetworkOperation,
  uploadFiles,
} from "@/lib/api";
import { MAX_FILES_PER_UPLOAD } from "@droplet/shared-types";

describe("API client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("fetchHealth", () => {
    it("calls /api/health and returns data", async () => {
      const mockData = { status: "ok", uptime: 100, version: "0.1.0", services: {} };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

      const result = await fetchHealth();
      // fetchHealth goes through authFetch, which always attaches
      // `credentials: "same-origin"` so the droplet_session cookie rides along.
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/health",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(result.status).toBe("ok");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(fetchHealth()).rejects.toThrow("Health check failed: 500");
    });
  });

  describe("fetchDevices", () => {
    it("calls /api/devices", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ deviceId: "dev-001" }]),
      });

      const result = await fetchDevices();
      expect(result).toHaveLength(1);
      expect(result[0].deviceId).toBe("dev-001");
    });
  });

  describe("fetchModels", () => {
    it("calls /api/llm/models", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ id: "llama3:8b" }] }),
      });

      const result = await fetchModels();
      expect(result.models).toHaveLength(1);
    });
  });

  describe("saveProviderKey", () => {
    it("posts key to correct endpoint", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      await saveProviderKey("anthropic", "sk-test");

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/llm/keys/anthropic",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ api_key: "sk-test" }),
        })
      );
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve("Bad key"),
      });
      await expect(saveProviderKey("anthropic", "bad")).rejects.toThrow("Failed to save key");
    });
  });

  describe("listProviderKeys", () => {
    it("returns provider list", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ providers: ["anthropic"] }),
      });

      const result = await listProviderKeys();
      expect(result).toEqual(["anthropic"]);
    });
  });

  describe("deleteProviderKey", () => {
    it("sends DELETE request", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      await deleteProviderKey("openai");

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/llm/keys/openai",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  describe("fetchNetworkOperation", () => {
    it("passes a 200 operation record through unchanged", async () => {
      const op = {
        id: "op-1",
        state: "applied",
        startedAt: 1,
        finishedAt: 2,
        reason: null,
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(op),
      });

      const result = await fetchNetworkOperation("op-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/network/operations/op-1",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(result).toEqual(op);
    });

    it("DASH-07: maps a 404 to a distinct 'unknown' state, never 'applied'", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const result = await fetchNetworkOperation("op-gone");
      // The bug was reporting a 404 as success ("applied"). A 404 is
      // indeterminate — assert we never claim the change applied.
      expect(result.state).toBe("unknown");
      expect(result.state).not.toBe("applied");
      // Reason is a re-check prompt, not a success message.
      expect(result.reason).toMatch(/couldn't confirm/i);
    });

    it("throws on a non-404 error response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(fetchNetworkOperation("op-err")).rejects.toThrow(
        "Failed to fetch operation: 500",
      );
    });
  });

  // WARP-1666 — a 36-file selection used to go out as ONE request at a server
  // that accepts MAX_FILES_PER_UPLOAD, which rejected the whole thing (and
  // blamed the field name). Batching is what makes a folder-sized selection
  // work at all, so these tests pin the batch boundary and the partial-failure
  // contract the Files page relies on.
  describe("uploadFiles", () => {
    const makeFiles = (n: number) =>
      Array.from({ length: n }, (_, i) => new File([`x${i}`], `f${i}.txt`));

    const okResponse = () => ({ ok: true, text: () => Promise.resolve("") });

    it("splits a selection larger than the server cap into sequential batches", async () => {
      mockFetch.mockResolvedValue(okResponse());

      await uploadFiles("/Personal", makeFiles(36));

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const perRequest = mockFetch.mock.calls.map(
        ([, init]) => (init.body as FormData).getAll("files").length,
      );
      expect(perRequest).toEqual([
        MAX_FILES_PER_UPLOAD,
        36 - MAX_FILES_PER_UPLOAD,
      ]);
    });

    it("sends exactly one request when the selection fits in a single batch", async () => {
      mockFetch.mockResolvedValue(okResponse());

      await uploadFiles("/Personal", makeFiles(MAX_FILES_PER_UPLOAD));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("reports how many files landed when a later batch fails", async () => {
      mockFetch.mockResolvedValueOnce(okResponse()).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      });

      // The first batch is NOT rolled back — it stays on the box, and the
      // caller is told exactly how much made it so it can say so.
      await expect(
        uploadFiles("/Personal", makeFiles(36)),
      ).rejects.toMatchObject({
        name: "UploadBatchError",
        uploaded: MAX_FILES_PER_UPLOAD,
        total: 36,
      });
    });

    it("reports zero uploaded when the very first batch fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      });

      await expect(
        uploadFiles("/Personal", makeFiles(36)),
      ).rejects.toMatchObject({ uploaded: 0, total: 36 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
