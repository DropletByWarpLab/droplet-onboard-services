/**
 * WARP-2469 — the chat approval store: the orchestrator-side custodian
 * of an interceptor challenge between "the model was refused" and "the
 * user said yes".
 *
 * WHY IT IS NOT JUST THE TOKEN. WARP-2305 mints a 256-bit secret bound
 * to tool + arguments. If that secret went straight to the browser and
 * back, the round-trip would be authenticated by nothing: whoever held
 * the SSE stream would hold the approval. The store keeps the secret on
 * the orchestrator and hands the browser an opaque, non-authorising
 * `challengeId`; only a `requireRole`-gated approval turns the challenge
 * into a claimable grant.
 */
import { describe, it, expect } from "vitest";
import { createChatApprovalStore } from "../services/chat-approval.service.js";

const T0 = 1_700_000_000_000;

function makeStore() {
  return createChatApprovalStore();
}

function register(
  store: ReturnType<typeof createChatApprovalStore>,
  over: Partial<Parameters<ReturnType<typeof createChatApprovalStore>["register"]>[0]> = {},
) {
  return store.register({
    tool: "delete_file",
    args: { path: "/a" },
    token: "tok-a",
    expiresAt: T0 + 60_000,
    userId: "romain",
    ...over,
  });
}

describe("createChatApprovalStore — registration", () => {
  it("returns a challenge id that is NOT the token, and never exposes the token", () => {
    const store = makeStore();
    const challenge = register(store);
    expect(challenge.challengeId).not.toBe("tok-a");
    expect(challenge.challengeId.length).toBeGreaterThan(16);
    // The public view is what reaches the browser. It must not carry the
    // secret in ANY field.
    expect(JSON.stringify(challenge)).not.toContain("tok-a");
  });

  it("starts in the explicit `pending` state — never an absence", () => {
    const store = makeStore();
    expect(register(store).status).toBe("pending");
  });

  it("carries a PHI-free summary of the arguments", () => {
    const store = makeStore();
    const challenge = register(store, {
      tool: "email_send",
      args: { to: "camille.moreau@example-clinic.test" },
    });
    expect(JSON.stringify(challenge)).not.toContain("camille.moreau");
    expect(challenge.summary.fields.map((f) => f.key)).toEqual(["to"]);
  });
});

describe("createChatApprovalStore — approve", () => {
  it("returns the bound token exactly once", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    const first = store.approve(challengeId, "romain", T0);
    expect(first).toEqual(
      expect.objectContaining({ ok: true, token: "tok-a", tool: "delete_file" }),
    );
    const second = store.approve(challengeId, "romain", T0);
    expect(second).toEqual({ ok: false, reason: "already_resolved" });
  });

  it("refuses an approval from a different user than the challenged turn", () => {
    const store = makeStore();
    const { challengeId } = register(store, { userId: "romain" });
    expect(store.approve(challengeId, "stefan", T0)).toEqual({
      ok: false,
      reason: "not_owner",
    });
    // …and the challenge is still pending, not burned by the attempt.
    expect(store.get(challengeId, T0)?.status).toBe("pending");
  });

  it("refuses an unknown challenge id", () => {
    const store = makeStore();
    expect(store.approve("nope", "romain", T0)).toEqual({
      ok: false,
      reason: "unknown_challenge",
    });
  });
});

describe("createChatApprovalStore — deny invalidates", () => {
  it("moves the challenge to `denied` and makes the token unreachable forever", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    expect(store.deny(challengeId, "romain", T0)).toEqual({
      ok: true,
      tool: "delete_file",
    });
    expect(store.get(challengeId, T0)?.status).toBe("denied");
    // Mutation: leave the challenge live on deny → this approve succeeds
    // and the grant below becomes claimable → red.
    expect(store.approve(challengeId, "romain", T0)).toEqual({
      ok: false,
      reason: "already_resolved",
    });
    expect(
      store.claimGrant({ tool: "delete_file", args: { path: "/a" }, userId: "romain" }, T0),
    ).toBeNull();
  });

  it("cannot deny an already-approved challenge", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    store.approve(challengeId, "romain", T0);
    expect(store.deny(challengeId, "romain", T0)).toEqual({
      ok: false,
      reason: "already_resolved",
    });
  });
});

describe("createChatApprovalStore — claimGrant is bound to tool + arguments", () => {
  it("hands back the token for the SAME tool and SAME arguments", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    store.approve(challengeId, "romain", T0);
    expect(
      store.claimGrant({ tool: "delete_file", args: { path: "/a" }, userId: "romain" }, T0),
    ).toBe("tok-a");
  });

  it("refuses different arguments — the WARP-2305 binding, through the chat path", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    store.approve(challengeId, "romain", T0);
    expect(
      store.claimGrant({ tool: "delete_file", args: { path: "/b" }, userId: "romain" }, T0),
    ).toBeNull();
  });

  it("refuses a different tool with the same arguments", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    store.approve(challengeId, "romain", T0);
    expect(
      store.claimGrant({ tool: "read_file", args: { path: "/a" }, userId: "romain" }, T0),
    ).toBeNull();
  });

  it("refuses another user's grant", () => {
    const store = makeStore();
    const { challengeId } = register(store, { userId: "romain" });
    store.approve(challengeId, "romain", T0);
    expect(
      store.claimGrant({ tool: "delete_file", args: { path: "/a" }, userId: "stefan" }, T0),
    ).toBeNull();
  });

  it("is single-use — a second claim of the same grant returns null", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    store.approve(challengeId, "romain", T0);
    const call = { tool: "delete_file", args: { path: "/a" }, userId: "romain" };
    expect(store.claimGrant(call, T0)).toBe("tok-a");
    expect(store.claimGrant(call, T0)).toBeNull();
    expect(store.get(challengeId, T0)?.status).toBe("spent");
  });

  it("ignores the `confirmed` control flag when matching, exactly as the interceptor does", () => {
    const store = makeStore();
    const { challengeId } = register(store);
    store.approve(challengeId, "romain", T0);
    expect(
      store.claimGrant(
        { tool: "delete_file", args: { path: "/a", confirmed: true }, userId: "romain" },
        T0,
      ),
    ).toBe("tok-a");
  });
});

describe("createChatApprovalStore — expiry is visible, not silent", () => {
  it("reports `expired` once the interceptor's TTL has passed", () => {
    const store = makeStore();
    const { challengeId } = register(store, { expiresAt: T0 + 1_000 });
    expect(store.get(challengeId, T0)?.status).toBe("pending");
    expect(store.get(challengeId, T0 + 1_001)?.status).toBe("expired");
  });

  it("refuses to approve an expired challenge, and says why", () => {
    const store = makeStore();
    const { challengeId } = register(store, { expiresAt: T0 + 1_000 });
    expect(store.approve(challengeId, "romain", T0 + 1_001)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses to hand out a grant approved before expiry but claimed after it", () => {
    const store = makeStore();
    const { challengeId } = register(store, { expiresAt: T0 + 1_000 });
    store.approve(challengeId, "romain", T0);
    expect(
      store.claimGrant(
        { tool: "delete_file", args: { path: "/a" }, userId: "romain" },
        T0 + 1_001,
      ),
    ).toBeNull();
  });
});

describe("createChatApprovalStore — bounded", () => {
  it("evicts oldest-first rather than growing without limit", () => {
    const store = createChatApprovalStore({ maxEntries: 3 });
    const ids = [0, 1, 2, 3, 4].map((i) =>
      store.register({
        tool: "t",
        args: { i },
        token: `tok-${i}`,
        expiresAt: T0 + 60_000,
        userId: "romain",
      }).challengeId,
    );
    expect(store.size()).toBe(3);
    expect(store.get(ids[0]!, T0)).toBeNull();
    expect(store.get(ids[4]!, T0)).not.toBeNull();
  });
});
