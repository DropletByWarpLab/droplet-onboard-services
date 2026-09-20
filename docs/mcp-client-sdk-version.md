# The MCP SDK version the outbound client is built on

- **Ticket:** [WARP-2423](https://warp-lab.atlassian.net/browse/WARP-2423), under
  [WARP-2300](https://warp-lab.atlassian.net/browse/WARP-2300).
- **Governs:** [`docs/ADR-043-outbound-mcp-client.md`](ADR-043-outbound-mcp-client.md) §5's
  outbound client component (`services/mcp-bridge`).
- **Decided:** 2026-09-02.

## Decision

**Build the outbound client on `@modelcontextprotocol/sdk` `^1.30.0` — the version already
pinned on `stage` — and do not introduce a second SDK major into the tree.**

The server half (`services/mcp-server`) keeps its own `^1.30.0` pin untouched by this work.

## The premise the ticket was written on is false, and that is the whole answer

WARP-2423 asks us to choose "v1.30.0 vs v2". **There is no v2.** Probed against
`registry.npmjs.org` on 2026-09-02:

```
$ npm view @modelcontextprotocol/sdk dist-tags --json
{ "latest": "1.30.0" }
```

The published version list ends at `1.30.0`; the highest major ever published is `1`, and the
package's own `time.modified` is `2026-07-27`. So `1.30.0` is simultaneously the pin on
`stage`, the newest release, and `latest`. There is nothing to migrate to, nothing to
evaluate, and no compatibility matrix to reason about.

Recording it this way rather than closing the ticket silently is deliberate: the next person
to read the epic will otherwise re-open the same question, and "we looked, and v2 does not
exist" is a materially different answer from "we chose v1".

## What 1.30.0 actually gives the client half

The pin was installed for the server half and, as `INTEGRATIONS-TRACKER.md` §13.3 notes, is
"entirely unused" on the client side beyond the stdio child. What the outbound work needs is
present in the installed tree:

| Need | Where it lives in 1.30.0 |
|---|---|
| Streamable HTTP client transport | `@modelcontextprotocol/sdk/client/streamableHttp.js` |
| Per-request headers (the Atlassian `Authorization: Basic …` path) | `StreamableHTTPClientTransportOptions.requestInit` |
| Explicit session id | `StreamableHTTPClientTransportOptions.sessionId` |
| Bounded reconnection, no caller-run loop | `StreamableHTTPReconnectionOptions` |
| Injectable `fetch` (test doubles, no live calls) | `StreamableHTTPClientTransportOptions.fetch` |
| SSE transport, should a server only offer it | `@modelcontextprotocol/sdk/client/sse.js` |

Both halves sharing one major also keeps `npm ci` resolving a single copy: the server and the
bridge both hoist to the same `node_modules/@modelcontextprotocol/sdk`, so there is one
protocol-version constant in the process tree rather than two that can disagree.

## The trigger that revisits this

Re-open the question when **any one** of these is true — not on a schedule, and not because
the number moved:

1. **A `2.x` is published** (`npm view @modelcontextprotocol/sdk dist-tags` stops reporting
   `latest: 1.x`). At that point the question becomes real for the first time, and the
   decision to make is whether the two halves may straddle two majors — they should not.
2. **A remote server we are contracted to reach negotiates a protocol version 1.30.0 cannot
   speak.** That surfaces as the `protocol_mismatch` state in
   `services/mcp-bridge/src/session-state.ts`, which exists precisely so this arrives as an
   explicit enum value in a health payload rather than as an empty tool list.
3. **A security advisory lands against the pinned range.** Dependabot is the trigger, not a
   human re-reading this file.

Anything else — a new minor with features we do not use, a version drift alert, tidiness — is
not a trigger. The upgrade cost is not the bump; it is re-proving the stdio child, the
inbound HTTP transport and the outbound session all still agree, and that cost should be paid
for a reason from the list above.
