/**
 * WARP-1443 — `set_wifi_password` (Tier 2: write + handler-enforced
 * two-step confirmation).
 *
 * The cardinal rule: the password value must NEVER appear in any
 * serialized ToolResult — not in the confirmation echo, not in success
 * data, not in error messages. Every branch here asserts that.
 *
 * Wire: POST /api/network/wifi/password with body { password } (the
 * route defaults iface_section to "default_radio0"). 400 → the server's
 * message as INVALID_PASSWORD; other non-OK → WIFI_PASSWORD_FAILED;
 * 202 (network-safety Tier-2 arm) → confirmation passthrough.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setWifiPassword from "../../../src/handlers/network/set-wifi-password.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

/** Distinctive value so a leak anywhere in the result is unmistakable. */
const SECRET = "correct-horse-battery-42!";

describe("set_wifi_password — tool metadata", () => {
  it("is named set_wifi_password and is Tier-2 (write + confirm)", () => {
    expect(setWifiPassword.name).toBe("set_wifi_password");
    expect(setWifiPassword.requiresWrite).toBe(true);
    expect(setWifiPassword.requiresConfirmation).toBe(true);
  });

  it("has an additionalProperties:false schema requiring only password", () => {
    const schema = setWifiPassword.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["password"]);
  });
});

describe("set_wifi_password — WPA2-PSK validation (no HTTP)", () => {
  it("rejects a password shorter than 8 characters", async () => {
    const post = vi.fn();
    const r = await setWifiPassword.handler({ password: "short7!" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_PASSWORD");
      expect(r.error.message).toContain("8");
      expect(r.error.message).toContain("63");
    }
    expect(JSON.stringify(r)).not.toContain("short7!");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a password longer than 63 characters", async () => {
    const post = vi.fn();
    const tooLong = "x".repeat(64);
    const r = await setWifiPassword.handler({ password: tooLong }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PASSWORD");
    expect(JSON.stringify(r)).not.toContain(tooLong);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects non-ASCII characters (WPA2-PSK is printable ASCII only)", async () => {
    const post = vi.fn();
    const r = await setWifiPassword.handler({ password: "pässword123!" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_PASSWORD");
      expect(r.error.message.toLowerCase()).toContain("ascii");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects control characters (tab is not printable ASCII)", async () => {
    const post = vi.fn();
    const r = await setWifiPassword.handler({ password: "abc\tdefgh" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PASSWORD");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a missing / non-string password", async () => {
    const post = vi.fn();
    const r = await setWifiPassword.handler({}, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PASSWORD");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("set_wifi_password — handler-enforced confirmation", () => {
  it("first call returns confirmation_required with NO HTTP and NO password anywhere", async () => {
    const post = vi.fn();
    const r = await setWifiPassword.handler({ password: SECRET }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      // The echo must say what happens (every device reconnects) …
      expect(r.error.message.toLowerCase()).toContain("password");
      expect(r.error.message.toLowerCase()).toContain("reconnect");
      expect(r.error.message.toLowerCase()).toContain("every");
    }
    // … without EVER carrying the value itself.
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("set_wifi_password — confirmed execution", () => {
  it("POSTs { password } to the wifi password route and reports changed:true without echoing it", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", tier: 2, operationId: "op-1" }), {
        status: 200,
      }),
    );
    const r = await setWifiPassword.handler(
      { password: SECRET, confirmed: true },
      ctxWithPost(post),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/network/wifi/password", { password: SECRET });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ type: "set_wifi_password", changed: true });
    }
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("passes an orchestrator 202 (network-safety arm) through as confirmation_required", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "confirmation_required", reason: "Tier 2 change" }),
        { status: 202 },
      ),
    );
    const r = await setWifiPassword.handler(
      { password: SECRET, confirmed: true },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("set_wifi_password — error mapping", () => {
  it("maps a 400 to INVALID_PASSWORD with the server's message", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Missing 'password' in request body" }), {
        status: 400,
      }),
    );
    const r = await setWifiPassword.handler(
      { password: SECRET, confirmed: true },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_PASSWORD");
      expect(r.error.message).toContain("Missing 'password'");
    }
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("maps a 500 to WIFI_PASSWORD_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const r = await setWifiPassword.handler(
      { password: SECRET, confirmed: true },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("WIFI_PASSWORD_FAILED");
      expect(r.error.message).toContain("500");
    }
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("maps a 429 rate-tier block to WIFI_PASSWORD_FAILED carrying the reason", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "cooldown active", tier: 3, blocked: true }), {
        status: 429,
      }),
    );
    const r = await setWifiPassword.handler(
      { password: SECRET, confirmed: true },
      ctxWithPost(post),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("WIFI_PASSWORD_FAILED");
      expect(r.error.message).toContain("cooldown active");
    }
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
