# Chat failure states — design

**Date:** 2026-05-14
**Status:** Approved (pending implementation plan)
**Scope:** `apps/web-dashboard/src/app/chat` + `apps/orchestrator/src/services/chat-persistence.service.ts`

## Problem

Loading a persisted chat that contains a non-completed assistant turn renders nothing for that turn. The chat surface either shows an **empty bubble** or **ends abruptly on the user message**, with no indication that anything went wrong and no affordance to retry.

Affected cases (all silent today):

| Server `ChatMessage.status` | Visible symptom on load |
| --- | --- |
| `failed`    | Empty assistant bubble; no error chip; no retry |
| `aborted`   | Partial content shown but no "Stopped" tag, no retry |
| `streaming` (stale — server restarted mid-turn) | Indistinguishable from a real-but-terse reply |
| (assistant row missing entirely) | User turn shows; chat just ends there |

## Root cause

The server-side schema carries a `ChatMessageStatus` enum (`pending | streaming | completed | failed | aborted`) — see [`apps/orchestrator/prisma/schema.prisma`](../../../apps/orchestrator/prisma/schema.prisma) `ChatMessage.status`.

But:

1. `ChatPersistenceService.getConversationForUser` (`apps/orchestrator/src/services/chat-persistence.service.ts`) **does not include `status`** in the response. The `messages[]` map only returns `id`, `role`, `content`, `toolCalls`, `toolCallId`, `turnId`, `createdAt`.
2. `useChat.loadConversation` (`apps/web-dashboard/src/lib/hooks/useChat.ts`) only reads `content` and `toolCalls`. The hook's existing failure fields (`error`, `stopped`) are wired only into the **live** streaming path — they are never populated when rehydrating from history.
3. The `ChatMessage` component (`apps/web-dashboard/src/components/ChatMessage.tsx`) gates the rendered body on `message.content && …`. With empty content, nothing renders inside the bubble.

## Goal

Surface the four failure modes above with differentiated, recoverable UX. Every state carries a **Try again** button that re-sends the originating user prompt through the existing `retryMessage` path.

## UI / UX

For each failure mode, the **Today** column is what currently renders; the **Proposed** column is the target. The full interactive mockup lives in [`2026-05-14-chat-failure-states-mockup.html`](./2026-05-14-chat-failure-states-mockup.html) (same directory).

### 1 · Failed turn

> Agent loop errored server-side. `status = failed`.

| Today | Proposed |
| --- | --- |
| Empty assistant bubble. No indication, no retry. | Red `AlertTriangle` chip: **"Something went wrong on this turn."** + **Try again** link. |

Visual token: `bg-system-red/10 text-system-red` — same family as the existing live-error chip.

### 2 · Aborted turn

> User (or another tab) hit Stop. `status = aborted`. Partial content is preserved on the row.

| Today | Proposed |
| --- | --- |
| Partial text renders, but no "Stopped" tag and no retry (the existing italic "Stopped by you" marker only appears on a *live* abort). | Partial bubble **with trailing ellipsis** + grey chip: **"Stopped"** + **Try again** link. |

Visual token: `bg-surface-tertiary text-label-secondary` — neutral, not alarming.

### 3 · Interrupted turn (stale streaming)

> `status = streaming` with no live stream active for that row at load time. Indicates a server restart or crash mid-turn.

| Today | Proposed |
| --- | --- |
| Looks indistinguishable from a real-but-terse reply. The user has no idea the turn died. | Partial bubble **with trailing ellipsis** + amber chip: **"Interrupted — the reply didn't finish."** + **Try again** link. |

Visual token: `bg-system-orange/12 text-system-orange` — same family as the existing `confirmation_required` chip; signals "attention needed" without screaming "error".

Detection is purely client-side at load time: any row whose status is `streaming` when there is no in-flight stream targeting it is `interrupted`. No new server status is needed.

### 4 · Missing assistant reply

> User message persisted; the matching assistant row never made it into the database.

| Today | Proposed |
| --- | --- |
| Chat just ends on the user message. No follow-up at all. | Ghost-style dashed chip below a synthetic bot avatar: **"No reply was saved for this turn."** + **Try again** link. |

Visual token: `bg-surface-tertiary/40 text-label-tertiary` + `border-dashed` — visually distinguishes a synthetic placeholder from a real assistant row.

Detection: walk the persisted message list at load time. Any user message whose successor is **not** an assistant row (i.e. another user row, or end-of-list) gets a synthetic assistant placeholder appended in client memory.

## Architecture

Split between server (return status) and client (translate status → UX state on load). No new persistence; no new MQTT events; no schema migration.

```
Server                                Client
──────                                ──────
ChatMessage.status                    useChat.loadConversation()
  ┌── streaming                       ─ reads status from API
  ├── completed     ────────────►     ─ maps status → failureKind
  ├── failed                          ─ synthesizes a placeholder for
  └── aborted                           orphan user turns

GET /api/llm/conversations/:id        ChatMessage UI
  + include `status` per message      ─ renders by failureKind:
                                        failed | aborted | interrupted | missing
                                      ─ Try-again wires to existing retryMessage
```

## Data shape

### Server — `PersistedConversationDetail.messages[]`

One-line extension to the `.map()` in `ChatPersistenceService.getConversationForUser`:

```ts
messages: row.messages.map((m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  toolCalls: (m.toolCalls as unknown as PersistedToolCall[] | null) ?? null,
  toolCallId: m.toolCallId,
  turnId: m.turnId,
  createdAt: m.createdAt.toISOString(),
  status: m.status,  // NEW — already exists on the row
})),
```

The `PersistedConversationDetail` and `PersistedConversationSummary` TypeScript types gain a `status: ChatMessageStatus` field on each message.

### Client — `ChatMessage` type

Add **one** discriminator field to the client-side `ChatMessage` in `apps/web-dashboard/src/lib/types.ts`:

```ts
interface ChatMessage {
  // existing fields…
  failureKind?: "failed" | "aborted" | "interrupted" | "missing";  // NEW
}
```

The existing `error` and `stopped` fields stay as-is — they continue to drive the **live** streaming code path (no churn there). `failureKind` is populated exclusively by `loadConversation`. The renderer checks `failureKind` first, falls back to `error` / `stopped` for live turns.

## Client-side mapping at load

In `useChat.loadConversation`, after fetching the persisted conversation:

```
for each persisted message in order:
  if role === "assistant":
    map status →
      "completed" → no failureKind
      "failed"    → failureKind = "failed"
      "aborted"   → failureKind = "aborted"     (preserve content)
      "streaming" → failureKind = "interrupted" (preserve content)
      "pending"   → no failureKind              (reserved; not used today)
  if this is the LAST message in the list AND role === "user":
    synthesize a placeholder assistant message:
      {
        id: `missing-after-${userMessageId}`,
        role: "assistant",
        content: "",
        failureKind: "missing",
      }
```

The synthetic id is deterministic (`missing-after-<userMessageId>`) so React keys stay stable across re-renders.

**Why only the last orphan?** A mid-conversation orphan (user message followed by another user message with no assistant in between) would be rare data corruption — and retrying it would inject a duplicate turn mid-thread, which is hard to reason about. Restricting synthesis to the tail covers the realistic crash scenario (server died after persisting the user row, never wrote the assistant row) and keeps retry semantics clean.

## Retry plumbing

The existing `retryMessage(id, model, systemPrompt)` already has the right shape — drop the broken assistant + preceding user, re-send the prompt. Two small changes:

1. `retryMessage` currently requires `target.error.retryPrompt`. **Generalize**: if `failureKind` is set on the target, derive `retryPrompt` from the preceding user message's content (`messagesRef.current[idx - 1].content` when `role === "user"`).
2. Wire the **Try again** button on all four chip variants in `ChatMessage.tsx` to the existing `onRetry(messageId)` prop. No new prop, no new code path on the page.

For the **missing** case, the synthetic placeholder's id is what gets passed back to `retryMessage`. `retryMessage` finds the preceding user message and drops it; the synthetic assistant row gets filtered out of the replay path naturally because the drop-and-resend slice covers both.

## Rendering changes in `ChatMessage.tsx`

Today's `hasError = Boolean(message.error)` and `isStopped = Boolean(message.stopped)` derivations are augmented:

```ts
const failureKind = !isUser
  ? (message.failureKind
      ?? (message.error ? "failed" : undefined)
      ?? (message.stopped ? "aborted" : undefined))
  : undefined;
```

The error/stopped blocks are replaced with a single inline `FailureChip` (a private component co-located inside `ChatMessage.tsx`, no new file) that picks copy + token by `kind`:

| `kind` | Icon | Token | Copy |
| --- | --- | --- | --- |
| `failed` | `AlertTriangle` | `bg-system-red/10 text-system-red` | "Something went wrong on this turn." |
| `aborted` | `StopCircle` | `bg-surface-tertiary text-label-secondary` | "Stopped" |
| `interrupted` | `RotateCcw` | `bg-system-orange/12 text-system-orange` | "Interrupted — the reply didn't finish." |
| `missing` | `Ghost` | `bg-surface-tertiary/40 text-label-tertiary` + `border-dashed` | "No reply was saved for this turn." |

The chip carries the **Try again** link in all four variants. Today's italic `"Stopped by you"` paragraph is removed — the `aborted` chip subsumes it. Live-aborted and history-loaded-aborted now render identically (good — one mental model).

## Error handling

- **API failure when fetching status:** `fetchConversation` already returns `null` on any error; the page already strips the URL hash in that case. No change.
- **Server returns an unknown `status` string:** treat as `completed` (defensive — forward-compat with future enum values).
- **Retry on a missing-row synthetic:** `retryMessage` reads the preceding user message and re-sends. If somehow the preceding row is not a user message (data corruption), `retryMessage` no-ops — same as today's guard.
- **Concurrent live stream targeting an `interrupted` row:** `loadConversation` is only invoked when the user navigates to a conversation; the URL → state effect already guards against double-loading. If a stream is live for the conversation being loaded, the existing `streamingConversationId` decoupling preserves the live state and the load swaps to the persisted rows on top — same race we already accept.

## Testing

- **`chat-persistence.service` test** — extend `getConversationForUser` test to assert `status` is returned per message for each of `streaming` / `completed` / `failed` / `aborted`.
- **`useChat.loadConversation` test** — fixture with one of each status + an orphan user turn (no assistant after it). Assert resulting `messages[]` has correct `failureKind` flags and exactly one synthetic missing row with the deterministic id.
- **`ChatMessage` component tests** — one render test per `failureKind`. Assert the chip text matches the spec table, and assert clicking Try-again invokes `onRetry(message.id)`.
- **Page-level integration** — extend `chat-page.history-panel.test.tsx` (already loads a conversation) with a fixture containing a failed turn; assert the failed chip is rendered and Try-again triggers a fresh `sendChat` call.

## Out of scope

- **Live-streaming error surfacing.** Today's live error path is fine — this design only extends history-load handling.
- **Server-side cleanup of orphan `streaming` rows.** Detecting interrupted turns purely client-side is sufficient for the UX fix. A periodic janitor that flips orphan `streaming` rows to `failed` after some grace period is a separate piece of work.
- **Surfacing failure metadata in `ChatHistoryPanel`.** The sidebar today shows the title only; no failure indicator on the row. A "this chat has an unresolved failure" badge is a follow-up if it ever feels needed.
- **Telemetry / counters.** No new metrics for failure-state renders. The orchestrator already logs failed turns server-side.

## File touchpoints

- `apps/orchestrator/src/services/chat-persistence.service.ts` — return `status` on each message
- `apps/web-dashboard/src/lib/types.ts` — add `failureKind` to `ChatMessage`
- `apps/web-dashboard/src/lib/hooks/useChat.ts` — map status → `failureKind` in `loadConversation`; synthesize missing-row placeholder; generalize `retryMessage` retryPrompt derivation
- `apps/web-dashboard/src/components/ChatMessage.tsx` — render the four chip variants; wire Try-again
- Tests: `apps/orchestrator/src/services/__tests__/chat-persistence.service.test.ts`, `apps/web-dashboard/src/__tests__/lib/useChat.test.tsx`, `apps/web-dashboard/src/__tests__/components/ChatMessage.test.tsx`, `apps/web-dashboard/src/__tests__/chat-page.history-panel.test.tsx`
