// add-llm-tool:not-a-gate — reads the registry and catalog to pin ADR-055
// §11.5 (no doors_* tool writes), not to gate adding a tool: nothing an agent
// edits when adding a tool is read here beyond what registry.test.ts and
// catalog.test.ts already gate, and this file's imports are not add-a-tool sites.
/**
 * ADR-055 (P4a) §11.5 — the assistant is READ-ONLY on doors.
 *
 * "The assistant may never open a door, issue a credential, or change a grant.
 * There is no confirmation-token flow that makes it acceptable: a confirm token
 * has already leaked to a model on this platform once." And: "Enforcement is at
 * dispatch, not by filtering a catalogue, so an unlock tool that does not exist
 * cannot be reached by a model that has guessed its name."
 *
 * Two layers, both pinned here:
 *
 *   1. the registry — every `doors_*` tool is read-only by flag, and the doors
 *      domain and the `doors_` prefix name the same set;
 *   2. dispatch — `createToolCallInterceptor().intercept` refuses any tool in
 *      the reserved `doors_` namespace that is not AFFIRMATIVELY read-only, no
 *      matter who registered it, what token it presents, or what has been done
 *      to the runtime deny tier. That is the layer a remote or runtime tool
 *      (which has no entry in registry.ts) cannot route around.
 *
 * Mutations these are written to catch:
 *   - delete the namespace check from `intercept`      → the dispatch cases red
 *   - make it a deny-TIER rule instead                  → the `clear()` case reds
 *   - treat an undeclared `requiresWrite` as read-only  → the fail-closed case reds
 *   - let a valid confirmation token through            → the token case reds
 */
import { describe, it, expect } from "vitest";
import {
  READ_ONLY_TOOL_NAMESPACES,
  createToolCallInterceptor,
  defaultToolCallInterceptor,
  interceptOutcomeToToolResult,
  type InterceptableTool,
} from "../src/interceptor.js";
import { TOOLS } from "../src/registry.js";
import { TOOL_CATALOG } from "../src/catalog.js";

const T0 = 1_700_000_000_000;

function doorsTool(over: Partial<InterceptableTool> = {}): InterceptableTool {
  return {
    name: "doors_unlock",
    requiresWrite: true,
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: { door_id: { type: "string" }, confirmed: { type: "boolean" } },
      additionalProperties: false,
    },
    ...over,
  };
}

describe("the registry: every doors_ tool is a read", () => {
  const doorsTools = [...TOOLS.values()].filter((t) => t.name.startsWith("doors_"));

  it("there are doors tools to check (this file is not vacuous)", () => {
    expect(doorsTools.map((t) => t.name).sort()).toEqual(["doors_list", "doors_recent_events"]);
  });

  it("none writes, none asks for confirmation, and none owns a confirmation route", () => {
    for (const t of doorsTools) {
      expect(t.requiresWrite, t.name).toBe(false);
      expect(t.requiresConfirmation, t.name).toBe(false);
      expect(t.confirmationOwner, t.name).toBeUndefined();
    }
  });

  it("none is named or shaped like an unlock, a grant or a credential", () => {
    const forbidden = /unlock|lock_|_lock|open_door|door_open|grant|credential|enrol|revoke|schedule|pin_|badge/i;
    for (const t of doorsTools) {
      expect(t.name, t.name).not.toMatch(forbidden);
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const p of props) expect(p, `${t.name}.${p}`).not.toMatch(forbidden);
    }
  });

  it("the `doors` domain and the `doors_` prefix are the same set — no doors tool hides in another domain", () => {
    const byDomain = TOOL_CATALOG.filter((e) => e.domain === "doors").map((e) => e.name).sort();
    const byPrefix = TOOL_CATALOG.filter((e) => e.name.startsWith("doors_")).map((e) => e.name).sort();
    expect(byDomain).toEqual(byPrefix);
    for (const e of TOOL_CATALOG.filter((x) => x.domain === "doors")) {
      expect(e.requiresWrite, e.name).toBe(false);
    }
  });

  it("the reserved namespaces are exactly `doors_`", () => {
    expect([...READ_ONLY_TOOL_NAMESPACES]).toEqual(["doors_"]);
  });
});

describe("dispatch: the interceptor refuses a writing doors_ tool, whoever registered it", () => {
  it("denies a write-flagged doors_ tool — a naked handler is never reached", () => {
    const i = createToolCallInterceptor();
    const outcome = i.intercept(doorsTool(), { door_id: "d1" }, undefined, T0);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.reason.code).toBe("read_only_namespace");
    const result = interceptOutcomeToToolResult(doorsTool(), outcome);
    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_DENIED" } });
  });

  it("denies it even when it asks for no confirmation at all (a write with the flag off is still a write)", () => {
    const i = createToolCallInterceptor();
    const outcome = i.intercept(doorsTool({ requiresConfirmation: false }), {}, undefined, T0);
    expect(outcome.kind).toBe("denied");
  });

  it("denies a tool that declares nothing: read-only must be affirmative, not assumed (fail closed)", () => {
    const i = createToolCallInterceptor();
    const undeclared: InterceptableTool = { name: "doors_open", requiresConfirmation: false };
    expect(i.intercept(undeclared, {}, undefined, T0).kind).toBe("denied");
    const halfDeclared: InterceptableTool = { name: "doors_open", requiresConfirmation: false, requiresWrite: undefined };
    expect(i.intercept(halfDeclared, {}, undefined, T0).kind).toBe("denied");
  });

  it("no approval makes it allowed: a real confirmation token minted for the exact call is still refused", () => {
    const i = createToolCallInterceptor();
    const tool = doorsTool();
    const args = { door_id: "d1" };
    // Mint a token the way the confirmation flow would, bound to this call.
    const minted = i.tokens.mint(tool.name, args, T0);
    const outcome = i.intercept(tool, args, { confirmationToken: minted.token }, T0 + 1);
    expect(outcome.kind).toBe("denied");
    // …and the token was not spent on the way to being refused.
    expect(i.tokens.redeem(minted.token, tool.name, args, T0 + 2).ok).toBe(true);
  });

  it("cannot be switched off through the runtime deny tier — it is not a rule in it", () => {
    const i = createToolCallInterceptor();
    i.denyTier.clear();
    expect(i.denyTier.ids()).toEqual([]);
    expect(i.intercept(doorsTool(), {}, undefined, T0).kind).toBe("denied");
    const shared = defaultToolCallInterceptor;
    shared.denyTier.clear();
    expect(shared.intercept(doorsTool(), {}, undefined, T0).kind).toBe("denied");
  });

  it("matches the namespace however the name is spelled", () => {
    const i = createToolCallInterceptor();
    for (const name of ["DOORS_unlock", " doors_unlock", "Doors_Unlock"]) {
      expect(i.intercept(doorsTool({ name }), {}, undefined, T0).kind, JSON.stringify(name)).toBe("denied");
    }
  });

  it("lets the real doors tools through, and does not touch any other namespace", () => {
    const i = createToolCallInterceptor();
    for (const name of ["doors_list", "doors_recent_events"]) {
      const real = TOOLS.get(name)!;
      expect(i.intercept(real, {}, undefined, T0).kind, name).toBe("proceed");
    }
    // A confirming tool elsewhere keeps its ordinary two-phase flow.
    const other: InterceptableTool = { name: "control_device", requiresWrite: true, requiresConfirmation: true };
    expect(i.intercept(other, {}, undefined, T0).kind).toBe("confirmation_required");
    // `doors` in the middle of a name is not the reserved namespace.
    const near: InterceptableTool = { name: "get_doors_status", requiresWrite: false, requiresConfirmation: false };
    expect(i.intercept(near, {}, undefined, T0).kind).toBe("proceed");
  });
});
