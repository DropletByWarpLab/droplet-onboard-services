# Tool confirmation enforcement contract (WARP-2305)

Status: **Accepted** — implemented by WARP-2305.
Owner: orchestrator / tools-core.

Droplet's product contract is *"reads run automatically, writes ask for a
thumbs-up, destructive actions are blocked."* This document defines the
mechanism behind the second and third clauses, so that 37 existing
hand-rolled handlers and an unbounded number of tools **we did not
author** can all agree on one contract.

Before this contract existed, `requiresConfirmation` was declarative
metadata that nothing enforced generically. `handlers/memory/forget.ts`
said so in the tree. Enforcement was 37 independent copies of a
four-line check, each correct only because a human remembered to write
it — and, as measured on `origin/stage` @ 01092f8e, **19 of the 37 did
not have one at all** (see §7).

---

## 1. Where enforcement lives

`services/mcp-server/src/server.ts` — the `CallToolRequestSchema`
handler — is the **only** place in the repository that invokes
`tool.handler(...)`. Verified:

```
$ grep -rn --include='*.ts' '\.handler(' apps/orchestrator/src services/mcp-server/src packages/tools-core/src
services/mcp-server/src/server.ts:159:      result = await tool.handler(args, ctx);
```

Every dispatch path funnels through it:

| Caller | Path to the handler |
| --- | --- |
| Agent loop (`llm-agent.service.ts`) | `deps.mcp.callTool` → MCP stdio → `CallToolRequestSchema` |
| ToolSpec runs, `/api/llm/*` routes | same `McpClientService` |
| External MCP clients | HTTP transport → same `CallToolRequestSchema` |

Intercepting there therefore covers the in-process and the
external-MCP-client paths with **one** implementation, which is what
keeps the two from drifting. The interceptor *logic* lives in
`packages/tools-core/src/interceptor.ts` so it is transport-agnostic and
unit-testable without a server; the mcp-server only calls it.

The interceptor runs **before** the handler. A refused call never
reaches handler code, so a handler with a side effect on its first line
is still safe.

## 2. What a confirmation is

A confirmation is a **token**, not a boolean.

A boolean the model sets on itself was never a control: the model is
steered by user-controlled prompt text (the ADR-004 threat model quoted
in `tool-access.service.ts`), so `confirmed: true` is an argument the
model can produce without a human ever seeing a prompt. The token is
minted by the interceptor, returned to the caller, and must come back.

A token is:

| Property | Value |
| --- | --- |
| Shape | 256 bits of `randomBytes`, base64url. Opaque to callers. |
| Bound to | tool name **and** a canonical hash of the arguments |
| TTL | `DEFAULT_CONFIRMATION_TTL_MS` = 5 minutes |
| Uses | exactly one; redeeming spends it |
| Storage | in-process, in the dispatching mcp-server |

## 3. The two-phase flow

**First call** — no token presented. The interceptor mints one, performs
**no write**, the handler never runs, and the caller receives:

```jsonc
{
  "status": "confirmation_required",
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "…relay to the user for approval…",
    "details": {
      "interceptor": {
        "outcome": "confirmation_required",
        "tool": "delete_file",
        "confirmationToken": "…",
        "expiresAt": 1787877383237
      }
    }
  }
}
```

**Confirming call** — the caller re-issues the *same* tool with the
*same* arguments and presents the token in the MCP `_meta` field:

```jsonc
{ "name": "delete_file", "arguments": { "path": "/x" },
  "_meta": { "confirmationToken": "…" } }
```

`_meta` is the transport's channel for protocol metadata that must not
be forwarded as tool arguments — the same channel `ncToken`, `userId`
and `_enhancement` already use. Putting the token there means it is
never subject to a tool's `additionalProperties: false` input schema,
and the argument hash is computed over untouched tool arguments.

If the token verifies, the interceptor spends it and the handler runs.

### The legacy confirming call — `confirmed: true`

The chat surface cannot carry a token back. `_meta` is set by the
orchestrator; the thing that re-issues a confirming call is the *model*,
and it only ever sees a tool's own input schema. Requiring the secret
there would make all 16 hand-rolled two-phase tools challenge forever —
a production break, and a violation of "all 37 still complete their
two-phase flow".

So a second confirming shape is accepted, for tools whose input schema
**declares `confirmed`** (i.e. the ones that already had a working
two-phase contract):

```jsonc
{ "name": "memory_forget", "arguments": { "id": "f1", "confirmed": true } }
```

This is accepted **only against a live challenge**. The interceptor must
have challenged this exact tool with these exact arguments, within the
TTL, and the challenge is spent on use. So:

- `confirmed: true` on a call nothing challenged is **refused**;
- a challenge for `delete_file("/tmp/x")` cannot approve
  `delete_file("/payroll")`;
- a challenge for one tool cannot approve another;
- one thumbs-up cannot drive two writes;
- an approval offered long after the challenge is refused.

It is **weaker than the token** and says so: it proves the call was
challenged, not that the approver held a secret — the model can emit the
boolean itself. It is **strictly stronger than what shipped before**,
which accepted the bare boolean with no challenge, no binding, no expiry
and no single-use.

**Tools with no handler-side gate get no legacy path.** The 8 registry
tools listed in §7 and every WARP-320 remote tool must present a real
token. Fail-closed is the correct direction for a write that nothing was
guarding.

Retiring the legacy path means giving the chat surface a way to return a
token from a human approval — see §13.

## 4. Argument binding

The binding hash is a SHA-256 over a canonical serialization
(`canonicalizeToolArgs`) that is:

- **stable under key ordering** — object keys are sorted recursively, so
  `{a:1,b:2}` and `{b:2,a:1}` produce the same token binding;
- **sensitive to values** — any changed value, added key or removed key
  produces a different hash and the token is refused;
- **order-preserving for arrays** — array order is semantic, so it is
  not sorted.

**One key is excluded: `confirmed`.** It is a control flag, never
payload. Excluding it is what lets the 37 legacy handlers keep working:
their tool descriptions tell the model to re-issue with
`confirmed: true`, which would otherwise change the hash and make every
confirming call fail as an argument mismatch.

## 5. Interaction with the 37 hand-rolled handlers (no double-prompt)

18 handlers call `confirmationRequired()` themselves; 16 of those gate
on `args.confirmed !== true`.

When the interceptor accepts a token for a tool whose input schema
**declares** a `confirmed` property, it sets `confirmed: true` on the
arguments passed to the handler. That is a factual statement, not a
bypass: it means *"a bound, unexpired, single-use confirmation for
exactly these arguments has been verified."* The handler's own check
then passes and does not raise a second prompt.

The resulting invariant, which holds for all 37:

- **Phase 1** — the interceptor challenges exactly once and the handler
  does not run, so no second challenge is even reachable.
- **Phase 2** — the interceptor is silent; the handler runs.

Exactly one challenge per two-phase flow, from the enforcement layer.

A handler may still return `confirmation_required` in phase 2 for
reasons of its own — `control_device` does this unconditionally for lock
commands, and the `passThroughConfirmation` handlers relay a `202` from
an orchestrator route that runs its own dashboard-driven gate. That is
pre-existing domain behaviour, deliberately unchanged by this work.

## 6. Tools with no handler of ours (WARP-320)

The contract is expressible entirely at the dispatch boundary. Nothing
in it requires handler cooperation:

- the flag is read from the tool descriptor, not from handler code;
- the challenge is produced by the interceptor;
- the token is verified by the interceptor;
- the handler is simply not called until it verifies.

A remote MCP tool that declares `requiresConfirmation` and ships no
confirmation logic is therefore gated identically to a local one. The
interceptor accepts any `InterceptableTool` — `{ name,
requiresConfirmation }` — so registry membership is not required.

## 7. Why this was urgent — measured, not asserted

On `origin/stage` @ 01092f8e, of the 37 tools declaring
`requiresConfirmation: true`:

- **18** call `confirmationRequired()` in their handler;
- **16** of the remaining 19 relay a `202` from an orchestrator route
  via `passThroughConfirmation` — enforcement exists, but one layer down
  and only for that route;
- **8** have no confirmation mechanism visible at the tool layer at all:
  `commission_device`, `email_send`, `pm_create_project`,
  `pm_create_work_item`, `pm_update_work_item`,
  `pm_add_work_item_comment`, `pm_transition_work_item`,
  `erp_schedule_appointment`.

`pm_create_project`'s own description says "Requires confirmation." Its
handler contained no confirmation code. The interceptor closes that
without touching any of the eight handlers — which is the proof that
enforcement is central.

## 8. Runtime deny tier (WARP-2328)

"Destructive actions are blocked" was implemented as *absence from*
`registry.ts` — a compile-time literal array, with no `register()`.
That is a good control for tools we choose never to write, and
`__tests__/storage-pool-tools.test.ts` remains its test. It has nothing
to say about a tool that exists at runtime.

The deny tier is a dispatch-time decision, evaluated **before** the
confirmation check, that can refuse a tool which *is* present.

**Its remit is deliberately narrow: runtime arrivals and runtime
conditions only.** It must not re-list what compile-time absence already
excludes — two mechanisms disagreeing about what "blocked" means would
be worse than one.

It ships **empty**. Deciding *which* actions are destructive is a human
decision and a separate ticket; this story builds the tier, not the
membership list.

## 9. Failure modes, each distinguishable

`redeem` returns one of five reasons, and each has its own test:

| Reason | Meaning |
| --- | --- |
| `unknown_token` | never minted, or already evicted |
| `already_used` | single-use property — the token was spent |
| `expired` | past its TTL |
| `wrong_tool` | minted for a different tool |
| `arguments_mismatch` | minted for different arguments |

A failed redeem does **not** spend the token, so a legitimate caller who
retries with corrected arguments is not locked out.

## 10. Expiry is lazy — there is no sweep to schedule

`redeem` checks the TTL on every call, so an expired token is refused
whether or not anything ever sweeps. The store additionally sweeps
expired entries opportunistically on `mint` and is bounded by
`maxEntries` (oldest-first eviction).

There is therefore **no scheduled sweep**, and no `while True`: nothing
in this contract needs `cron-runtime.service.ts` or `apscheduler`.
Correctness never depends on a timer firing.

## 11. Audit (WARP-2352)

Every confirmation challenge, every consumed confirmation and every
runtime deny writes exactly one activity row through the single writer
`activity.service.ts` `record()`.

The audit scope carries the **tool name and the outcome only — never
the arguments**. Tool arguments routinely carry customer content and, on
the ERP/health surfaces, PHI. The interceptor's `details.interceptor`
block is constructed from a fixed set of scalar fields, so PHI-freedom
is a property of the shape rather than of a redaction pass;
`lib/log-redaction.ts` remains the backstop, not the design.

A first-call challenge (`confirm_required`) is a distinct audit action
from a runtime deny (`runtime_deny`) and from a consumed confirmation
(`confirm_consumed`).

## 12. For tool authors

You do **not** need to write confirmation code. Set
`requiresConfirmation: true` in the registry and the interceptor does
the rest.

Handler-side `confirmationRequired()` calls are still supported and
still run — use one when the *decision* is domain-specific (a lock
command, a fact whose text must be echoed for the user to approve it).
Do not write one merely to satisfy `requiresConfirmation`; that is what
produced 37 copies of the same four lines.

The one case that needs a second declaration: if your handler relays a
`202` from an orchestrator route that gates the operation itself, set
`confirmationOwner: "route"` so the user is asked once, by that route.
§13 has the rule and the gate that enforces it.

See `packages/tools-core/src/confirmation.ts` and
`packages/tools-core/src/interceptor.ts`.

## 13. Who asks — `confirmationOwner` (WARP-2472)

`requiresConfirmation: true` says a human must approve the write. It
does **not** say which layer asks, and for ten tools the answer is not
this interceptor.

Those tools relay a `202` from an orchestrator route that runs its own
Tier-2 gate (`apps/orchestrator/src/config/network-safety-rules.ts`).
When the interceptor also challenged them, the user was asked twice for
one action — and the route's challenge is the one the model cannot
answer: it carries the **route's** token, redeemable only at
`/api/network/command/confirm` / `/api/switch/command/confirm`, which
`tool-routes.ts` marks `dashboardOnly`. `share_clip` goes further and
`403`s the `_service:mcp` principal on its inline confirm path on purpose
(`cameras.ts:574-578`) — an agent re-presenting the token it was just
handed is the agent approving its own write. Net effect in chat: *"Block
AA:BB:CC:DD:EE:FF?"* → **yes** → *"This action requires user confirmation
in the Droplet dashboard."* → device not blocked.

So the tool descriptor declares the owner:

| value | meaning |
|---|---|
| `"interceptor"` (default) | this interceptor challenges, mints the token, and runs the handler only once it comes back |
| `"route"` | the orchestrator route already answers `202` for this operation, with its own token and its own redemption path; the interceptor **stands down** so that route is the single gate |

Rules that make this safe:

- It is a **skip, never a forward.** Nothing of ours is handed to the
  route, because `evaluateNetworkCommand`
  (`services/network-safety.service.ts:49-60`) accepts no confirmation
  input at all — no token, no `confirmed` flag. There is no "forward the
  interceptor's token" option; that fix has no target.
- The skip sits **below** the runtime deny tier. No approval, from any
  layer, makes a blocked action allowed.
- `confirmationConsumed` stays `false`, so no audit row claims the
  interceptor approved anything (§11).
- `requiresConfirmation` stays `true` on route-owned tools. The flag
  describes the tool, not the mechanism, so `WRITE_TOOLS`, the catalog
  and the chat scope keep their meaning.
- Omitting the field means `"interceptor"`. Read it through
  `confirmationOwnerOf()` — the one place the default is applied. A tool
  that forgets to declare therefore keeps its gate; forgetting can never
  silently remove one.

`detect_wan_port` was the reverse defect and is fixed here too: it
declared `requiresConfirmation: false` while its route classified
`switch_wan_detect` as Tier 2 and answered `202`. It is now `true` +
`"route"`, so the flag stops lying and the tool appears in every
enumeration that derives from it.

**The drift gate.** A `"route"` declaration is a claim about a file in
another package, so it is checked at runtime rather than trusted:
`apps/orchestrator/src/__tests__/confirmation-owner-drift.guard.test.ts`
enumerates `requiresConfirmation` off the live registry, `passThroughConfirmation`
off each shipped `handler.toString()`, and the tier through
`classifyNetworkCommand` — then asserts every pass-through tool declares
the owner its route's tier implies. Adding a Tier-2 route to a tool that
has not declared `"route"` fails it.

## 14. The human approval round-trip in chat (WARP-2469, PR #1830)

Earlier revisions of this document recorded "no human approval
round-trip exists in chat" as a known gap. **That is no longer true.**

The round-trip is four arrows, three of them added by #1830:

1. the interceptor challenges (§3, unchanged);
2. the agent loop registers the challenge and renders an approval prompt;
3. the user approves via `POST /api/llm/confirm/:challengeId`;
4. the loop claims the grant and attaches the token on `_meta` for the
   model's re-issued call of the **same tool with the same arguments**.

**The token never reaches the browser.** The wire carries an opaque
`challengeId` that authorises nothing; the store keeps the token and
hands it out only after a human has moved the challenge to `approved`
through the role-gated route. Forwarding the raw token in the SSE
`tool_result` — which is what `interceptOutcomeToToolResult` puts at
`details.confirmationToken` — would make the approval authenticated by
whoever holds the stream, including a `guest`, who may approve nothing.
Where no approval store is wired (voice, ToolSpec runs) the chip
degrades to display-only rather than leaking.

Approval is role-gated twice: `requireRole("owner","admin","family")` at
registration, then `toolAllowedForTier` in the handler against the
challenge's actual tool — the same predicate the chat dispatch path uses,
so approval and execution cannot disagree.

`McpCallContext.confirmationToken` is still never set by the loop on its
own. A token becomes claimable **only** after a human acted; nothing the
model or the interceptor produces reaches the store by itself. That is
the same reasoning §3 gives, now with a human in the middle instead of a
missing arrow.

What remains open: the legacy `confirmed: true` acceptance (§3) is not
yet retired, so the hand-rolled two-phase tools still complete that way.
Route-owned tools (§13) never enter this flow at all — their approval
happens in the dashboard, on the route's own token.
