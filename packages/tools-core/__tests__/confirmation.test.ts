/**
 * Tier-2 confirmation (WARP-640, WARP-2002).
 *
 * The WARP-2002 half of this suite pins the property that makes a minted token
 * a control rather than a decoration: it is bound to one tool AND one resolved
 * target, it expires, and it can be spent exactly once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  MAX_PENDING_CONFIRMATIONS,
  __resetToolConfirmations,
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
  isConfirmationResponse,
  mintToolConfirmation,
} from "../src/confirmation.js";

beforeEach(() => {
  __resetToolConfirmations();
});

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

/* -------------------------------------------------------------------------- */
/* WARP-2002 — the token store                                                */
/* -------------------------------------------------------------------------- */

const FP_A = confirmationFingerprint(["remove_device", "node-a"]);
const FP_B = confirmationFingerprint(["remove_device", "node-b"]);

describe("mint / consume", () => {
  it("accepts the token it minted for the same tool and target", () => {
    const minted = mintToolConfirmation("remove_device", FP_A);
    expect(minted).not.toBeNull();
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_A)).toBe(
      true,
    );
  });

  it("refuses a token minted for a DIFFERENT target of the same tool", () => {
    // The whole point of the fingerprint: approving the removal of device A
    // must not authorise removing device B.
    const minted = mintToolConfirmation("remove_device", FP_A);
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_B)).toBe(
      false,
    );
  });

  it("refuses a token minted for a different TOOL", () => {
    const minted = mintToolConfirmation("remove_device", FP_A);
    expect(consumeToolConfirmation(minted!.confirmationToken, "delete_clip", FP_A)).toBe(
      false,
    );
  });

  it("is single-use — a replay is refused", () => {
    const minted = mintToolConfirmation("remove_device", FP_A);
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_A)).toBe(
      true,
    );
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_A)).toBe(
      false,
    );
  });

  it("burns the token even when validation fails, so it cannot be probed", () => {
    const minted = mintToolConfirmation("remove_device", FP_A);
    // Wrong target first — spends it.
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_B)).toBe(
      false,
    );
    // Now the correct call must also fail; the token is gone.
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_A)).toBe(
      false,
    );
  });

  it("refuses a fabricated token", () => {
    expect(consumeToolConfirmation("f".repeat(64), "remove_device", FP_A)).toBe(false);
  });

  it("refuses non-string tokens without throwing", () => {
    for (const bogus of [undefined, null, 42, true, {}, []]) {
      expect(consumeToolConfirmation(bogus, "remove_device", FP_A)).toBe(false);
    }
  });

  it("refuses an empty string", () => {
    expect(consumeToolConfirmation("", "remove_device", FP_A)).toBe(false);
  });
});

describe("expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a token past its TTL", () => {
    vi.useFakeTimers();
    const minted = mintToolConfirmation("remove_device", FP_A);
    vi.advanceTimersByTime(CONFIRMATION_TTL_MS + 1);
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_A)).toBe(
      false,
    );
  });

  it("still accepts a token just inside its TTL", () => {
    vi.useFakeTimers();
    const minted = mintToolConfirmation("remove_device", FP_A);
    vi.advanceTimersByTime(CONFIRMATION_TTL_MS - 1_000);
    expect(consumeToolConfirmation(minted!.confirmationToken, "remove_device", FP_A)).toBe(
      true,
    );
  });
});

describe("pending cap", () => {
  it("refuses to mint past the cap rather than growing without bound", () => {
    for (let i = 0; i < MAX_PENDING_CONFIRMATIONS; i++) {
      expect(mintToolConfirmation("remove_device", `fp-${i}`)).not.toBeNull();
    }
    expect(mintToolConfirmation("remove_device", "one-too-many")).toBeNull();
  });

  it("surfaces the cap as an error, never as a tokenless confirmation prompt", () => {
    for (let i = 0; i < MAX_PENDING_CONFIRMATIONS; i++) {
      mintToolConfirmation("remove_device", `fp-${i}`);
    }
    const r = confirmationRequired("remove it?", { type: "remove_device" }, {
      toolName: "remove_device",
      fingerprint: FP_A,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // A confirmation_required with no token strands the user on a chip that
      // can never be approved. It must be an error instead.
      expect(r.status).toBe("error");
      expect(r.error.code).toBe("TOO_MANY_PENDING_CONFIRMATIONS");
    }
  });
});

describe("confirmationRequired with mint", () => {
  it("embeds a usable token in details and preserves the caller's fields", () => {
    const r = confirmationRequired(
      "remove kitchen strip?",
      { type: "remove_device", nodeId: "node-a" },
      { toolName: "remove_device", fingerprint: FP_A },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const details = r.error.details as Record<string, unknown>;
    expect(details.type).toBe("remove_device");
    expect(details.nodeId).toBe("node-a");
    expect(typeof details.confirmationToken).toBe("string");
    expect(typeof details.confirmationExpiresAt).toBe("string");
    // The token is real — the dashboard chip round-trips it back.
    expect(
      consumeToolConfirmation(details.confirmationToken, "remove_device", FP_A),
    ).toBe(true);
  });

  it("mints no token when no mint is requested", () => {
    const r = confirmationRequired("no token here", { type: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const details = r.error.details as Record<string, unknown>;
    expect(details.confirmationToken).toBeUndefined();
  });
});

describe("confirmationFingerprint", () => {
  it("is stable for the same target and different for different targets", () => {
    expect(confirmationFingerprint(["t", "a"])).toBe(confirmationFingerprint(["t", "a"]));
    expect(confirmationFingerprint(["t", "a"])).not.toBe(
      confirmationFingerprint(["t", "b"]),
    );
  });

  it("does not contain the raw target — it is a hash", () => {
    // Load-bearing for commission_device, whose target is a pairing CODE.
    const fp = confirmationFingerprint(["commission_device", "MT:Y.K90SO527JA0648G00"]);
    expect(fp).not.toContain("MT:");
    expect(fp).not.toContain("Y.K90SO527JA0648G00");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
