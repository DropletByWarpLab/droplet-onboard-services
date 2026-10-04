/**
 * The read-only tool namespaces — the structural guard `intercept` runs first.
 *
 * `READ_ONLY_TOOL_NAMESPACES` (interceptor.ts) ships EMPTY: no namespace is
 * reserved today, and the first suite pins that. The guard itself is generic,
 * so the rest registers a probe namespace for the length of each case and
 * removes it afterwards, and pins what reserving one buys:
 *
 *   1. the rule as a pure function, `readOnlyNamespaceBreach` — a tool in a
 *      reserved namespace is allowed only if it AFFIRMATIVELY declares itself a
 *      read (`requiresWrite` and `requiresConfirmation` both `false`);
 *   2. dispatch — `createToolCallInterceptor().intercept` refuses any other
 *      tool in the namespace, no matter who registered it, what token it
 *      presents, or what has been done to the runtime deny tier. That is the
 *      layer a remote or runtime tool (which has no entry in registry.ts)
 *      cannot route around.
 *
 * Mutations these are written to catch:
 *   - delete the namespace check from `intercept`      → the dispatch cases red
 *   - move it below the deny tier                       → the "asked before the deny tier" case reds
 *   - make it a deny-TIER rule instead                  → the `clear()` case reds
 *   - treat an undeclared `requiresWrite` as read-only  → the fail-closed case reds
 *   - let a valid confirmation token through            → the token case reds
 *   - reserve a namespace by default                    → the "ships empty" cases red
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  READ_ONLY_TOOL_NAMESPACES,
  createToolCallInterceptor,
  defaultToolCallInterceptor,
  interceptOutcomeToToolResult,
  readOnlyNamespaceBreach,
  type InterceptableTool,
} from "../src/interceptor.js";

const T0 = 1_700_000_000_000;
const PROBE_NAMESPACE = "probe_";

/** The registry is a plain array behind a `readonly` type; a case registers and removes its probe through this. */
const registry = READ_ONLY_TOOL_NAMESPACES as string[];

/** A tool in the probe namespace that writes and asks for a confirmation — the shape a reserved namespace refuses. */
function probeTool(over: Partial<InterceptableTool> = {}): InterceptableTool {
  return {
    name: "probe_write",
    requiresWrite: true,
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" }, confirmed: { type: "boolean" } },
      additionalProperties: false,
    },
    ...over,
  };
}

describe("read-only tool namespaces ship empty", () => {
  it("reserves no namespace by default", () => {
    expect([...READ_ONLY_TOOL_NAMESPACES]).toEqual([]);
  });

  it("so nothing is refused by its name alone: a writing tool keeps its ordinary two-phase flow", () => {
    expect(readOnlyNamespaceBreach(probeTool())).toBeNull();
    const i = createToolCallInterceptor();
    expect(i.intercept(probeTool(), { target: "t1" }, undefined, T0).kind).toBe("confirmation_required");
  });
});

describe("a reserved read-only namespace: the rule", () => {
  beforeEach(() => {
    registry.push(PROBE_NAMESPACE);
  });
  afterEach(() => {
    registry.splice(0);
  });

  it("lets a tool through only when it affirmatively declares itself a read", () => {
    const read = probeTool({ name: "probe_list", requiresWrite: false, requiresConfirmation: false });
    expect(readOnlyNamespaceBreach(read)).toBeNull();
  });

  it("refuses a write, a confirming tool, and a tool that declares nothing (fail closed)", () => {
    const refused: InterceptableTool[] = [
      probeTool(),
      probeTool({ requiresConfirmation: false }),
      probeTool({ requiresWrite: false }),
      { name: "probe_open", requiresConfirmation: false },
      { name: "probe_open", requiresConfirmation: false, requiresWrite: undefined },
    ];
    for (const tool of refused) {
      expect(readOnlyNamespaceBreach(tool), JSON.stringify(tool)).toMatchObject({ code: "read_only_namespace" });
    }
  });

  it("says which tool and which namespace, and that nothing was attempted", () => {
    const breach = readOnlyNamespaceBreach(probeTool());
    expect(breach?.message).toContain("'probe_write'");
    expect(breach?.message).toContain(`'${PROBE_NAMESPACE}'`);
    expect(breach?.message).toContain("Nothing about this call was attempted");
  });

  it("matches the namespace however the name is spelled", () => {
    for (const name of ["PROBE_write", " probe_write", "Probe_Write"]) {
      expect(readOnlyNamespaceBreach(probeTool({ name })), JSON.stringify(name)).not.toBeNull();
    }
  });

  it("does not reach into other namespaces: the prefix in the middle of a name is not reserved", () => {
    expect(readOnlyNamespaceBreach(probeTool({ name: "get_probe_status" }))).toBeNull();
    expect(readOnlyNamespaceBreach(probeTool({ name: "other_write" }))).toBeNull();
  });
});

describe("a reserved read-only namespace: dispatch refuses a writing tool, whoever registered it", () => {
  beforeEach(() => {
    registry.push(PROBE_NAMESPACE);
  });
  afterEach(() => {
    registry.splice(0);
  });

  it("denies a write-flagged tool — a naked handler is never reached", () => {
    const i = createToolCallInterceptor();
    const outcome = i.intercept(probeTool(), { target: "t1" }, undefined, T0);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.reason.code).toBe("read_only_namespace");
    const result = interceptOutcomeToToolResult(probeTool(), outcome);
    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_DENIED" } });
  });

  it("denies it even when it asks for no confirmation at all (a write with the flag off is still a write)", () => {
    const i = createToolCallInterceptor();
    const outcome = i.intercept(probeTool({ requiresConfirmation: false }), {}, undefined, T0);
    expect(outcome.kind).toBe("denied");
  });

  it("denies a tool that asks for confirmation even though it declares no write: a prompt is not a reason for it to exist", () => {
    const i = createToolCallInterceptor();
    const confirmingRead = probeTool({ requiresWrite: false, requiresConfirmation: true });
    expect(i.intercept(confirmingRead, {}, undefined, T0).kind).toBe("denied");
    const minted = i.tokens.mint(confirmingRead.name, {}, T0);
    expect(i.intercept(confirmingRead, {}, { confirmationToken: minted.token }, T0 + 1).kind).toBe("denied");
  });

  it("denies a tool that declares nothing: read-only must be affirmative, not assumed (fail closed)", () => {
    const i = createToolCallInterceptor();
    const undeclared: InterceptableTool = { name: "probe_open", requiresConfirmation: false };
    expect(i.intercept(undeclared, {}, undefined, T0).kind).toBe("denied");
    const halfDeclared: InterceptableTool = { name: "probe_open", requiresConfirmation: false, requiresWrite: undefined };
    expect(i.intercept(halfDeclared, {}, undefined, T0).kind).toBe("denied");
  });

  it("no approval makes it allowed: a real confirmation token minted for the exact call is still refused", () => {
    const i = createToolCallInterceptor();
    const tool = probeTool();
    const args = { target: "t1" };
    // Mint a token the way the confirmation flow would, bound to this call.
    const minted = i.tokens.mint(tool.name, args, T0);
    const outcome = i.intercept(tool, args, { confirmationToken: minted.token }, T0 + 1);
    expect(outcome.kind).toBe("denied");
    // …and the token was not spent on the way to being refused.
    expect(i.tokens.redeem(minted.token, tool.name, args, T0 + 2).ok).toBe(true);
  });

  it("is asked before the deny tier: a deny rule never speaks for a tool the guard already refuses", () => {
    const i = createToolCallInterceptor();
    i.denyTier.add("probe-rule", () => ({ code: "probe_rule", message: "from the deny tier" }));
    expect(i.intercept(probeTool(), {}, undefined, T0)).toMatchObject({
      kind: "denied",
      reason: { code: "read_only_namespace" },
    });
  });

  it("cannot be switched off through the runtime deny tier — it is not a rule in it", () => {
    const i = createToolCallInterceptor();
    i.denyTier.clear();
    expect(i.denyTier.ids()).toEqual([]);
    expect(i.intercept(probeTool(), {}, undefined, T0).kind).toBe("denied");
    const shared = defaultToolCallInterceptor;
    shared.denyTier.clear();
    expect(shared.intercept(probeTool(), {}, undefined, T0).kind).toBe("denied");
  });

  it("matches the namespace however the name is spelled", () => {
    const i = createToolCallInterceptor();
    for (const name of ["PROBE_write", " probe_write", "Probe_Write"]) {
      expect(i.intercept(probeTool({ name }), {}, undefined, T0).kind, JSON.stringify(name)).toBe("denied");
    }
  });

  it("lets a declared read through, and does not touch any other namespace", () => {
    const i = createToolCallInterceptor();
    const read: InterceptableTool = { name: "probe_list", requiresWrite: false, requiresConfirmation: false };
    expect(i.intercept(read, {}, undefined, T0).kind).toBe("proceed");
    // A confirming tool elsewhere keeps its ordinary two-phase flow.
    const other: InterceptableTool = { name: "control_device", requiresWrite: true, requiresConfirmation: true };
    expect(i.intercept(other, {}, undefined, T0).kind).toBe("confirmation_required");
    // The prefix in the middle of a name is not the reserved namespace.
    const near: InterceptableTool = { name: "get_probe_status", requiresWrite: false, requiresConfirmation: false };
    expect(i.intercept(near, {}, undefined, T0).kind).toBe("proceed");
  });
});
