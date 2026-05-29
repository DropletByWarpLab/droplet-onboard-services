# WARP-331 — Chat history panel + switcher

- **Date:** 2026-05-13
- **Jira:** [WARP-331](https://warp-lab.atlassian.net/browse/WARP-331)
- **Branch:** `worktree-WARP-331-chat-history-sidebar`
- **Builds on:** WARP-304 (conversation persistence), WARP-329 (save-on-send + turn-completed MQTT)

## Problem

On `https://localhost/chat` a user's past conversations never appear and there is no way to switch between chats. The orchestrator has persisted conversations since WARP-304 and saved turns on send since WARP-329, but the web dashboard was never wired to the list endpoint, so every visit feels like a brand-new chat.

The list endpoint `GET /api/llm/conversations` already exists (`apps/orchestrator/src/routes/llm.ts:508-526`) with a comment that literally reads *"Listing is exposed for the future sidebar"*. This spec describes that sidebar.

## Goal

Give the authenticated user a visible, persistent list of their conversations on `/chat`, with first-class affordances to switch, rename, and delete chats. Backend mostly already exists; this is primarily a frontend ticket plus one small new route for rename.

## Non-goals

- Archived / pinned state — `ChatSession` has no `archivedAt` or `status` column, and per the project's "no guessing" rule (`CLAUDE.md`) that state must be an explicit column. Tracked as a follow-up ticket.
- Full-text search across conversations.
- Cross-tab live new-conversation creation. The MQTT signal fires on **turn completion**, not on creation; in-tab optimistic insert is the v1 mechanism. Cross-tab observers pick up a new chat after the assistant replies.

## Architecture

A dedicated chat-history panel lives **inside** the `/chat` route as a 280px left column (the "Option B" layout from brainstorming). The global `Sidebar` is untouched. The panel renders conversations grouped by date with a "+ New chat" header, hover-revealed `⋯` for rename / delete, and infinite scroll. On `<lg` breakpoints it collapses into a header-triggered drawer that reuses the existing `<Dialog placement="right">` primitive (same primitive the bottom-tab "More" drawer already uses). The list refreshes optimistically on first send and reactively on the existing `droplet/chat/<userId>/turn-completed` MQTT signal.

## Backend changes (`apps/orchestrator`)

The list/load/delete endpoints already exist and need no changes:
- `GET /api/llm/conversations` — paginated list (`routes/llm.ts:508-526`).
- `GET /api/llm/conversations/:id` — load one (`routes/llm.ts:528-547`).
- `DELETE /api/llm/conversations/:id` — delete one (`routes/llm.ts:549-568`).

**One new endpoint** for rename:

```
PATCH /api/llm/conversations/:id
Body:    { "title": string }            // 1–64 chars after trim
200:     { "id": string, "title": string, "updatedAt": string }
400:     empty or oversize title
401:     unauthenticated (existing middleware)
404:     no row matches (id, userId)
```

- New service method `ChatPersistenceService#renameConversationForUser(id, userId, title)` (`apps/orchestrator/src/services/chat-persistence.service.ts`). Single Prisma update guarded by `userId`. Title is trimmed and clamped to 64 chars to match the existing auto-derive cap on `ChatSession.title`.
- No new column. No migration.
- RBAC unchanged: the new route is read-on-self (user can only rename rows where `userId` matches). Not in the orchestrator's `WRITE_TOOLS` set (that set is per-LLM-tool, not per-route).

## Frontend changes (`apps/web-dashboard`)

### New files

- `src/components/chat/ChatHistoryPanel.tsx` — the panel itself. Composes header (`+ New chat`), grouped rows, sentinel for infinite scroll, empty state, error state. Renders identically inside the drawer on mobile (just without the fixed 280px width).
- `src/components/chat/ChatHistoryRow.tsx` — one row. Truncated title, active-row highlight, hover `⋯` menu (Rename / Delete), inline-edit mode for rename, keyboard navigation (`Enter` to open, `F2` to rename, `Delete` to delete).
- `src/lib/hooks/useConversationList.ts` — fetches paginated conversations, exposes `{ groups, hasMore, loadMore, isLoading, error, optimisticInsert, applyTurnCompleted, rename, remove }`. Internally caches `Conversation[]` and re-groups on demand.
- `src/lib/dates.ts` (or extension to an existing util) — `groupConversationsByDate(now, items)` returns ordered groups: **Today / Yesterday / Previous 7 days / Previous 30 days / "May 2026" / "April 2026" / ...**, with month names from the user's locale.

### Modified files

- `src/lib/api.ts` — add `listConversations({ limit, offset })`, `deleteConversation(id)`, and `renameConversation(id, title)`. `fetchConversation` already exists at `api.ts:1364`.
- `src/app/chat/page.tsx` — wrap content in a two-column layout (`lg:flex` with the 280px panel + flex-1 message column). On `<lg` the panel is hidden and a `History` icon appears in the chat header to open the drawer.
- `src/lib/hooks/useChat.ts` — at the moment a new `conversationId` is minted (via the `X-Conversation-Id` response header on `POST /api/llm/chat`), call `optimisticInsert({ id, title: <first-user-message-slice-64>, updatedAt: now })` so the row appears immediately. When the existing turn-completed MQTT handler fires, call `applyTurnCompleted(id)` to soft-refetch that one row and pick up the server-derived title. Remove the obsolete *"WARP-104 / sidebar went away"* comment block at `useChat.ts:132-134` once shipped.

## Data flow

1. **Initial load.** `useConversationList` mounts → `GET /api/llm/conversations?limit=30&offset=0` → groups by date → renders.
2. **Infinite scroll.** `IntersectionObserver` on a sentinel at the list bottom fires `loadMore()` → `GET ?limit=30&offset=30` → appended and regrouped.
3. **Switch chat.** Click row → `router.push('/chat?c=<id>')` → existing `useChat` rehydrates via `GET /api/llm/conversations/:id`. Active highlight tracks `conversationId` from `useChat`.
4. **New chat.** "+ New chat" → `router.push('/chat')` (no `?c=`). Active highlight clears. On first send, `useChat` learns the new `id` from `X-Conversation-Id` and calls `optimisticInsert`.
5. **Title settling.** Server publishes `droplet/chat/<userId>/turn-completed` over MQTT when the assistant finishes. The existing `useChat` WebSocket subscription forwards this to `useConversationList.applyTurnCompleted(id)`, which refetches that one conversation's summary and updates the row in place.
6. **Rename.** `⋯` → Rename → row enters inline-edit (text input + ✓ / ✕). Submit → `PATCH /api/llm/conversations/:id` → optimistic update; on 4xx, revert + toast.
7. **Delete.** `⋯` → Delete → confirm modal (reuse `Dialog` primitive) → `DELETE /api/llm/conversations/:id` → optimistic remove; on error, restore + toast. If the deleted chat was the active one, redirect to `/chat`.

## Mobile (`<1024px`)

- Panel hidden. Chat header gains a `PanelLeftOpen` icon button (lucide).
- Click → opens `<Dialog placement="right">` containing the same `ChatHistoryPanel`. The fixed `lg:w-[280px]` constraint is dropped inside the drawer (fills drawer width).
- Drawer auto-closes after a row click so the user sees the chat they just switched to.

## Error & edge handling

- 401 from any list/load/rename/delete → existing `AuthGate` middleware redirects to login; no special UI needed.
- Empty list → centered empty state: *"No chats yet. Start by asking something below."*
- Load failure → small inline error with a Retry button. Chat itself stays usable.
- Stale `?c=<id>` deep link (deleted conversation) → existing `GET /:id` returns 404; `useChat` already handles it. Panel just doesn't highlight anything.
- Rename collision: no uniqueness constraint on `title`. Duplicates are allowed and shown as-is.
- Race: user types in the chat input before optimistic insert lands → no conflict; insert happens off the network response, not the keystroke.

## Testing

| Layer | Test | Tool |
|---|---|---|
| Frontend unit | `groupConversationsByDate` boundary cases — DST, month-rollover, locale months | Vitest |
| Frontend unit | `useConversationList` reducer — optimistic insert / apply-turn-completed / remove / rename optimistic + revert | Vitest |
| Frontend component | `ChatHistoryPanel` states — empty / loading / loaded / active-row / hover-menu / inline-rename / delete-confirm | Vitest + RTL |
| Frontend component | `ChatHistoryRow` keyboard nav — Enter / F2 / Delete | Vitest + RTL |
| Orchestrator | `PATCH /api/llm/conversations/:id` — happy path, 400 (empty title), 400 (oversize), 404 (other user), 401 (unauthed) | Vitest |
| Orchestrator | `renameConversationForUser` service unit | Vitest |
| End-to-end | Manual checklist in the PR description (send → row appears → open second tab → row appears → click row → rehydrates → rename → reload → persists → delete → row gone, active redirects to `/chat`) | Manual |

## File-level summary

| Layer | Path | Action |
|---|---|---|
| Backend route | `apps/orchestrator/src/routes/llm.ts` | + `PATCH /api/llm/conversations/:id` |
| Backend service | `apps/orchestrator/src/services/chat-persistence.service.ts` | + `renameConversationForUser` |
| Backend test | `apps/orchestrator/src/routes/__tests__/llm.test.ts` (or sibling) | + rename cases |
| Backend test | `apps/orchestrator/src/services/__tests__/chat-persistence.service.test.ts` | + rename unit |
| Frontend page | `apps/web-dashboard/src/app/chat/page.tsx` | two-column layout + drawer trigger |
| Frontend hook | `apps/web-dashboard/src/lib/hooks/useChat.ts` | optimistic insert + apply-turn-completed; remove WARP-104 comment |
| Frontend hook | `apps/web-dashboard/src/lib/hooks/useConversationList.ts` | new |
| Frontend api | `apps/web-dashboard/src/lib/api.ts` | + `listConversations`, `renameConversation`, ensure `deleteConversation` exists |
| Frontend component | `apps/web-dashboard/src/components/chat/ChatHistoryPanel.tsx` | new |
| Frontend component | `apps/web-dashboard/src/components/chat/ChatHistoryRow.tsx` | new |
| Frontend util | `apps/web-dashboard/src/lib/dates.ts` | + `groupConversationsByDate` |
| Frontend tests | colocated `__tests__/` next to each new file | new |

## Open questions

None. All decisions captured.
