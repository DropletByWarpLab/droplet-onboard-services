import { describe, it, expect } from "vitest";
import {
  confirmationRequired,
  isConfirmationResponse,
  passThroughConfirmation,
  redactConfirmationSecrets,
} from "../src/confirmation.js";

describe("confirmation", () => {
  it("confirmationRequired wraps a reason and produces ToolResult", () => {
    const r = confirmationRequired("blocking a device requires user confirmation");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(r.error.message).toContain("user confirmation");
    }
  });

  it("isConfirmationResponse detects a 202 from the orchestrator", () => {
    const fake = new Response(JSON.stringify({ reason: "needs confirm" }), {
      status: 202,
    });
    expect(isConfirmationResponse(fake)).toBe(true);
    const ok = new Response("{}", { status: 200 });
    expect(isConfirmationResponse(ok)).toBe(false);
  });

  /**
   * `details` is serialised into the MODEL's context, and the orchestrator's
   * 202 carries a live single-use `confirmationToken` for a Tier-2 action
   * (routes/cameras.ts, routes/network-firewall.routes.ts). Handing the agent
   * the approval for the write it just asked to make is the shape WARP-2472's
   * comment says the design refuses ("an agent re-presenting the token it was
   * just handed is the agent approving its own write").
   */
  describe("passThroughConfirmation redacts route secrets from details", () => {
    const body = {
      status: "confirmation_required",
      confirmationToken: "e7c9f1a2b3d4e5f60718293a4b5c6d7e",
      reason: "Running this will change 3 devices.",
      sceneId: "scene-1",
      name: "Evening",
      actionCount: 3,
    };

    it("strips the token but keeps everything that explains the action", async () => {
      const r = await passThroughConfirmation(
        new Response(JSON.stringify(body), { status: 202 }),
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const details = r.error.details as Record<string, unknown>;

      expect(details).not.toHaveProperty("confirmationToken");
      expect(JSON.stringify(details)).not.toContain("e7c9f1a2b3d4e5f60718293a4b5c6d7e");

      // The explanation must survive — a redaction that blanks the body would
      // leave the chip with nothing to render.
      expect(details.sceneId).toBe("scene-1");
      expect(details.name).toBe("Evening");
      expect(details.actionCount).toBe(3);
      // `reason` is prose, not a secret, and is still the user-facing message.
      expect(r.error.message).toContain("change 3 devices");
    });

    it("matches secret-ish keys by name, so a renamed token is still caught", () => {
      const out = redactConfirmationSecrets({
        confirm_token: "a",
        CHALLENGEID: "b",
        nonce: "c",
        clientSecret: "d",
        sceneId: "keep",
      }) as Record<string, unknown>;
      expect(Object.keys(out)).toEqual(["sceneId"]);
    });

    it("passes through non-objects untouched", () => {
      expect(redactConfirmationSecrets(null)).toBeNull();
      expect(redactConfirmationSecrets("x")).toBe("x");
      expect(redactConfirmationSecrets([1, 2])).toEqual([1, 2]);
    });
  });
});
