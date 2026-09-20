/**
 * WARP-2669 — `delete_file` challenges before it deletes.
 *
 * The tool shipped `requiresConfirmation: false` while three orchestrator
 * suites used it as their CONFIRMING fixture and `tool-confirmation-contract.md`
 * §3 used it as the worked example of a gated tool. Those fixtures are stubs
 * (`chat-approval-roundtrip.test.ts` builds its own `DELETE_FILE` object), so
 * every one of them stayed green against a registry entry that never
 * challenged. This suite is deliberately the opposite: it reads the LIVE
 * registry entry, so it cannot pass against a tool that is not actually gated.
 *
 * Mutations these are written to catch:
 *   - flip `requiresConfirmation` back to false → the descriptor test and the
 *     no-write test both red (the handler runs and the DELETE goes out)
 *   - add a `confirmed` boolean to the schema → the descriptor test reds, and
 *     so does the legacy-path test: that flag would let the MODEL approve its
 *     own recursive delete against a live challenge
 *   - declare `confirmationOwner: "route"` → the interceptor stands down,
 *     nothing challenges, and the no-write test reds
 *   - unbind the token from the arguments → the cross-path test reds
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getTool } from "../../../src/index.js";
import {
  confirmationOwnerOf,
  createToolCallInterceptor,
  declaresConfirmedFlag,
  interceptOutcomeToToolResult,
} from "../../../src/interceptor.js";
import type { Tool, ToolContext, ToolResult } from "../../../src/types.js";

function tool(): Tool {
  const t = getTool("delete_file");
  if (!t) throw new Error("delete_file is not registered");
  return t;
}

function makeCtx(): { ctx: ToolContext; ncDelete: Mock } {
  const ncDelete = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const ctx = {
    prisma: {} as unknown as PrismaClient,
    http: {
      nextcloud: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: ncDelete },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    matter: {} as ToolContext["matter"],
    userId: "alice",
    ncToken: "test-token",
    signal: new AbortController().signal,
  } as ToolContext;
  return { ctx, ncDelete };
}

/**
 * A faithful stand-in for the ONE `tool.handler(...)` call site
 * (`services/mcp-server/src/server.ts`): intercept first, and run the handler
 * only on `proceed`. Sharing one interceptor across the calls is the point —
 * its token store is what binds a challenge to its confirming call.
 */
function makeDispatch() {
  const interceptor = createToolCallInterceptor();
  const { ctx, ncDelete } = makeCtx();
  async function dispatch(
    args: Record<string, unknown>,
    meta?: { confirmationToken?: string },
  ): Promise<ToolResult> {
    const t = tool();
    const outcome = interceptor.intercept(t, args, meta);
    const refused = interceptOutcomeToToolResult(t, outcome);
    if (refused) return refused;
    return t.handler(args, ctx);
  }
  return { dispatch, ncDelete };
}

/** Narrow to the refusal arm of the union, so `status` and `error` are typed. */
function refusal(res: ToolResult): Extract<ToolResult, { ok: false }> {
  if (res.ok) throw new Error("expected a refusal, got a successful result");
  return res;
}

function tokenOf(res: ToolResult): string {
  const details = (res as { error?: { details?: Record<string, unknown> } }).error?.details;
  const block = details?.interceptor as { confirmationToken?: string } | undefined;
  const token = block?.confirmationToken;
  if (!token) throw new Error("no confirmation token in the challenge");
  return token;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-2669 — the delete_file descriptor", () => {
  it("is Write-tier AND confirmation-gated", () => {
    expect(tool().requiresWrite).toBe(true);
    expect(tool().requiresConfirmation).toBe(true);
  });

  it("is interceptor-owned — DELETE /api/files runs no Tier-2 gate of its own", () => {
    expect(confirmationOwnerOf(tool())).toBe("interceptor");
  });

  it("declares NO `confirmed` flag, so the legacy path is closed to it", () => {
    // The legacy path (contract §3) lets the MODEL emit the approving boolean
    // against a live challenge. For a recursive delete that is the wrong side
    // of fail-closed: only a token a human minted should get through.
    expect(declaresConfirmedFlag(tool())).toBe(false);
  });
});

describe("WARP-2669 — nothing is deleted without an approval", () => {
  it("challenges the first call and performs NO HTTP", async () => {
    const { dispatch, ncDelete } = makeDispatch();

    const first = await dispatch({ path: "/Documents/Taxes" });

    expect(first.ok).toBe(false);
    expect(refusal(first).status).toBe("confirmation_required");
    // The whole point: the handler never ran.
    expect(ncDelete).not.toHaveBeenCalled();
  });

  it("deletes once the minted token comes back for the SAME path", async () => {
    const { dispatch, ncDelete } = makeDispatch();
    const args = { path: "/Documents/Taxes" };

    const challenge = await dispatch(args);
    const res = await dispatch(args, { confirmationToken: tokenOf(challenge) });

    expect(res).toEqual({ ok: true, data: { deleted: "/Documents/Taxes" } });
    expect(ncDelete).toHaveBeenCalledTimes(1);
  });

  it("refuses a bare `confirmed: true` — the model cannot approve its own delete", async () => {
    const { dispatch, ncDelete } = makeDispatch();

    await dispatch({ path: "/Documents/Taxes" });
    // Re-issued with the boolean the model CAN emit, and nothing else. The
    // schema does not declare `confirmed`, so `declaresConfirmedFlag` is false
    // and the legacy acceptance never applies.
    const res = await dispatch({ path: "/Documents/Taxes", confirmed: true });

    expect(refusal(res).status).toBe("confirmation_required");
    expect(ncDelete).not.toHaveBeenCalled();
  });
});

describe("WARP-2669 — the approval is bound to the path the user saw", () => {
  it("a token for /tmp/scratch cannot approve /payroll", async () => {
    // Contract §3 states this rule against `delete_file` by name, and it has
    // been untestable on the real tool until now — because the real tool
    // never minted a token to bind.
    const { dispatch, ncDelete } = makeDispatch();

    const challenge = await dispatch({ path: "/tmp/scratch" });
    const res = await dispatch(
      { path: "/payroll/2026.xlsx" },
      { confirmationToken: tokenOf(challenge) },
    );

    expect(res.ok).toBe(false);
    expect(refusal(res).status).toBe("confirmation_required");
    expect(refusal(res).error.code).toBe("CONFIRMATION_REJECTED");
    expect(ncDelete).not.toHaveBeenCalled();
  });

  it("one approval drives one delete — the token is spent", async () => {
    const { dispatch, ncDelete } = makeDispatch();
    const args = { path: "/Documents/Taxes" };

    const challenge = await dispatch(args);
    const token = tokenOf(challenge);
    await dispatch(args, { confirmationToken: token });
    const replay = await dispatch(args, { confirmationToken: token });

    expect(refusal(replay).status).toBe("confirmation_required");
    expect(ncDelete).toHaveBeenCalledTimes(1);
  });
});

describe("WARP-2669 — recursion is unchanged, it is merely approved now", () => {
  it("still deletes a directory (and its contents) once approved", async () => {
    const { dispatch, ncDelete } = makeDispatch();
    const args = { path: "/Documents/Archive/" };

    const challenge = await dispatch(args);
    const res = await dispatch(args, { confirmationToken: tokenOf(challenge) });

    // `validateNcPath` strips the trailing slash; the recursive DELETE is the
    // same one-call shape it has always been. What changed is that a human
    // approved THIS path before it went out.
    expect(res).toEqual({ ok: true, data: { deleted: "/Documents/Archive" } });
    expect(ncDelete).toHaveBeenCalledTimes(1);
    expect(ncDelete.mock.calls[0][0]).toBe(
      "/?path=" + encodeURIComponent("/Documents/Archive"),
    );
  });
});
