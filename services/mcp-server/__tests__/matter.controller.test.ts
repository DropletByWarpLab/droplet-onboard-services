/**
 * matter.controller — orchestrator HTTP proxy.
 *
 * The 6 methods on MatterController each map to one orchestrator route.
 * These tests stub HttpClient and verify:
 *   - correct path + method + body
 *   - 2xx body passes through unchanged
 *   - 202 (confirmation_required) passes through (NOT thrown)
 *   - 4xx/5xx surface as Error with the body's message
 *   - 404 from getDevice throws (per handler contract)
 */
import { describe, it, expect, vi } from "vitest";
import type { HttpClient } from "@droplet/tools-core";
import { createMatterController } from "../src/matter.controller.js";

/**
 * Build a stub HttpClient whose `get` / `post` / etc. return the
 * scripted Response objects. Each method records the calls so tests
 * can assert URL + body.
 */
function stubClient(responses: {
  get?: Response | Error;
  post?: Response | Error;
  patch?: Response | Error;
  delete?: Response | Error;
}): { client: HttpClient; calls: { method: string; path: string; body?: unknown; opts?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown; opts?: unknown }[] = [];
  const respond = (key: keyof typeof responses) => async (path: string, ...rest: unknown[]) => {
    const r = responses[key];
    const body = key === "post" || key === "patch" ? rest[0] : undefined;
    const opts = key === "post" || key === "patch" ? rest[1] : rest[0];
    calls.push({ method: key, path, body, opts });
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`unexpected ${key.toUpperCase()} to ${path} — no stub`);
    return r;
  };
  return {
    client: {
      get: respond("get") as HttpClient["get"],
      post: respond("post") as HttpClient["post"],
      patch: respond("patch") as HttpClient["patch"],
      delete: respond("delete") as HttpClient["delete"],
    },
    calls,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response("", { status });
}

// ---------------------------------------------------------------------------
// listDevices
// ---------------------------------------------------------------------------

describe("matter.controller.listDevices", () => {
  it("GETs /matter/devices and returns the grouped body verbatim", async () => {
    const body = {
      lights: [{ nodeId: "1", name: "Office lamp" }],
      switches: [],
      sensors: [],
      climate: [],
      media: [],
      covers: [],
      locks: [],
      other: [],
    };
    const { client, calls } = stubClient({ get: jsonResponse(200, body) });
    const ctrl = createMatterController(client);
    const result = await ctrl.listDevices();
    expect(result).toEqual(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("get");
    expect(calls[0].path).toBe("/api/matter/devices");
  });

  it("returns the disconnected stub when orchestrator says so", async () => {
    // matter.ts:78-88 returns a disconnected envelope when the
    // controller isn't running. Tool handlers should see it unchanged.
    const disconnected = {
      lights: [], switches: [], sensors: [], climate: [],
      media: [], covers: [], locks: [], other: [],
      _status: "disconnected",
    };
    const { client } = stubClient({ get: jsonResponse(200, disconnected) });
    const ctrl = createMatterController(client);
    const result = await ctrl.listDevices() as Record<string, unknown>;
    expect(result._status).toBe("disconnected");
  });

  it("throws with the orchestrator's error message on 5xx", async () => {
    const { client } = stubClient({
      get: jsonResponse(503, { error: "Matter controller not started" }),
    });
    const ctrl = createMatterController(client);
    await expect(ctrl.listDevices()).rejects.toThrow(/Matter controller not started/);
  });
});

// ---------------------------------------------------------------------------
// getDevice
// ---------------------------------------------------------------------------

describe("matter.controller.getDevice", () => {
  it("GETs /matter/devices/:nodeId and returns the device", async () => {
    const device = { nodeId: "12345", name: "Office lamp", category: "light" };
    const { client, calls } = stubClient({ get: jsonResponse(200, device) });
    const ctrl = createMatterController(client);
    const result = await ctrl.getDevice("12345");
    expect(result).toEqual(device);
    expect(calls[0].path).toBe("/api/matter/devices/12345");
  });

  it("throws on 404 (no such device)", async () => {
    const { client } = stubClient({
      get: jsonResponse(404, { error: "Device not found" }),
    });
    const ctrl = createMatterController(client);
    await expect(ctrl.getDevice("99999")).rejects.toThrow(/no device with node ID 99999/);
  });

  it("URL-encodes the nodeId to avoid injection via odd chars", async () => {
    const { client, calls } = stubClient({ get: jsonResponse(200, {}) });
    const ctrl = createMatterController(client);
    // Real Matter node IDs are decimal-only and the orchestrator
    // validates that, but the wrapper shouldn't trust the caller.
    await ctrl.getDevice("1/2/etc/passwd");
    expect(calls[0].path).toBe("/api/matter/devices/1%2F2%2Fetc%2Fpasswd");
  });
});

// ---------------------------------------------------------------------------
// sendCommand
// ---------------------------------------------------------------------------

describe("matter.controller.sendCommand", () => {
  it("POSTs command + data to the right URL", async () => {
    const { client, calls } = stubClient({
      post: jsonResponse(200, { ok: true, tier: 1 }),
    });
    const ctrl = createMatterController(client);
    const result = await ctrl.sendCommand("12345", "turn_on", { brightness: 75 });
    expect(result).toEqual({ ok: true, tier: 1 });
    expect(calls[0].method).toBe("post");
    expect(calls[0].path).toBe("/api/matter/devices/12345/command");
    expect(calls[0].body).toEqual({ command: "turn_on", data: { brightness: 75 } });
  });

  it("passes 202 confirmation_required through (does NOT throw)", async () => {
    // Tier 2 commands (locks, extreme thermostat) come back as 202
    // with a confirmationToken. The handler (control-device.ts:46-61)
    // pattern-matches on `status: "confirmation_required"` so we
    // MUST surface this body, not throw.
    const confirmBody = {
      status: "confirmation_required",
      nodeId: "12345",
      command: "unlock",
      tier: 2,
      reason: "Locks require user confirmation",
      confirmationToken: "abc-def-123",
      expiresIn: 60,
    };
    const { client } = stubClient({
      post: jsonResponse(202, confirmBody),
    });
    const ctrl = createMatterController(client);
    const result = await ctrl.sendCommand("12345", "unlock");
    expect(result).toEqual(confirmBody);
  });

  it("works with undefined data (omit-style commands like turn_off)", async () => {
    const { client, calls } = stubClient({
      post: jsonResponse(200, { ok: true }),
    });
    const ctrl = createMatterController(client);
    await ctrl.sendCommand("12345", "turn_off");
    expect(calls[0].body).toEqual({ command: "turn_off", data: undefined });
  });

  it("throws with orchestrator detail on 429 rate-limit", async () => {
    const { client } = stubClient({
      post: jsonResponse(429, { error: "Rate limit exceeded", tier: 1, blocked: true }),
    });
    const ctrl = createMatterController(client);
    await expect(ctrl.sendCommand("12345", "turn_on")).rejects.toThrow(/Rate limit exceeded/);
  });
});

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

describe("matter.controller.discover", () => {
  it("GETs /matter/discover and returns the device list + count", async () => {
    const body = {
      devices: [
        { discriminator: 3840, vendorId: 0xfff1, productId: 0x8000 },
      ],
      count: 1,
    };
    const { client, calls } = stubClient({ get: jsonResponse(200, body) });
    const ctrl = createMatterController(client);
    const result = await ctrl.discover();
    expect(result).toEqual(body);
    expect(calls[0].path).toBe("/api/matter/discover");
  });

  it("returns empty when no devices discovered (count: 0)", async () => {
    const { client } = stubClient({
      get: jsonResponse(200, { devices: [], count: 0 }),
    });
    const ctrl = createMatterController(client);
    const result = await ctrl.discover() as { count: number };
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// commission
// ---------------------------------------------------------------------------

describe("matter.controller.commission", () => {
  it("POSTs the pairing_code in the body", async () => {
    const { client, calls } = stubClient({
      post: jsonResponse(200, {
        status: "commissioned", nodeId: "67890", name: "New light",
      }),
    });
    const ctrl = createMatterController(client);
    // 11-digit short Matter pairing code
    await ctrl.commission("34970112332");
    expect(calls[0].path).toBe("/api/matter/commission");
    expect(calls[0].body).toEqual({ pairing_code: "34970112332" });
  });

  it("works with a QR-style pairing code payload", async () => {
    // QR codes encode a longer payload — the orchestrator's
    // QrPairingCodeCodec parses these. We just pass through.
    const qrCode = "MT:Y.K9042C00KA0648G00";
    const { client, calls } = stubClient({
      post: jsonResponse(200, { status: "commissioned", nodeId: "1" }),
    });
    const ctrl = createMatterController(client);
    await ctrl.commission(qrCode);
    expect(calls[0].body).toEqual({ pairing_code: qrCode });
  });

  it("surfaces commissioning errors with the orchestrator's message", async () => {
    const { client } = stubClient({
      post: jsonResponse(500, { error: "PASE failed: device not found" }),
    });
    const ctrl = createMatterController(client);
    await expect(ctrl.commission("11111111111")).rejects.toThrow(/PASE failed/);
  });
});

// ---------------------------------------------------------------------------
// getAuditLog
// ---------------------------------------------------------------------------

describe("matter.controller.getAuditLog", () => {
  it("GETs /matter/audit with the entityId + limit as query params", async () => {
    const body = {
      logs: [
        { id: 1, entityId: "light.12345", action: "turn_on", ts: "2026-05-15T10:00:00Z" },
      ],
    };
    const { client, calls } = stubClient({ get: jsonResponse(200, body) });
    const ctrl = createMatterController(client);
    const result = await ctrl.getAuditLog({ entityId: "light.12345", limit: 50 });
    expect(result).toEqual(body);
    expect(calls[0].path).toBe("/api/matter/audit");
    expect(calls[0].opts).toMatchObject({ params: { entityId: "light.12345", limit: 50 } });
  });

  it("omits undefined params (entityId optional)", async () => {
    const { client, calls } = stubClient({
      get: jsonResponse(200, { logs: [] }),
    });
    const ctrl = createMatterController(client);
    await ctrl.getAuditLog({ limit: 10 });
    // entityId not included; only limit
    expect(calls[0].opts).toMatchObject({ params: { limit: 10 } });
    expect((calls[0].opts as { params: Record<string, unknown> }).params.entityId).toBeUndefined();
  });

  it("works with zero-arg (no filter)", async () => {
    const { client, calls } = stubClient({
      get: jsonResponse(200, { logs: [] }),
    });
    const ctrl = createMatterController(client);
    await ctrl.getAuditLog({});
    expect(calls[0].opts).toEqual({ params: {} });
  });
});

// ---------------------------------------------------------------------------
// edge cases for readJsonOrThrow
// ---------------------------------------------------------------------------

describe("matter.controller HTTP edge cases", () => {
  it("handles empty 200 body as {}", async () => {
    // Some endpoints (theoretical 204 No Content) — we coerce empty body.
    const { client } = stubClient({ get: emptyResponse(200) });
    const ctrl = createMatterController(client);
    const result = await ctrl.listDevices();
    expect(result).toEqual({});
  });

  it("throws when 2xx body is not valid JSON", async () => {
    const garbage = new Response("not json at all", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const { client } = stubClient({ get: garbage });
    const ctrl = createMatterController(client);
    await expect(ctrl.listDevices()).rejects.toThrow(/non-JSON 2xx body/);
  });

  it("falls back to plain text when 4xx body is not JSON", async () => {
    const html = new Response("<html>500 Internal Server Error</html>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
    const { client } = stubClient({ get: html });
    const ctrl = createMatterController(client);
    // Don't crash on non-JSON error bodies — surface the truncated text.
    await expect(ctrl.listDevices()).rejects.toThrow(/HTTP 500/);
  });
});
