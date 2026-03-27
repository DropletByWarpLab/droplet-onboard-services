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
} from "@/lib/api";

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
      expect(mockFetch).toHaveBeenCalledWith("/api/health");
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
});
