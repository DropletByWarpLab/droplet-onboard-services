/**
 * WARP-2322 — the 37 hand-rolled confirming handlers under the generic
 * interceptor, with no double-prompt.
 *
 * This is the regression most likely to reach a user: 37 tools already
 * implement the two-phase contract by hand, and an interceptor that does
 * not account for them turns every one into a tool that asks twice.
 *
 * The tool list is ENUMERATED FROM THE `requiresConfirmation` FLAG, never
 * from a copied list of names, so a 38th confirming tool is covered the
 * day it is added. A provenance guard below fails if someone replaces the
 * derivation with a literal array.
 *
 * WARP-2472 SPLIT THE SET. A confirming tool now declares WHICH LAYER
 * asks (`confirmationOwner`), because ten of them relay a 202 from an
 * orchestrator route that runs its own Tier-2 gate — challenging here as
 * well asked the user twice, and the route's challenge is the one the
 * model cannot answer. So the "exactly one challenge" assertion below is
 * scoped to the interceptor-owned tools, and route-owned tools get their
 * own assertion: the interceptor must stand down completely, minting
 * nothing and consuming nothing. Both partitions stay DERIVED.
 *
 * Mutations these are written to catch:
 *   - make the interceptor challenge unconditionally, ignoring a valid
 *     token → the challenge count becomes 2 and the enumerated test reds
 *   - stop setting `confirmed: true` on a verified call → the legacy
 *     handlers raise a second prompt and the end-to-end test reds
 *   - remove the `confirmationOwner === "route"` skip → the route-owned
 *     partition reds (that is the WARP-2472 double prompt, back)
 *   - hard-code the skip so it fires for every tool → the
 *     interceptor-owned partition reds on zero challenges
 *   - hardcode the tool list → the provenance guard reds
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { readFileSync } from "node:fs";
import { TOOLS } from "../src/registry.js";
import {
  confirmationOwnerOf,
  createToolCallInterceptor,
  declaresConfirmedFlag,
  interceptOutcomeToToolResult,
} from "../src/interceptor.js";
import memoryForget from "../src/handlers/memory/forget.js";
import type { Tool, ToolContext } from "../src/types.js";

const T0 = 1_700_000_000_000;

/** DERIVED, not hardcoded — this expression is the point of the file. */
const CONFIRMING: Tool[] = [...TOOLS.values()].filter((t) => t.requiresConfirmation);

/**
 * WARP-2472 — the two partitions, both derived. `confirmationOwnerOf`
 * applies the `"interceptor"` default, so a tool that declares nothing
 * lands in the gated half; forgetting the declaration can never silently
 * remove a gate.
 */
const INTERCEPTOR_OWNED: Tool[] = CONFIRMING.filter(
  (t) => confirmationOwnerOf(t) === "interceptor",
);
const ROUTE_OWNED: Tool[] = CONFIRMING.filter((t) => confirmationOwnerOf(t) === "route");

/** Plausible arguments for a tool, from its own schema. Never a name map. */
function argsFor(tool: Tool): Record<string, unknown> {
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const prop = schema.properties?.[key];
    if (prop?.enum?.length) out[key] = prop.enum[0];
    else if (prop?.type === "number" || prop?.type === "integer") out[key] = 1;
    else if (prop?.type === "boolean") out[key] = true;
    else if (prop?.type === "array") out[key] = [];
    else if (prop?.type === "object") out[key] = {};
    else out[key] = `fixture-${key}`;
  }
  return out;
}

describe("interceptor compatibility across every confirming tool (WARP-2322)", () => {
  it("finds the confirming tools by flag, and there are at least 37", () => {
    // A floor, not an equality: a 38th confirming tool must be covered
    // automatically, but silently DROPPING the flag from tools to make a
    // test pass must fail here.
    expect(CONFIRMING.length).toBeGreaterThanOrEqual(37);
  });

  it("splits into two non-empty, exhaustive partitions by declared owner (WARP-2472)", () => {
    // Neither half may be empty, or the assertions below go vacuously
    // green — the failure mode that made #1818's own dispatch test useless.
    expect(INTERCEPTOR_OWNED.length).toBeGreaterThan(0);
    expect(ROUTE_OWNED.length).toBeGreaterThan(0);
    expect(INTERCEPTOR_OWNED.length + ROUTE_OWNED.length).toBe(CONFIRMING.length);
    // Ten tools relay a 202 from a route that gates the operation itself.
    expect(ROUTE_OWNED.length).toBe(10);
  });

  it("challenges EXACTLY ONCE per two-phase flow — not zero, not two — for every interceptor-owned tool", () => {
    const report: string[] = [];

    for (const tool of INTERCEPTOR_OWNED) {
      const interceptor = createToolCallInterceptor();
      const args = argsFor(tool);
      let challenges = 0;

      // Phase 1 — no token. The interceptor must challenge, and the
      // handler must not be reachable.
      const first = interceptor.intercept(tool, args, undefined, T0);
      if (first.kind === "confirmation_required") challenges++;
      else report.push(`${tool.name}: phase 1 did not challenge (${first.kind})`);

      const token = first.kind === "confirmation_required" ? first.token : "";

      // Phase 2 — valid token. The interceptor must be SILENT.
      const second = interceptor.intercept(tool, args, { confirmationToken: token }, T0 + 1);
      if (second.kind === "confirmation_required") {
        challenges++;
        report.push(`${tool.name}: phase 2 challenged AGAIN (double prompt)`);
      } else if (second.kind !== "proceed") {
        report.push(`${tool.name}: phase 2 was ${second.kind}, expected proceed`);
      }

      if (challenges !== 1) report.push(`${tool.name}: ${challenges} challenges, expected 1`);
    }

    expect(report, `double-prompt / gate failures:\n${report.join("\n")}`).toEqual([]);
  });

  it("challenges ZERO times for every route-owned tool, and mints nothing (WARP-2472)", () => {
    // The route already answers 202 with its own dashboard-redeemable
    // token for these operations. A second challenge here is the defect:
    // the user is asked twice, and the route's ask is the one the model
    // cannot satisfy, so the approved write never lands.
    //
    // "Mints nothing" is the stronger half. A skip that still handed back
    // a token would leave a credential nobody can use lying in the store
    // — the `set_ssh_access` failure class `confirm-dispatcher-coverage`
    // exists to prevent.
    const report: string[] = [];

    for (const tool of ROUTE_OWNED) {
      const interceptor = createToolCallInterceptor();
      const outcome = interceptor.intercept(tool, argsFor(tool), undefined, T0);

      if (outcome.kind !== "proceed") {
        report.push(`${tool.name}: first call was ${outcome.kind}, expected proceed`);
        continue;
      }
      if (outcome.confirmationConsumed) {
        report.push(`${tool.name}: claimed to consume a confirmation it never issued`);
      }
      // Nothing to render to the caller, so no prompt reaches the user.
      if (interceptOutcomeToToolResult(tool, outcome) !== null) {
        report.push(`${tool.name}: produced a refusal payload`);
      }
      // And no unredeemable token was left behind.
      if (interceptor.tokens.size() !== 0) {
        report.push(`${tool.name}: minted ${interceptor.tokens.size()} token(s)`);
      }
    }

    expect(report, `route-owned interference:\n${report.join("\n")}`).toEqual([]);
  });

  it("still refuses a route-owned tool the DENY TIER objects to (WARP-2472)", () => {
    // The ownership skip must sit BELOW the deny tier. There is no
    // approval — from any layer — that makes a blocked action allowed, so
    // delegating the confirmation must not delegate the refusal.
    //
    // Mutation: move the `confirmationOwner === "route"` check above the
    // deny evaluation → red.
    const tool = ROUTE_OWNED[0]!;
    const interceptor = createToolCallInterceptor();
    interceptor.denyTier.add("warp-2472-fixture", () => ({
      code: "TEST_DENY",
      message: "denied by fixture",
    }));

    const outcome = interceptor.intercept(tool, argsFor(tool), undefined, T0);
    expect(outcome.kind).toBe("denied");
  });

  it("hands `confirmed: true` to exactly the interceptor-owned handlers whose schema declares it", () => {
    // This is the no-double-prompt MECHANISM. Detected from each tool's
    // own schema, so no parallel list of "legacy" tools exists to drift.
    const declaring = INTERCEPTOR_OWNED.filter(declaresConfirmedFlag);
    expect(declaring.length).toBeGreaterThan(0);

    for (const tool of declaring) {
      const interceptor = createToolCallInterceptor();
      const args = argsFor(tool);
      const first = interceptor.intercept(tool, args, undefined, T0);
      const token = first.kind === "confirmation_required" ? first.token : "";
      const second = interceptor.intercept(tool, args, { confirmationToken: token }, T0 + 1);

      expect(second.kind, tool.name).toBe("proceed");
      if (second.kind !== "proceed") continue;
      expect(second.args.confirmed, `${tool.name} must receive confirmed:true`).toBe(true);
      expect(second.confirmationConsumed).toBe(true);
    }
  });

  it("never fabricates `confirmed` for a tool whose schema does not declare it", () => {
    for (const tool of INTERCEPTOR_OWNED.filter((t) => !declaresConfirmedFlag(t))) {
      const interceptor = createToolCallInterceptor();
      const args = argsFor(tool);
      const first = interceptor.intercept(tool, args, undefined, T0);
      const token = first.kind === "confirmation_required" ? first.token : "";
      const second = interceptor.intercept(tool, args, { confirmationToken: token }, T0 + 1);

      if (second.kind !== "proceed") continue;
      // `additionalProperties: false` — we must not inject an unknown key.
      expect(second.args, tool.name).not.toHaveProperty("confirmed");
    }
  });

  it("completes the CHAT-SHAPED flow (confirmed:true, no token) for every legacy tool", () => {
    // This is the flow production actually performs: the model re-issues
    // with `confirmed: true` because it has no way to obtain a token.
    // If this regressed, every one of these tools would challenge forever
    // in the chat surface — the production break this guards.
    const declaring = INTERCEPTOR_OWNED.filter(declaresConfirmedFlag);
    const report: string[] = [];

    for (const tool of declaring) {
      const interceptor = createToolCallInterceptor();
      const args = argsFor(tool);

      const first = interceptor.intercept(tool, args, undefined, T0);
      if (first.kind !== "confirmation_required") {
        report.push(`${tool.name}: phase 1 did not challenge`);
        continue;
      }
      const second = interceptor.intercept(tool, { ...args, confirmed: true }, undefined, T0 + 1);
      if (second.kind !== "proceed") {
        report.push(`${tool.name}: phase 2 (confirmed:true) was ${second.kind}, expected proceed`);
      }
    }

    expect(report, `chat-flow failures:\n${report.join("\n")}`).toEqual([]);
    // 15, not 16: WARP-2472 moved `set_wifi_password` — the one
    // route-owned tool that also declares `confirmed` — out of this
    // partition. Its own handler gate is untouched and still runs.
    expect(declaring.length).toBeGreaterThanOrEqual(15);
  });

  it("refuses `confirmed: true` for every legacy tool when nothing challenged it", () => {
    // The security floor the legacy path must not give up: a bare boolean
    // is not an approval.
    for (const tool of INTERCEPTOR_OWNED.filter(declaresConfirmedFlag)) {
      const interceptor = createToolCallInterceptor();
      const outcome = interceptor.intercept(
        tool,
        { ...argsFor(tool), confirmed: true },
        undefined,
        T0,
      );
      expect(outcome.kind, `${tool.name} accepted an unchallenged confirmed:true`).toBe(
        "confirmation_required",
      );
    }
  });

  it("emits a machine-readable challenge for every interceptor-owned tool", () => {
    for (const tool of INTERCEPTOR_OWNED) {
      const interceptor = createToolCallInterceptor();
      const outcome = interceptor.intercept(tool, argsFor(tool), undefined, T0);
      const res = interceptOutcomeToToolResult(tool, outcome);
      expect(res, tool.name).not.toBeNull();
      expect(res!.ok).toBe(false);
      if (res!.ok) continue;
      expect(res!.status, tool.name).toBe("confirmation_required");
    }
  });
});

describe("provenance guard — the list must stay derived (WARP-2322)", () => {
  it("this file derives its tool list from the flag and contains no hardcoded roster", () => {
    // `__filename`, not `import.meta.url`: this package builds to CommonJS,
    // where `import.meta` is a TS1470 error (see the same note in
    // `tool-routes.test.ts`). Both spell "this file" and `vitest` defines
    // `__filename` in its CJS-interop module scope.
    const source = readFileSync(__filename, "utf8");

    // The derivation itself must be present.
    expect(source).toContain("filter((t) => t.requiresConfirmation)");

    // And the file must not have quietly grown a copy of the roster. A
    // handful of names appear legitimately in the targeted end-to-end
    // test below; a pasted list of 37 would blow straight past this.
    const quoted = CONFIRMING.filter((t) => source.includes(`"${t.name}"`));
    expect(
      quoted.length,
      `hardcoded confirming tool names found: ${quoted.map((t) => t.name).join(", ")}`,
    ).toBeLessThanOrEqual(3);
  });
});

/** Minimal ToolContext for the end-to-end handler run below. */
function memoryCtx(findUnique: Mock, update: Mock): ToolContext {
  return {
    prisma: { memoryFact: { findUnique, update } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    role: "owner",
    signal: new AbortController().signal,
  };
}

describe("end-to-end: a hand-rolled confirming handler prompts exactly once (WARP-2322)", () => {
  const fact = {
    id: "f1",
    category: "Tone",
    fact: "Prefers warm greetings",
    addedBy: "alice",
    addedAt: new Date("2026-05-28T12:00:00Z"),
    active: true,
    audience: "family",
  };

  it("memory_forget: interceptor challenges, handler never runs, then the write happens once", async () => {
    const interceptor = createToolCallInterceptor();
    const findUnique = vi.fn().mockResolvedValue(fact);
    const update = vi.fn().mockResolvedValue({ ...fact, active: false });
    const handler = vi.fn(memoryForget.handler);
    const args = { id: "f1" };
    let challenges = 0;

    // --- Phase 1: dispatch exactly as the mcp-server does.
    const first = interceptor.intercept(memoryForget, args, undefined, T0);
    const firstRefusal = interceptOutcomeToToolResult(memoryForget, first);
    if (firstRefusal && !firstRefusal.ok && firstRefusal.status === "confirmation_required") {
      challenges++;
    }
    // The handler is NOT invoked, so its own confirmationRequired() cannot
    // fire — the interceptor's challenge is the only one.
    expect(handler).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();

    // --- Phase 2: same call, with the token.
    const token = first.kind === "confirmation_required" ? first.token : "";
    const second = interceptor.intercept(memoryForget, args, { confirmationToken: token }, T0 + 1);
    expect(interceptOutcomeToToolResult(memoryForget, second)).toBeNull();
    expect(second.kind).toBe("proceed");
    if (second.kind !== "proceed") return;

    const result = await handler(second.args, memoryCtx(findUnique, update));

    // The handler's own gate did NOT raise a second prompt. Mutation:
    // stop setting `confirmed: true` on a verified call → this reds.
    if (!result.ok && result.status === "confirmation_required") challenges++;

    expect(challenges, "exactly one confirmation challenge end to end").toBe(1);
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: "f1" }, data: { active: false } });
  });

  it("and without the interceptor's normalisation the SAME handler prompts a second time", async () => {
    // Control, so the test above cannot be vacuously green: this is what
    // phase 2 looks like when `confirmed` is absent.
    const findUnique = vi.fn().mockResolvedValue(fact);
    const update = vi.fn();
    const res = await memoryForget.handler({ id: "f1" }, memoryCtx(findUnique, update));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe("confirmation_required");
    expect(update).not.toHaveBeenCalled();
  });
});
