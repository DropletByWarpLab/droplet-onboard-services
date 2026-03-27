/**
 * Integration tests — run against live services via Docker Compose.
 *
 * These tests assume the API server and AI Gateway are running and reachable
 * at the URLs specified by environment variables.
 *
 * Run locally:
 *   docker compose -f tests/docker-compose.test.yml up --build --abort-on-container-exit
 *
 * Or outside Docker (if services are running on localhost):
 *   API_URL=http://localhost:3000 AI_GATEWAY_URL=http://localhost:8000 npx vitest run
 */

import { describe, it, expect } from "vitest";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL ?? "http://localhost:8000";

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json().catch(() => null), res };
}

describe("API Server Integration", () => {
  describe("Health", () => {
    it("GET /api/health returns status", async () => {
      const { status, body } = await fetchJson(`${API_URL}/api/health`);
      expect([200, 503]).toContain(status);
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("version", "0.1.0");
      expect(body).toHaveProperty("services");
      expect(body.services).toHaveProperty("db");
      expect(body.services).toHaveProperty("redis");
      expect(body.services).toHaveProperty("aiGateway");
    });

    it("health uptime is a non-negative number", async () => {
      const { body } = await fetchJson(`${API_URL}/api/health`);
      expect(typeof body.uptime).toBe("number");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Devices", () => {
    it("GET /api/devices returns an array", async () => {
      const { status, body } = await fetchJson(`${API_URL}/api/devices`);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe("LLM Models", () => {
    it("GET /api/llm/models returns model list", async () => {
      const { status, body } = await fetchJson(`${API_URL}/api/llm/models`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("models");
      expect(Array.isArray(body.models)).toBe(true);
    });
  });

  describe("LLM Chat validation", () => {
    it("rejects request without model", async () => {
      const { status } = await fetchJson(`${API_URL}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(status).toBe(400);
    });

    it("rejects request without messages", async () => {
      const { status } = await fetchJson(`${API_URL}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test" }),
      });
      expect(status).toBe(400);
    });
  });

  describe("Key management", () => {
    it("GET /api/llm/keys returns provider list", async () => {
      const { status, body } = await fetchJson(`${API_URL}/api/llm/keys`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("providers");
      expect(Array.isArray(body.providers)).toBe(true);
    });
  });
});

describe("AI Gateway Integration", () => {
  describe("Health", () => {
    it("GET /ai/health returns ok", async () => {
      const { status, body } = await fetchJson(`${AI_GATEWAY_URL}/ai/health`);
      expect(status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("jetson_reachable");
    });

    it("jetson_reachable is false in test environment", async () => {
      const { body } = await fetchJson(`${AI_GATEWAY_URL}/ai/health`);
      // Jetson is not real in test compose, so it should be false
      expect(body.jetson_reachable).toBe(false);
    });
  });

  describe("Keys CRUD", () => {
    it("store, list, and delete a key", async () => {
      // Store
      const storeRes = await fetchJson(`${AI_GATEWAY_URL}/ai/keys/anthropic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: "sk-ant-integration-test-key-1234" }),
      });
      expect(storeRes.status).toBe(200);

      // List
      const listRes = await fetchJson(`${AI_GATEWAY_URL}/ai/keys`);
      expect(listRes.body.providers).toContain("anthropic");

      // Delete
      const delRes = await fetchJson(`${AI_GATEWAY_URL}/ai/keys/anthropic`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);

      // Verify deleted
      const listRes2 = await fetchJson(`${AI_GATEWAY_URL}/ai/keys`);
      expect(listRes2.body.providers).not.toContain("anthropic");
    });
  });

  describe("Chat validation", () => {
    it("rejects empty body", async () => {
      const { status } = await fetchJson(`${AI_GATEWAY_URL}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(status).toBe(422);
    });
  });
});
