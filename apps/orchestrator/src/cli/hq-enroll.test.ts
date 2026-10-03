/**
 * WARP-3503 — `npm run hq-enroll`: idempotent enrollment of the box's device
 * key with HQ. The decision lives in runHqEnroll; HQ and the token client are
 * fakes.
 */
import { describe, it, expect, vi } from "vitest";
import { hqEnrollSentinelLine, runHqEnroll, type HqEnrollDeps } from "./hq-enroll.js";
import { HqTokenError, type HqTokenFailure } from "../services/hq-token.service.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const TOKEN = { token: "jwt", expiresAt: Date.now() + 600_000 };

/** getToken answers each call from `outcomes`: a failure reason, or null for a token. */
function makeDeps(
  outcomes: Array<HqTokenFailure | null>,
  over: Partial<HqEnrollDeps> = {},
): HqEnrollDeps & { getToken: ReturnType<typeof vi.fn>; provision: ReturnType<typeof vi.fn> } {
  const queue = [...outcomes];
  const getToken = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected extra token request");
    if (next === null) return TOKEN;
    throw new HqTokenError(next, "/v1/device/token");
  });
  const provision = vi.fn(async (_token: string) => ({ status: "registered" }));
  return {
    hqConfigured: true,
    provisionToken: "one-time-token",
    tokens: { getToken },
    provision,
    logger,
    getToken,
    ...over,
  } as never;
}

describe("runHqEnroll", () => {
  it("skips when HQ is not configured", async () => {
    const deps = makeDeps([], { hqConfigured: false });
    expect(await runHqEnroll(deps)).toBe("skipped");
    expect(deps.getToken).not.toHaveBeenCalled();
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("an already-enrolled box is left alone (idempotent): one token mint, no provision", async () => {
    const deps = makeDeps([null]);
    expect(await runHqEnroll(deps)).toBe("already_enrolled");
    expect(deps.getToken).toHaveBeenCalledTimes(1);
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("not enrolled + a provisioning token → provisions with it, then proves a token mints", async () => {
    const deps = makeDeps(["not_enrolled", null], { provisionToken: "  one-time-token \n" });
    expect(await runHqEnroll(deps)).toBe("enrolled");
    expect(deps.provision).toHaveBeenCalledTimes(1);
    expect(deps.provision).toHaveBeenCalledWith("one-time-token");
    expect(deps.getToken).toHaveBeenCalledTimes(2);
  });

  it("not enrolled and no provisioning token → says so, never calls HQ's provision", async () => {
    const deps = makeDeps(["not_enrolled"], { provisionToken: "  " });
    expect(await runHqEnroll(deps)).toBe("no_provision_token");
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("a revoked box is NOT re-enrolled", async () => {
    const deps = makeDeps(["revoked"]);
    expect(await runHqEnroll(deps)).toBe("revoked");
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it.each(["unreachable", "bad_signature"] as const)("%s on the first mint is a failure, not an enrollment", async (reason) => {
    const deps = makeDeps([reason]);
    expect(await runHqEnroll(deps)).toBe("failed");
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("HQ refusing the provision (spent or expired token) is a failure", async () => {
    const deps = makeDeps(["not_enrolled"]);
    deps.provision.mockRejectedValueOnce(new Error("HQ /api/issuance/provision returned 401: invalid provisioning token"));
    expect(await runHqEnroll(deps)).toBe("failed");
    expect(deps.getToken).toHaveBeenCalledTimes(1);
  });

  it("provisioned but still no token afterwards is a failure", async () => {
    const deps = makeDeps(["not_enrolled", "not_enrolled"]);
    expect(await runHqEnroll(deps)).toBe("failed");
  });

  it("an unexpected error in the token client propagates (the CLI turns it into failed)", async () => {
    const deps = makeDeps([]);
    await expect(runHqEnroll(deps)).rejects.toThrow("unexpected extra token request");
  });

  it("the sentinel line is the stable machine-readable contract", () => {
    expect(hqEnrollSentinelLine("enrolled")).toBe("hq-enroll: result=enrolled");
  });
});
