import { describe, it, expect } from "vitest";
import { confirmationRequired, isConfirmationResponse } from "../src/confirmation.js";

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
});
