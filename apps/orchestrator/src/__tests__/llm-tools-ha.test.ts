import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock the HA client surface the new tools call through. These need to be
// hoisted before the SUT import.
const fetchAllStates = vi.fn();
const callService = vi.fn();
vi.mock("../services/home-assistant.client.js", () => ({
  fetchAllStates: (...a: unknown[]) => fetchAllStates(...a),
  callService: (...a: unknown[]) => callService(...a),
  fetchEntityState: vi.fn(),
  fetchDiscoveryFlows: vi.fn(),
  acceptDiscoveryFlow: vi.fn(),
  healthCheck: vi.fn(),
  onStateChanged: vi.fn(),
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
}));

// Other modules llm-tools imports — stub so the SUT loads in isolation.
vi.mock("../services/openwrt.client.js", () => ({}));
vi.mock("../services/nextcloud.client.js", () => ({}));
vi.mock("../services/frigate.client.js", () => ({}));
vi.mock("../services/health-monitor.service.js", () => ({}));
vi.mock("../config.js", () => ({
  config: { CAMERA_DISCOVERY_URL: "http://camera-discovery:8000" },
}));

import { dispatchTool } from "../services/llm-tools.js";

const ctx = { prisma: {} as unknown as PrismaClient, userId: "alice" };

beforeEach(() => {
  vi.clearAllMocks();
  callService.mockResolvedValue(undefined);
});

describe("list_scenes", () => {
  it("returns only entities with scene. prefix, with friendly names", async () => {
    fetchAllStates.mockResolvedValueOnce([
      { entity_id: "scene.movie_night", state: "scening", attributes: { friendly_name: "Movie Night" }, last_changed: "2026-04-23T14:00:00Z" },
      { entity_id: "scene.bedtime", state: "scening", attributes: {}, last_changed: "2026-04-22T22:00:00Z" },
      { entity_id: "light.kitchen", state: "on", attributes: {}, last_changed: "2026-04-23T13:00:00Z" },
      { entity_id: "automation.morning", state: "on", attributes: {}, last_changed: "2026-04-23T07:00:00Z" },
    ]);
    const res = (await dispatchTool("list_scenes", {}, ctx)) as {
      count: number;
      scenes: Array<{ entity_id: string; name: string }>;
    };
    expect(res.count).toBe(2);
    expect(res.scenes.map((s) => s.entity_id).sort()).toEqual(["scene.bedtime", "scene.movie_night"]);
    // Friendly name from attributes when present, derived from entity_id otherwise
    expect(res.scenes.find((s) => s.entity_id === "scene.movie_night")!.name).toBe("Movie Night");
    expect(res.scenes.find((s) => s.entity_id === "scene.bedtime")!.name).toBe("bedtime");
  });
});

describe("run_scene", () => {
  it("calls scene.turn_on with the validated entity_id", async () => {
    const res = (await dispatchTool(
      "run_scene",
      { entity_id: "scene.movie_night" },
      ctx,
    )) as { activated?: boolean };
    expect(res.activated).toBe(true);
    expect(callService).toHaveBeenCalledWith("scene", "turn_on", "scene.movie_night");
  });

  for (const bad of [
    "light.kitchen",       // wrong domain
    "automation.morning",  // wrong domain
    "scene.UPPER",         // uppercase rejected
    "scene.movie night",   // space rejected
    "scene.movie;rm -rf /",// shell-meta rejected
    "scene.",              // missing object_id
    "../../scene.x",       // traversal rejected (no dot.dot)
    "",
  ]) {
    it(`rejects entity_id ${JSON.stringify(bad)}`, async () => {
      const res = (await dispatchTool("run_scene", { entity_id: bad }, ctx)) as { error?: string };
      expect(res.error).toMatch(/invalid scene entity_id/);
      expect(callService).not.toHaveBeenCalled();
    });
  }

  it("surfaces HA errors as a tool error (not a throw)", async () => {
    callService.mockRejectedValueOnce(new Error("HA 500"));
    const res = (await dispatchTool(
      "run_scene",
      { entity_id: "scene.movie_night" },
      ctx,
    )) as { error?: string };
    expect(res.error).toBe("HA 500");
  });
});

describe("list_automations", () => {
  it("returns automations with state + last_triggered", async () => {
    fetchAllStates.mockResolvedValueOnce([
      {
        entity_id: "automation.morning_routine",
        state: "on",
        attributes: { friendly_name: "Morning Routine", last_triggered: "2026-04-23T07:00:00Z" },
      },
      {
        entity_id: "automation.disabled_one",
        state: "off",
        attributes: { last_triggered: null },
      },
      { entity_id: "scene.movie_night", state: "scening", attributes: {} },
    ]);
    const res = (await dispatchTool("list_automations", {}, ctx)) as {
      count: number;
      automations: Array<{ entity_id: string; state: string; last_triggered: string | null }>;
    };
    expect(res.count).toBe(2);
    const morning = res.automations.find((a) => a.entity_id === "automation.morning_routine")!;
    expect(morning.state).toBe("on");
    expect(morning.last_triggered).toBe("2026-04-23T07:00:00Z");
    const disabled = res.automations.find((a) => a.entity_id === "automation.disabled_one")!;
    expect(disabled.state).toBe("off");
    expect(disabled.last_triggered).toBeNull();
  });
});

describe("trigger_automation", () => {
  it("calls automation.trigger with the validated entity_id", async () => {
    const res = (await dispatchTool(
      "trigger_automation",
      { entity_id: "automation.morning_routine" },
      ctx,
    )) as { triggered?: boolean };
    expect(res.triggered).toBe(true);
    expect(callService).toHaveBeenCalledWith("automation", "trigger", "automation.morning_routine");
  });

  for (const bad of [
    "scene.movie_night",       // wrong domain
    "automation.UPPER",
    "automation.with space",
    "automation.morning'; DROP TABLE x; --",
    "automation",
    "",
  ]) {
    it(`rejects entity_id ${JSON.stringify(bad)}`, async () => {
      const res = (await dispatchTool(
        "trigger_automation",
        { entity_id: bad },
        ctx,
      )) as { error?: string };
      expect(res.error).toMatch(/invalid automation entity_id/);
      expect(callService).not.toHaveBeenCalled();
    });
  }
});
