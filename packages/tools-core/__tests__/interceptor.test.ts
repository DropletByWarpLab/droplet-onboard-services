/**
 * WARP-2312 / WARP-2328 — the generic interceptor and the runtime deny
 * tier.
 *
 * The core assertion of WARP-2305 is the NAKED HANDLER: a tool marked
 * `requiresConfirmation` whose handler contains no confirmation code at
 * all must still be refused on the first call. If it executes, the
 * interceptor is decorative and every remote MCP tool under WARP-320 is
 * unguarded. This is not hypothetical — 19 of the 37 confirming tools on
 * `origin/stage` had no handler-side check (see
 * `docs/tool-confirmation-contract.md` §7).
 *
 * Mutations these are written to catch:
 *   - remove the interceptor from the dispatch path → naked-handler red
 *   - delete the deny check                         → runtime-deny red
 *   - challenge unconditionally (ignore a valid token) → phase-2 red
 *   - put tool arguments into the audit event       → PHI test red
 */
import { describe, it, expect, vi } from "vitest";
import {
  createRuntimeDenyTier,
  createToolCallInterceptor,
  declaresConfirmedFlag,
  defaultToolCallInterceptor,
  interceptOutcomeToToolResult,
  interceptorAuditEvent,
  type InterceptableTool,
} from "../src/interceptor.js";
import { TOOLS } from "../src/registry.js";

const T0 = 1_700_000_000_000;

/**
 * A tool with `requiresConfirmation: true` and ZERO confirmation code.
 * Its handler writes on entry — `written` is the observable side effect
 * that proves whether the gate held.
 */
function nakedTool() {
  const written: string[] = [];
  const handler = vi.fn(async (args: Record<string, unknown>) => {
    written.push(String(args.path));
    return { ok: true as const, data: { deleted: args.path } };
  });
  const tool: InterceptableTool = {
    name: "naked_delete",
    requiresConfirmation: true,
    requiresWrite: true,
    // Note: no `confirmed` property. This tool knows nothing about the
    // two-phase contract.
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  return { tool, handler, written };
}

/** Dispatch exactly as `services/mcp-server/src/server.ts` does. */
async function dispatch(
  interceptor: ReturnType<typeof createToolCallInterceptor>,
  tool: InterceptableTool,
  handler: (a: Record<string, unknown>) => Promise<unknown>,
  args: Record<string, unknown>,
  meta?: { confirmationToken?: string },
  now = T0,
) {
  const outcome = interceptor.intercept(tool, args, meta, now);
  const refusal = interceptOutcomeToToolResult(tool, outcome);
  if (refusal) return { refusal, outcome, result: null };
  const effective = outcome.kind === "proceed" ? outcome.args : args;
  return { refusal: null, outcome, result: await handler(effective) };
}

describe("interceptor — naked handler (WARP-2312)", () => {
  it("REFUSES the first call to a requiresConfirmation tool whose handler has no checks", async () => {
    const interceptor = createToolCallInterceptor();
    const { tool, handler, written } = nakedTool();

    const first = await dispatch(interceptor, tool, handler, { path: "/payroll.xlsx" });

    expect(first.refusal).not.toBeNull();
    expect(first.refusal!.ok).toBe(false);
    // The handler is never entered — asserted on the SPY, not just the
    // response, so a handler with a side effect on its first line is safe.
    expect(handler).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("EXECUTES only after a valid confirmation, and then performs the write", async () => {
    const interceptor = createToolCallInterceptor();
    const { tool, handler, written } = nakedTool();
    const args = { path: "/payroll.xlsx" };

    const first = await dispatch(interceptor, tool, handler, args);
    expect(first.outcome.kind).toBe("confirmation_required");
    const token =
      first.outcome.kind === "confirmation_required" ? first.outcome.token : "";

    const second = await dispatch(interceptor, tool, handler, args, {
      confirmationToken: token,
    });

    expect(second.refusal).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(written).toEqual(["/payroll.xlsx"]);
  });

  it("does NOT inject `confirmed` into a schema that does not declare it", async () => {
    // An `additionalProperties: false` schema must not be handed an
    // unknown key just because the interceptor verified a token.
    const interceptor = createToolCallInterceptor();
    const { tool, handler } = nakedTool();
    const args = { path: "/a" };
    const first = interceptor.intercept(tool, args, undefined, T0);
    const token = first.kind === "confirmation_required" ? first.token : "";

    await dispatch(interceptor, tool, handler, args, { confirmationToken: token });
    expect(handler).toHaveBeenCalledWith({ path: "/a" });
  });

  it("surfaces a DISTINCT MACHINE-READABLE outcome, not a string to pattern-match", async () => {
    const interceptor = createToolCallInterceptor();
    const { tool, handler } = nakedTool();
    const { refusal } = await dispatch(interceptor, tool, handler, { path: "/a" });

    expect(refusal!.ok).toBe(false);
    if (refusal!.ok) return;
    expect(refusal!.status).toBe("confirmation_required");
    expect(refusal!.error.code).toBe("CONFIRMATION_REQUIRED");
    const details = refusal!.error.details as {
      interceptor: { outcome: string; tool: string; confirmationToken: string };
    };
    expect(details.interceptor.outcome).toBe("confirmation_required");
    expect(details.interceptor.tool).toBe("naked_delete");
    expect(typeof details.interceptor.confirmationToken).toBe("string");
  });

  it("refuses a token minted for a DIFFERENT tool's call, at the dispatch boundary", async () => {
    const interceptor = createToolCallInterceptor();
    const { tool, handler, written } = nakedTool();
    const other: InterceptableTool = { name: "other_tool", requiresConfirmation: true };

    const minted = interceptor.intercept(other, { path: "/a" }, undefined, T0);
    const token = minted.kind === "confirmation_required" ? minted.token : "";

    const res = await dispatch(interceptor, tool, handler, { path: "/a" }, {
      confirmationToken: token,
    });

    expect(res.outcome.kind).toBe("confirmation_rejected");
    expect(handler).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("lets a read tool through untouched", async () => {
    const interceptor = createToolCallInterceptor();
    const handler = vi.fn(async () => ({ ok: true as const, data: {} }));
    const read: InterceptableTool = {
      name: "list_files",
      requiresConfirmation: false,
      requiresWrite: false,
    };

    const res = await dispatch(interceptor, read, handler, { path: "/" });
    expect(res.refusal).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
 * The legacy `confirmed: true` path. It exists so the 16 hand-rolled
 * two-phase tools keep completing in the chat surface, where nothing can
 * carry a token back (`_meta` is set by the orchestrator; the model is
 * what re-issues the call). It is weaker than the token by design — and
 * strictly stronger than what shipped before, which accepted the bare
 * boolean with no challenge, no binding, no expiry and no single-use.
 */
describe("interceptor — legacy `confirmed: true` against a live challenge", () => {
  /** A tool shaped like the 16: schema declares `confirmed`. */
  function legacyTool(name = "legacy_write"): InterceptableTool {
    return {
      name,
      requiresConfirmation: true,
      requiresWrite: true,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, confirmed: { type: "boolean" } },
        required: ["id"],
        additionalProperties: false,
      },
    };
  }

  it("completes the two-phase flow the chat surface actually performs", () => {
    const interceptor = createToolCallInterceptor();
    const tool = legacyTool();

    const first = interceptor.intercept(tool, { id: "a" }, undefined, T0);
    expect(first.kind).toBe("confirmation_required");

    // The model re-issues with `confirmed: true` — no token, because it
    // has no way to obtain one. This MUST proceed, or every confirming
    // tool challenges forever in production.
    const second = interceptor.intercept(tool, { id: "a", confirmed: true }, undefined, T0 + 1);
    expect(second.kind).toBe("proceed");
    if (second.kind !== "proceed") return;
    expect(second.confirmationConsumed).toBe(true);
  });

  it("REFUSES `confirmed: true` when nothing ever challenged this call", () => {
    // The security floor: a bare boolean is not an approval. Mutation:
    // accept `confirmed: true` unconditionally → red, and the pre-WARP-2305
    // hole is back.
    const interceptor = createToolCallInterceptor();
    const outcome = interceptor.intercept(
      legacyTool(),
      { id: "a", confirmed: true },
      undefined,
      T0,
    );
    expect(outcome.kind).toBe("confirmation_required");
  });

  it("REFUSES a challenge moved to DIFFERENT ARGUMENTS", () => {
    const interceptor = createToolCallInterceptor();
    const tool = legacyTool();
    interceptor.intercept(tool, { id: "harmless" }, undefined, T0);

    // Challenged for "harmless"; approving "payroll" must not ride on it.
    const outcome = interceptor.intercept(
      tool,
      { id: "payroll", confirmed: true },
      undefined,
      T0 + 1,
    );
    expect(outcome.kind).toBe("confirmation_required");
  });

  it("REFUSES a challenge moved to a DIFFERENT TOOL", () => {
    const interceptor = createToolCallInterceptor();
    interceptor.intercept(legacyTool("tool_a"), { id: "a" }, undefined, T0);

    const outcome = interceptor.intercept(
      legacyTool("tool_b"),
      { id: "a", confirmed: true },
      undefined,
      T0 + 1,
    );
    expect(outcome.kind).toBe("confirmation_required");
  });

  it("is SINGLE-USE — the same approval cannot drive two writes", () => {
    const interceptor = createToolCallInterceptor();
    const tool = legacyTool();
    interceptor.intercept(tool, { id: "a" }, undefined, T0);

    expect(interceptor.intercept(tool, { id: "a", confirmed: true }, undefined, T0 + 1).kind).toBe(
      "proceed",
    );
    // A second write on one thumbs-up must challenge again.
    expect(interceptor.intercept(tool, { id: "a", confirmed: true }, undefined, T0 + 2).kind).toBe(
      "confirmation_required",
    );
  });

  it("EXPIRES — an approval given long after the challenge is refused", () => {
    const interceptor = createToolCallInterceptor();
    const tool = legacyTool();
    interceptor.intercept(tool, { id: "a" }, undefined, T0);

    const outcome = interceptor.intercept(
      tool,
      { id: "a", confirmed: true },
      undefined,
      T0 + 10 * 60_000,
    );
    expect(outcome.kind).toBe("confirmation_required");
  });

  it("is NOT available to a tool with no handler-side gate — those must present a real token", () => {
    // The 8 registry tools that had no check, and every WARP-320 remote
    // tool, fall here. Fail-closed is the correct direction for a write
    // nothing was guarding.
    const interceptor = createToolCallInterceptor();
    const { tool } = nakedTool();
    interceptor.intercept(tool, { path: "/a" }, undefined, T0);

    const outcome = interceptor.intercept(
      tool,
      { path: "/a", confirmed: true },
      undefined,
      T0 + 1,
    );
    expect(outcome.kind).toBe("confirmation_required");
  });

  it("still lets the strong token through for a legacy-shaped tool", () => {
    const interceptor = createToolCallInterceptor();
    const tool = legacyTool();
    const first = interceptor.intercept(tool, { id: "a" }, undefined, T0);
    const token = first.kind === "confirmation_required" ? first.token : "";

    const second = interceptor.intercept(tool, { id: "a" }, { confirmationToken: token }, T0 + 1);
    expect(second.kind).toBe("proceed");
    if (second.kind !== "proceed") return;
    expect(second.args.confirmed).toBe(true);
  });
});

describe("runtime deny tier (WARP-2328)", () => {
  it("REFUSES a tool that IS present in the registry — the case compile-time absence cannot express", async () => {
    const denyTier = createRuntimeDenyTier();
    const interceptor = createToolCallInterceptor({ denyTier });
    const handler = vi.fn(async () => ({ ok: true as const, data: {} }));

    // `list_storage_pools` really is in registry.ts. Absence-based
    // blocking has nothing to say about it; the deny tier does.
    const present = TOOLS.get("list_storage_pools");
    expect(present, "fixture must be a registry-PRESENT tool").toBeDefined();

    denyTier.add("test:maintenance-window", () => ({
      code: "MAINTENANCE_WINDOW",
      message: "storage introspection is paused during a rebuild",
    }));

    const res = await dispatch(interceptor, present!, handler, {});

    expect(res.outcome.kind).toBe("denied");
    // A denied call never reaches the handler — asserted with the spy.
    expect(handler).not.toHaveBeenCalled();
    expect(res.refusal!.ok).toBe(false);
    if (res.refusal!.ok) return;
    expect(res.refusal!.error.code).toBe("TOOL_DENIED");
    // A distinct machine-readable outcome, not an empty or
    // successful-looking result.
    expect(res.refusal!.status).toBe("error");
    expect(
      (res.refusal!.error.details as { interceptor: { reason: string } }).interceptor.reason,
    ).toBe("MAINTENANCE_WINDOW");
  });

  it("ships EMPTY — membership is a separate human decision, not this story's", () => {
    // If this ever fails, someone has put a policy list in the mechanism.
    expect(defaultToolCallInterceptor.denyTier.ids()).toEqual([]);
  });

  it("denies BEFORE the confirmation gate — no approval makes a blocked action allowed", async () => {
    const denyTier = createRuntimeDenyTier();
    const interceptor = createToolCallInterceptor({ denyTier });
    const { tool, handler } = nakedTool();

    // Mint a genuinely valid token first...
    const minted = interceptor.intercept(tool, { path: "/a" }, undefined, T0);
    const token = minted.kind === "confirmation_required" ? minted.token : "";

    // ...then deny the tool. The valid confirmation must not rescue it.
    denyTier.add("test:blocked", () => ({ code: "BLOCKED", message: "no" }));
    const res = await dispatch(interceptor, tool, handler, { path: "/a" }, {
      confirmationToken: token,
    });

    expect(res.outcome.kind).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });

  it("evaluates per-call, so a rule can depend on runtime CONDITIONS not just names", async () => {
    const denyTier = createRuntimeDenyTier();
    const interceptor = createToolCallInterceptor({ denyTier });
    const handler = vi.fn(async () => ({ ok: true as const, data: {} }));
    const tool: InterceptableTool = { name: "write_file", requiresConfirmation: false };

    denyTier.add("test:protected-path", ({ args }) =>
      String(args.path).startsWith("/system/")
        ? { code: "PROTECTED_PATH", message: "system paths are not writable by the assistant" }
        : null,
    );

    expect((await dispatch(interceptor, tool, handler, { path: "/home/a" })).refusal).toBeNull();
    expect((await dispatch(interceptor, tool, handler, { path: "/system/a" })).refusal).not.toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports removing a rule, so a runtime condition can clear", () => {
    const denyTier = createRuntimeDenyTier();
    denyTier.add("r", () => ({ code: "X", message: "x" }));
    expect(denyTier.ids()).toEqual(["r"]);
    expect(denyTier.remove("r")).toBe(true);
    expect(denyTier.evaluate({ name: "t", requiresConfirmation: false }, {})).toBeNull();
  });
});

describe("interceptor — audit event shape (WARP-2352)", () => {
  const PHI = "Camille Moreau, DOB 1984-03-02, MRN 88213";

  it("never carries tool ARGUMENTS, so PHI cannot reach the audit scope", () => {
    const interceptor = createToolCallInterceptor();
    const { tool } = nakedTool();
    const args = { path: `/patients/${PHI}.pdf`, note: PHI };

    const outcome = interceptor.intercept(tool, args, undefined, T0);
    const event = interceptorAuditEvent(tool, outcome);

    expect(event).not.toBeNull();
    // Mutation: pass raw tool arguments into the audit scope → red.
    expect(JSON.stringify(event)).not.toContain("Camille");
    expect(JSON.stringify(event)).not.toContain("88213");
    expect(JSON.stringify(event)).not.toContain("patients");
    expect(event!.outcome).toBe("confirmation_required");
    expect(event!.tool).toBe("naked_delete");
  });

  it("distinguishes a first-call challenge from a deny and from a consumed confirmation", () => {
    const denyTier = createRuntimeDenyTier();
    const interceptor = createToolCallInterceptor({ denyTier });
    const { tool } = nakedTool();
    const args = { path: "/a" };

    const challenge = interceptor.intercept(tool, args, undefined, T0);
    expect(interceptorAuditEvent(tool, challenge)!.outcome).toBe("confirmation_required");

    const token = challenge.kind === "confirmation_required" ? challenge.token : "";
    const confirmed = interceptor.intercept(tool, args, { confirmationToken: token }, T0);
    expect(interceptorAuditEvent(tool, confirmed)!.outcome).toBe("confirmed");

    denyTier.add("d", () => ({ code: "NOPE", message: "no" }));
    const denied = interceptor.intercept(tool, args, undefined, T0);
    expect(interceptorAuditEvent(tool, denied)).toEqual({
      outcome: "denied",
      tool: "naked_delete",
      reason: "NOPE",
    });
  });

  it("writes NO row for an ordinary read that simply proceeds", () => {
    const interceptor = createToolCallInterceptor();
    const read: InterceptableTool = { name: "list_files", requiresConfirmation: false };
    const outcome = interceptor.intercept(read, { path: "/" }, undefined, T0);
    // Mutation: emit a row for every proceed → the "exactly one row"
    // audit tests go red and the activity log floods with reads.
    expect(interceptorAuditEvent(read, outcome)).toBeNull();
  });

  it("records the REASON a confirmation was rejected", () => {
    const interceptor = createToolCallInterceptor();
    const { tool } = nakedTool();
    const outcome = interceptor.intercept(tool, { path: "/a" }, {
      confirmationToken: "bogus",
    }, T0);
    expect(interceptorAuditEvent(tool, outcome)).toEqual({
      outcome: "confirmation_rejected",
      tool: "naked_delete",
      reason: "unknown_token",
    });
  });
});

describe("declaresConfirmedFlag", () => {
  it("detects the flag from the SCHEMA, never from a list of tool names", () => {
    // Derivation, not enumeration — the WARP-2345 rule applied here too.
    expect(declaresConfirmedFlag(TOOLS.get("memory_forget")!)).toBe(true);
    expect(declaresConfirmedFlag(TOOLS.get("list_files")!)).toBe(false);
    expect(declaresConfirmedFlag({ name: "x", requiresConfirmation: true })).toBe(false);
  });
});
