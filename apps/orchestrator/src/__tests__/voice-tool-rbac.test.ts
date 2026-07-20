/**
 * WARP-1398 — the voice principal's scoped smart-home write surface.
 *
 * ADR-004 §3 makes service principals read-only by default; `_service:voice`
 * is the one documented exception — it keeps its read tools AND the
 * `control_device` write tool so voice can operate lights/plugs/etc. Every
 * other service principal, and the coarse `service` role, stays read-only.
 * Locks are NOT granted at the tool level; a control_device lock command is
 * Tier-2 (confirmation_required) which the voice flow can't complete.
 */
import { describe, it, expect } from "vitest";
import {
  narrowAllowedToolsForRole,
  replayedWriteToolAttempt,
  isVoicePrincipal,
  VOICE_WRITE_TOOLS,
} from "../routes/llm.js";

describe("isVoicePrincipal", () => {
  it("matches only the exact _service:voice principal, not the coarse service role", () => {
    expect(isVoicePrincipal({ id: "_service:voice", role: "service" })).toBe(true);
    expect(isVoicePrincipal({ id: "_service:mcp", role: "service" })).toBe(false);
    expect(isVoicePrincipal({ id: "_service:email", role: "service" })).toBe(false);
    expect(isVoicePrincipal({ id: "u1", role: "owner" })).toBe(false);
    expect(isVoicePrincipal(undefined)).toBe(false);
  });
});

describe("narrowAllowedToolsForRole (voice write scope)", () => {
  // The requestedAllowed path is pure (no MCP round-trip): the caller supplies
  // a candidate list and the narrowing filters it.
  const requested = [
    "list_smart_home_devices", // read
    "control_device", // smart-home write — voice-allowed
    "run_scene", // write — NOT voice-allowed (scenes may contain locks)
    "block_network_device", // write — never voice-allowed
  ];

  it("keeps control_device for the voice principal, strips other writes", async () => {
    const out = await narrowAllowedToolsForRole("service", requested, true);
    expect(out).toContain("list_smart_home_devices");
    expect(out).toContain("control_device");
    expect(out).not.toContain("run_scene");
    expect(out).not.toContain("block_network_device");
  });

  it("strips ALL write tools for a non-voice service principal (ADR-004 default)", async () => {
    const out = await narrowAllowedToolsForRole("service", requested, false);
    expect(out).toContain("list_smart_home_devices");
    expect(out).not.toContain("control_device");
    expect(out).not.toContain("run_scene");
    expect(out).not.toContain("block_network_device");
  });

  it("leaves the full requested set for owner/admin", async () => {
    expect(await narrowAllowedToolsForRole("owner", requested)).toEqual(requested);
    expect(await narrowAllowedToolsForRole("admin", requested)).toEqual(requested);
  });

  it("VOICE_WRITE_TOOLS is exactly control_device (no run_scene, no locks-by-scene)", () => {
    expect([...VOICE_WRITE_TOOLS]).toEqual(["control_device"]);
  });
});

describe("replayedWriteToolAttempt (spoof guard, voice exemption)", () => {
  const replay = (name: string) => [
    { role: "assistant", tool_calls: [{ function: { name } }] },
  ];

  it("flags a replayed write tool for a non-voice caller", () => {
    expect(replayedWriteToolAttempt(replay("control_device"))).toBe(true);
    expect(replayedWriteToolAttempt(replay("block_network_device"))).toBe(true);
  });

  it("exempts the voice principal's allowed write tool but not others", () => {
    expect(replayedWriteToolAttempt(replay("control_device"), VOICE_WRITE_TOOLS)).toBe(false);
    expect(replayedWriteToolAttempt(replay("run_scene"), VOICE_WRITE_TOOLS)).toBe(true);
    expect(replayedWriteToolAttempt(replay("block_network_device"), VOICE_WRITE_TOOLS)).toBe(true);
  });

  it("ignores read-tool replays and non-array input", () => {
    expect(replayedWriteToolAttempt(replay("list_smart_home_devices"))).toBe(false);
    expect(replayedWriteToolAttempt(undefined)).toBe(false);
  });
});
