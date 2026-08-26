# Chat failure states Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface failed / aborted / interrupted / missing assistant turns when loading a persisted chat, with a Try-again affordance — instead of rendering empty bubbles or abruptly-ended chats.

**Architecture:** Server-side `ChatMessage.status` (already exists in Prisma) is now returned from `GET /api/llm/conversations/:id`. On load, the client maps each persisted status to a `failureKind` discriminator on the in-memory message, synthesizes a "missing reply" placeholder for tail-orphan user turns, and a new co-located `FailureChip` in `ChatMessage.tsx` renders four distinct variants — each with Try-again wired to the existing `retryMessage` path.

**Tech Stack:** TypeScript, React, Vitest, Prisma (no schema change), Express, Tailwind, lucide-react.

**Spec:** [docs/superpowers/specs/2026-05-14-chat-failure-states-design.md](../specs/2026-05-14-chat-failure-states-design.md)

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `apps/orchestrator/src/services/chat-persistence.service.ts` | Include `status` in `PersistedConversationDetail.messages[]`. | Modify |
| `apps/orchestrator/src/services/chat-persistence.service.test.ts` | Assert `status` is returned by `getConversationForUser`. | Modify |
| `apps/web-dashboard/src/lib/api.ts` | Add `status` to `PersistedConversation.messages[]` shape. | Modify |
| `apps/web-dashboard/src/lib/types.ts` | Add `failureKind` discriminator to `ChatMessage`. | Modify |
| `apps/web-dashboard/src/lib/hooks/useChat.ts` | Map `status` → `failureKind` in `loadConversation`; synthesize tail-orphan placeholder; generalize `retryMessage` to derive `retryPrompt` from preceding user message. | Modify |
| `apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx` | Add fixtures for each failure kind + tail-orphan + retry. | Modify |
| `apps/web-dashboard/src/components/ChatMessage.tsx` | Render `FailureChip` (co-located) for each `failureKind`; remove the italic "Stopped by you" paragraph. | Modify |
| `apps/web-dashboard/src/__tests__/components/ChatMessage.test.tsx` | Snapshot/behavior tests, one per `failureKind`, plus Try-again wiring. | Modify |
| `apps/web-dashboard/src/__tests__/chat-page.history-panel.test.tsx` | Integration test — load a conversation containing a failed turn, click Try-again, assert `sendChat` is called. | Modify |

The plan stays inside these files. No new files, no new components in their own modules, no schema migrations.

---

## Task 1: Return `status` from `getConversationForUser`

**Files:**
- Modify: `apps/orchestrator/src/services/chat-persistence.service.ts`
- Modify: `apps/orchestrator/src/services/chat-persistence.service.test.ts`

The persistence service already reads `status` off the row but discards it before returning. Surface it.

- [ ] **Step 1: Write the failing test**

Open `apps/orchestrator/src/services/chat-persistence.service.test.ts` and find the existing test block for `getConversationForUser`. Add this new test immediately after it (search for the line `it("getConversationForUser refuses cross-user reads"`):

```ts
it("getConversationForUser returns the status of each message", async () => {
  const { prisma } = makePrismaMock();
  const svc = new ChatPersistenceService(prisma as never);

  await prisma.chatSession.create({
    data: { userId: "alice", title: "T", model: "llama3", provider: "ollama" },
  });
  // Seed one message of each status so the mapping covers the enum.
  await prisma.chatMessage.create({
    data: {
      sessionId: "sess-1",
      role: "user",
      content: "hi",
      turnId: "t1",
      status: "completed",
    },
  });
  await prisma.chatMessage.create({
    data: {
      sessionId: "sess-1",
      role: "assistant",
      content: "hello",
      turnId: "t1",
      status: "completed",
    },
  });
  await prisma.chatMessage.create({
    data: {
      sessionId: "sess-1",
      role: "assistant",
      content: "",
      turnId: "t2",
      status: "failed",
    },
  });
  await prisma.chatMessage.create({
    data: {
      sessionId: "sess-1",
      role: "assistant",
      content: "partial",
      turnId: "t3",
      status: "aborted",
    },
  });
  await prisma.chatMessage.create({
    data: {
      sessionId: "sess-1",
      role: "assistant",
      content: "mid",
      turnId: "t4",
      status: "streaming",
    },
  });

  const detail = await svc.getConversationForUser("sess-1", "alice");
  expect(detail).not.toBeNull();
  expect(detail!.messages.map((m) => m.status)).toEqual([
    "completed",
    "completed",
    "failed",
    "aborted",
    "streaming",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:orchestrator -- chat-persistence.service.test --run`

Expected: FAIL — `messages[0].status` is `undefined` because the service doesn't return it.

- [ ] **Step 3: Modify the type to include `status`**

In `apps/orchestrator/src/services/chat-persistence.service.ts`, locate `PersistedConversationDetail` (around line 58) and add the `status` field:

```ts
export interface PersistedConversationDetail extends PersistedConversationSummary {
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls: PersistedToolCall[] | null;
    toolCallId: string | null;
    turnId: string | null;
    status: "pending" | "streaming" | "completed" | "failed" | "aborted";
    createdAt: string;
  }>;
}
```

- [ ] **Step 4: Wire `status` through `getConversationForUser`**

In the same file, locate `getConversationForUser` and update the `messages: row.messages.map(...)` block (around line 106) to include `status`:

```ts
messages: row.messages.map((m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  toolCalls: (m.toolCalls as unknown as PersistedToolCall[] | null) ?? null,
  toolCallId: m.toolCallId,
  turnId: m.turnId,
  status: m.status as "pending" | "streaming" | "completed" | "failed" | "aborted",
  createdAt: m.createdAt.toISOString(),
})),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:orchestrator -- chat-persistence.service.test --run`

Expected: PASS. All other tests in the file still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/chat-persistence.service.ts \
        apps/orchestrator/src/services/chat-persistence.service.test.ts
git commit -m "feat(orchestrator): return ChatMessage.status from getConversationForUser"
```

---

## Task 2: Mirror the wire shape on the client

**Files:**
- Modify: `apps/web-dashboard/src/lib/api.ts`

`PersistedConversation` in `api.ts` is the dashboard's wire-shape mirror. Add `status` so TypeScript surfaces the new field at call sites.

- [ ] **Step 1: Add `status` to `PersistedConversation.messages[]`**

In `apps/web-dashboard/src/lib/api.ts`, locate `PersistedConversation` (around line 1336) and add a `status` field inside the `messages` array element:

```ts
export interface PersistedConversation {
  id: string;
  title: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls:
      | Array<{
          id: string;
          name: string;
          args: Record<string, unknown>;
          ok?: boolean;
          status?: string;
          message?: string;
          data?: unknown;
        }>
      | null;
    toolCallId: string | null;
    turnId: string | null;
    /**
     * WARP-XXX: lifecycle status of the persisted row. The client uses
     * it to drive failureKind on reloaded messages. Optional because
     * older orchestrator builds didn't return it; treat missing as
     * `completed` defensively.
     */
    status?: "pending" | "streaming" | "completed" | "failed" | "aborted";
    createdAt: string;
  }>;
}
```

- [ ] **Step 2: Verify the file typechecks**

Run: `npm run build --workspace=@droplet/web-dashboard 2>&1 | head -40` (or your repo's per-workspace typecheck — adjust to the existing scripts in `apps/web-dashboard/package.json`).

Expected: no new TS errors. If your repo uses `tsc --noEmit` for typecheck, run that instead.

- [ ] **Step 3: Commit**

```bash
git add apps/web-dashboard/src/lib/api.ts
git commit -m "feat(web-dashboard): mirror ChatMessage.status on PersistedConversation"
```

---

## Task 3: Add `failureKind` to the client `ChatMessage` type

**Files:**
- Modify: `apps/web-dashboard/src/lib/types.ts`

- [ ] **Step 1: Add the discriminator field**

In `apps/web-dashboard/src/lib/types.ts`, locate `ChatMessage` (around line 20) and append the new field after `citations` (before the closing `}`):

```ts
export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  /** Tool dispatches surfaced on this assistant turn (if any). */
  toolCalls?: ChatToolCall[];
  /**
   * Set on an assistant message when the turn failed (network error,
   * ai-gateway down, MCP child crashed, model returned `stop_reason:
   * "error"`). The UI renders a friendly message + retry button rather
   * than the raw error string. `retryPrompt` is the user prompt that
   * drove this turn — clicking retry re-sends it.
   */
  error?: { message: string; retryPrompt: string };
  /**
   * Set on an assistant message when the user clicked the Stop button
   * mid-stream (WARP-295). Distinct from `error`: stopping is intentional,
   * the partial content is kept verbatim, and the UI tags the bubble with
   * a plain "Stopped by you" marker rather than an error chrome.
   */
  stopped?: boolean;
  /**
   * Citations attached to this assistant turn — extracted from
   * retrieval-tool results during the stream (WARP-295). Rendered as
   * `<CitationChip>` chips below the message bubble.
   */
  citations?: ChatCitation[];
  /**
   * Set when an assistant message rehydrated from history did not finish
   * cleanly. Drives the FailureChip variant in <ChatMessage>.
   *   - "failed"       — server-side error (status=failed)
   *   - "aborted"      — user-cancelled mid-stream (status=aborted)
   *   - "interrupted"  — server died mid-stream (status=streaming on load)
   *   - "missing"      — synthetic placeholder for a tail-orphan user turn
   *                      whose assistant row was never persisted
   * Live-streaming turns continue to use `error` / `stopped`; this field
   * is populated exclusively by `loadConversation`.
   */
  failureKind?: "failed" | "aborted" | "interrupted" | "missing";
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-dashboard/src/lib/types.ts
git commit -m "feat(web-dashboard): add failureKind discriminator to ChatMessage"
```

---

## Task 4: Map `status` → `failureKind` in `loadConversation` (no synthesis yet)

**Files:**
- Modify: `apps/web-dashboard/src/lib/hooks/useChat.ts`
- Modify: `apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx`

- [ ] **Step 1: Write the failing test**

In `apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx`, add a new test inside the same `describe` block as the existing `loadConversation populates messages and pins the conversationId` test:

```tsx
it("loadConversation maps server status to failureKind on assistant messages", async () => {
  mockFetchConversation.mockResolvedValueOnce({
    id: "conv-statuses",
    title: "Various failures",
    model: "llama3",
    provider: "ollama",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { id: "u1", role: "user", content: "ok turn", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
      { id: "a1", role: "assistant", content: "fine", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
      { id: "u2", role: "user", content: "boom turn", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
      { id: "a2", role: "assistant", content: "", toolCalls: null, toolCallId: null, turnId: "t2", status: "failed", createdAt: new Date().toISOString() },
      { id: "u3", role: "user", content: "stop turn", toolCalls: null, toolCallId: null, turnId: "t3", status: "completed", createdAt: new Date().toISOString() },
      { id: "a3", role: "assistant", content: "partial", toolCalls: null, toolCallId: null, turnId: "t3", status: "aborted", createdAt: new Date().toISOString() },
      { id: "u4", role: "user", content: "crash turn", toolCalls: null, toolCallId: null, turnId: "t4", status: "completed", createdAt: new Date().toISOString() },
      { id: "a4", role: "assistant", content: "mid", toolCalls: null, toolCallId: null, turnId: "t4", status: "streaming", createdAt: new Date().toISOString() },
    ],
  });

  let probe: ProbeValue;
  render(<Probe onValue={(v) => (probe = v)} />);

  await act(async () => {
    await probe!.loadConversation("conv-statuses");
  });

  expect(probe!.messages).toHaveLength(8);
  expect(probe!.messages[1]).toMatchObject({ id: "a1", failureKind: undefined });
  expect(probe!.messages[3]).toMatchObject({ id: "a2", failureKind: "failed" });
  expect(probe!.messages[5]).toMatchObject({
    id: "a3",
    failureKind: "aborted",
    content: "partial",
  });
  expect(probe!.messages[7]).toMatchObject({
    id: "a4",
    failureKind: "interrupted",
    content: "mid",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=@droplet/web-dashboard -- useChat.conversationId.test --run`

Expected: FAIL — `failureKind` is undefined on every message.

- [ ] **Step 3: Implement the status → failureKind mapping**

In `apps/web-dashboard/src/lib/hooks/useChat.ts`, locate `loadConversation` (around line 874) and update the message-rebuild loop. Replace the existing `for (const m of persisted.messages)` block with:

```ts
const rebuilt: ChatMessage[] = [];
for (const m of persisted.messages) {
  if (m.role !== "user" && m.role !== "assistant") continue;
  const failureKind: ChatMessage["failureKind"] =
    m.role === "assistant"
      ? m.status === "failed"
        ? "failed"
        : m.status === "aborted"
          ? "aborted"
          : m.status === "streaming"
            ? "interrupted"
            : undefined
      : undefined;
  rebuilt.push({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    ...(m.role === "assistant" && m.toolCalls?.length
      ? {
          toolCalls: m.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            args: c.args,
            ok: c.ok,
            status: c.status,
            message: c.message,
            data: c.data,
          })),
        }
      : {}),
    ...(failureKind ? { failureKind } : {}),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace=@droplet/web-dashboard -- useChat.conversationId.test --run`

Expected: PASS. The pre-existing `loadConversation populates messages…` test still passes (it never asserted `failureKind`, so the optional-spread keeps it absent for `completed` rows).

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/useChat.ts \
        apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx
git commit -m "feat(web-dashboard): map persisted status to failureKind on load"
```

---

## Task 5: Synthesize a placeholder for a tail-orphan user message

**Files:**
- Modify: `apps/web-dashboard/src/lib/hooks/useChat.ts`
- Modify: `apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx`

A user message at the end of the persisted list with no assistant follow-up gets a synthetic assistant placeholder appended.

- [ ] **Step 1: Write the failing test**

Append this test to the same `describe` block:

```tsx
it("loadConversation synthesizes a missing-reply placeholder for a tail-orphan user message", async () => {
  mockFetchConversation.mockResolvedValueOnce({
    id: "conv-orphan",
    title: "Orphan",
    model: "llama3",
    provider: "ollama",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { id: "u1", role: "user", content: "first", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
      { id: "a1", role: "assistant", content: "reply", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
      { id: "u2", role: "user", content: "no reply ever came", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
    ],
  });

  let probe: ProbeValue;
  render(<Probe onValue={(v) => (probe = v)} />);

  await act(async () => {
    await probe!.loadConversation("conv-orphan");
  });

  expect(probe!.messages).toHaveLength(4);
  expect(probe!.messages[3]).toMatchObject({
    id: "missing-after-u2",
    role: "assistant",
    content: "",
    failureKind: "missing",
  });
});

it("loadConversation does NOT synthesize a placeholder mid-conversation orphan", async () => {
  // user → user → assistant: the first orphan is mid-stream. Per spec
  // we only synthesize for TAIL orphans.
  mockFetchConversation.mockResolvedValueOnce({
    id: "conv-mid-orphan",
    title: "Mid orphan",
    model: "llama3",
    provider: "ollama",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { id: "u1", role: "user", content: "first", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
      { id: "u2", role: "user", content: "second", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
      { id: "a2", role: "assistant", content: "reply", toolCalls: null, toolCallId: null, turnId: "t2", status: "completed", createdAt: new Date().toISOString() },
    ],
  });

  let probe: ProbeValue;
  render(<Probe onValue={(v) => (probe = v)} />);

  await act(async () => {
    await probe!.loadConversation("conv-mid-orphan");
  });

  expect(probe!.messages).toHaveLength(3);
  expect(probe!.messages.find((m) => m.failureKind === "missing")).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace=@droplet/web-dashboard -- useChat.conversationId.test --run`

Expected: both new tests FAIL — no placeholder is synthesized.

- [ ] **Step 3: Implement tail-orphan synthesis**

In `apps/web-dashboard/src/lib/hooks/useChat.ts`, inside `loadConversation`, after the existing `for (const m of persisted.messages)` block (the one you edited in Task 4) and *before* `setMessages(rebuilt)`, add:

```ts
// Tail-orphan: a user message at the END of the persisted list with no
// assistant follow-up — usually a server crash after the user row was
// committed but before the assistant row was created. Synthesize a
// placeholder so the UI can offer Try-again rather than ending the chat
// abruptly. Mid-conversation orphans are skipped on purpose (would
// inject a duplicate turn mid-thread on retry).
const tail = rebuilt[rebuilt.length - 1];
if (tail && tail.role === "user") {
  rebuilt.push({
    id: `missing-after-${tail.id}`,
    role: "assistant",
    content: "",
    failureKind: "missing",
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace=@droplet/web-dashboard -- useChat.conversationId.test --run`

Expected: PASS for both new tests. All existing tests in the file still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/useChat.ts \
        apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx
git commit -m "feat(web-dashboard): synthesize missing-reply placeholder for tail-orphan user turns"
```

---

## Task 6: Generalize `retryMessage` to handle `failureKind`

**Files:**
- Modify: `apps/web-dashboard/src/lib/hooks/useChat.ts`
- Modify: `apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx`

Today `retryMessage` requires `target.error.retryPrompt`. For history-loaded failures the prompt isn't carried on the row — derive it from the preceding user message.

- [ ] **Step 1: Write the failing test**

Append this test to the same `describe` block:

```tsx
it("retryMessage drops the failed assistant + preceding user and re-sends, using failureKind-derived prompt", async () => {
  mockFetchConversation.mockResolvedValueOnce({
    id: "conv-retry",
    title: "Retry me",
    model: "llama3",
    provider: "ollama",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { id: "u1", role: "user", content: "the original prompt", toolCalls: null, toolCallId: null, turnId: "t1", status: "completed", createdAt: new Date().toISOString() },
      { id: "a1", role: "assistant", content: "", toolCalls: null, toolCallId: null, turnId: "t1", status: "failed", createdAt: new Date().toISOString() },
    ],
  });
  // sendChat returns a stream that ends immediately so retry resolves.
  mockSendChat.mockResolvedValue({
    headers: new Headers({ "x-conversation-id": "conv-retry" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`),
        );
        controller.close();
      },
    }),
  });

  let probe: ProbeValue;
  render(<Probe onValue={(v) => (probe = v)} />);

  await act(async () => {
    await probe!.loadConversation("conv-retry");
  });

  expect(probe!.messages[1].failureKind).toBe("failed");

  await act(async () => {
    await probe!.retryMessage("a1", "llama3");
  });

  expect(mockSendChat).toHaveBeenCalledTimes(1);
  const sendArgs = mockSendChat.mock.calls[0][0];
  // The replay messages should END with the re-sent user turn —
  // confirming we derived the prompt from u1.
  expect(sendArgs.messages.at(-1)).toEqual({
    role: "user",
    content: "the original prompt",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=@droplet/web-dashboard -- useChat.conversationId.test --run`

Expected: FAIL — `retryMessage` early-returns because `target.error` is undefined; `sendChat` is never called.

- [ ] **Step 3: Generalize `retryMessage`**

In `apps/web-dashboard/src/lib/hooks/useChat.ts`, locate `retryMessage` (around line 786) and replace it with:

```ts
const retryMessage = useCallback(
  async (messageId: string, model: string, systemPrompt?: string) => {
    const snapshot = messagesRef.current;
    const idx = snapshot.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const target = snapshot[idx];
    // Derive the prompt to re-send. Live failures carry retryPrompt on
    // the error field; history-loaded failures (failureKind) don't, so
    // fall back to the preceding user message's content.
    let retryPrompt: string | null = null;
    if (target.error) {
      retryPrompt = target.error.retryPrompt;
    } else if (target.failureKind) {
      const prev = idx > 0 ? snapshot[idx - 1] : null;
      if (prev && prev.role === "user") retryPrompt = prev.content;
    }
    if (retryPrompt == null) return;

    // Drop the failed assistant + the user turn immediately before it
    // so the new turn replays a clean thread.
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === messageId);
      if (i === -1) return prev;
      const userIdx = i > 0 && prev[i - 1].role === "user" ? i - 1 : i;
      return prev.filter((_, k) => k !== i && k !== userIdx);
    });

    await sendMessage(retryPrompt, model, systemPrompt);
  },
  [sendMessage],
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace=@droplet/web-dashboard -- useChat.conversationId.test --run`

Expected: PASS. Confirm the existing `retryMessage` test elsewhere (if any) — e.g. in `useChat.test.tsx` — still passes:

Run: `npm run test --workspace=@droplet/web-dashboard -- useChat.test --run`

Expected: PASS. The live-error path still hits the `target.error` branch.

- [ ] **Step 5: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/useChat.ts \
        apps/web-dashboard/src/__tests__/lib/useChat.conversationId.test.tsx
git commit -m "feat(web-dashboard): retryMessage derives prompt from preceding user turn for failureKind"
```

---

## Task 7: Render `FailureChip` in `ChatMessage.tsx`

**Files:**
- Modify: `apps/web-dashboard/src/components/ChatMessage.tsx`

Replace the inline error block and remove the italic "Stopped by you" paragraph. A new co-located `FailureChip` renders all four variants.

- [ ] **Step 1: Update the imports**

In `apps/web-dashboard/src/components/ChatMessage.tsx`, replace the lucide-react import block (around line 4-16) with:

```tsx
import {
  Bot,
  User,
  Wrench,
  Loader2,
  Check,
  AlertTriangle,
  ShieldAlert,
  RefreshCcw,
  Copy as CopyIcon,
  Quote as QuoteIcon,
  RotateCcw,
  StopCircle,
  Ghost,
} from "lucide-react";
```

- [ ] **Step 2: Compute `failureKind` and remove the old derivations**

Inside the `ChatMessage` component body, locate the derivations block (the `isUser`, `toolCalls`, `hasToolCalls`, `hasError`, `isStopped` lines around line 51-57) and replace it with:

```tsx
const isUser = message.role === "user";
const toolCalls = message.toolCalls;
const hasToolCalls = !isUser && toolCalls && toolCalls.length > 0;
// failureKind unifies live and loaded failure states. Live errors map
// to "failed"; live stops map to "aborted". For loaded messages the
// hook sets failureKind directly.
const failureKind: ChatMessageType["failureKind"] | undefined = !isUser
  ? message.failureKind
    ?? (message.error ? "failed" : undefined)
    ?? (message.stopped ? "aborted" : undefined)
  : undefined;
const hasFailure = Boolean(failureKind);
const citations = !isUser ? message.citations : undefined;
const hasCitations = Boolean(citations && citations.length > 0);
const showToolbar =
  !isUser && !isStreaming && (Boolean(onCopy) || Boolean(onQuote) || Boolean(onRegenerate));
```

- [ ] **Step 3: Replace the error block with `FailureChip`**

Locate the `{hasError && (...)}` block inside the assistant bubble JSX (around line 150-173) and replace it with:

```tsx
{hasFailure && (
  <FailureChip
    kind={failureKind!}
    liveErrorMessage={message.error?.message}
    canRetry={Boolean(onRetry)}
    onRetry={() => onRetry?.(message.id)}
  />
)}
```

- [ ] **Step 4: Remove the italic "Stopped by you" paragraph**

Find the `{isStopped ? (` block below the bubble (around line 222-226) and delete it entirely. Also delete the now-unused `isStopped` reference if any remains. The aborted chip subsumes this affordance.

- [ ] **Step 5: Add the `FailureChip` component**

At the bottom of `ChatMessage.tsx`, before the existing `ToolCallChip` function, add:

```tsx
/**
 * Failure-state chip for an assistant turn. Four variants:
 *
 *   - failed       — server-side error (live or loaded)
 *   - aborted      — user-cancelled (live or loaded). The bubble keeps
 *                    its partial content; this chip sits below it.
 *   - interrupted  — server died mid-stream. Loaded-only. Partial
 *                    content kept.
 *   - missing      — synthetic placeholder for an orphan user turn.
 *                    No bubble; just the chip.
 *
 * The Try-again link is rendered when `canRetry` is true and routes to
 * the parent's `onRetry`. The page wires that to useChat.retryMessage.
 */
function FailureChip({
  kind,
  liveErrorMessage,
  canRetry,
  onRetry,
}: {
  kind: NonNullable<ChatMessageType["failureKind"]>;
  liveErrorMessage?: string;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const variant = {
    failed: {
      Icon: AlertTriangle,
      copy:
        liveErrorMessage ??
        "Something went wrong on this turn.",
      tone: "bg-system-red/10 text-system-red",
    },
    aborted: {
      Icon: StopCircle,
      copy: "Stopped",
      tone: "bg-surface-tertiary text-label-secondary",
    },
    interrupted: {
      Icon: RotateCcw,
      copy: "Interrupted — the reply didn't finish.",
      tone: "bg-system-orange/12 text-system-orange",
    },
    missing: {
      Icon: Ghost,
      copy: "No reply was saved for this turn.",
      tone: "bg-surface-tertiary/40 text-label-tertiary border border-dashed border-separator",
    },
  }[kind];

  return (
    <div
      className={`flex items-start gap-2 p-2 rounded-lg type-caption-1 ${variant.tone}`}
      role="alert"
      data-failure-kind={kind}
    >
      <variant.Icon size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p>{variant.copy}</p>
        {canRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 inline-flex items-center gap-1 type-caption-1 font-medium
              hover:underline focus:outline-none focus:ring-2
              focus:ring-current/40 rounded-sm"
            aria-label="Try sending this message again"
          >
            <RefreshCcw size={12} />
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the typecheck**

Run: `npm run build --workspace=@droplet/web-dashboard 2>&1 | head -40` (or your repo's typecheck command).

Expected: no new TS errors. If you see "Cannot find name 'isStopped'", you missed a leftover reference — delete it.

- [ ] **Step 7: Run the existing ChatMessage tests**

Run: `npm run test --workspace=@droplet/web-dashboard -- ChatMessage.test --run`

Expected: PASS for the unmodified live-error test (FailureChip subsumes the old error block; `liveErrorMessage` carries the message through). The "Stopped by you" italic test (if present) will FAIL — it's expected; that affordance is replaced. We update that test in Task 8.

- [ ] **Step 8: Commit**

```bash
git add apps/web-dashboard/src/components/ChatMessage.tsx
git commit -m "feat(web-dashboard): render FailureChip for assistant turn failures"
```

---

## Task 8: Test all four `FailureChip` variants

**Files:**
- Modify: `apps/web-dashboard/src/__tests__/components/ChatMessage.test.tsx`

- [ ] **Step 1: Update or remove any "Stopped by you" test**

Open `apps/web-dashboard/src/__tests__/components/ChatMessage.test.tsx` and search for `"Stopped by you"`. If a test asserts that string, replace its body with:

```tsx
it("renders the aborted FailureChip when message.stopped is set (live abort)", () => {
  render(
    <ChatMessage
      message={{
        id: "m1",
        role: "assistant",
        content: "partial",
        stopped: true,
      }}
      onRetry={() => undefined}
    />,
  );
  expect(screen.getByText("Stopped")).toBeInTheDocument();
  expect(screen.queryByText(/Stopped by you/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Add a test per failure kind**

Append to the same describe block:

```tsx
describe("FailureChip", () => {
  const baseMsg = {
    id: "m1",
    role: "assistant" as const,
    content: "",
  };

  it.each([
    ["failed", "Something went wrong on this turn."],
    ["aborted", "Stopped"],
    ["interrupted", "Interrupted — the reply didn't finish."],
    ["missing", "No reply was saved for this turn."],
  ] as const)("renders the %s variant with the right copy", (kind, copy) => {
    render(
      <ChatMessage
        message={{ ...baseMsg, failureKind: kind }}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveAttribute("data-failure-kind", kind);
  });

  it("Try-again invokes onRetry with the message id", async () => {
    const onRetry = vi.fn();
    render(
      <ChatMessage
        message={{ ...baseMsg, failureKind: "failed" }}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /try sending this message again/i }),
    );
    expect(onRetry).toHaveBeenCalledWith("m1");
  });

  it("preserves partial content when failureKind is aborted or interrupted", () => {
    render(
      <ChatMessage
        message={{ ...baseMsg, content: "halfway through", failureKind: "interrupted" }}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText("halfway through")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveAttribute("data-failure-kind", "interrupted");
  });

  it("falls back to message.error.message for live-error copy", () => {
    render(
      <ChatMessage
        message={{
          ...baseMsg,
          error: { message: "Custom live error", retryPrompt: "x" },
        }}
        onRetry={() => undefined}
      />,
    );
    // failureKind is undefined; derivation should yield "failed" from
    // the error field, and the chip should use the custom copy.
    expect(screen.getByText("Custom live error")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveAttribute("data-failure-kind", "failed");
  });
});
```

Check the existing test file for the imports — you'll likely already have `render`, `screen`, `userEvent`, and `vi`. If `userEvent` isn't imported, add `import userEvent from "@testing-library/user-event";` at the top.

- [ ] **Step 3: Run the tests**

Run: `npm run test --workspace=@droplet/web-dashboard -- ChatMessage.test --run`

Expected: PASS for all four variants, the Try-again click, the partial-content preservation, and the live-error fallback.

- [ ] **Step 4: Commit**

```bash
git add apps/web-dashboard/src/__tests__/components/ChatMessage.test.tsx
git commit -m "test(web-dashboard): cover FailureChip variants + retry wiring"
```

---

## Task 9: Integration test — load + click Try-again

**Files:**
- Modify: `apps/web-dashboard/src/__tests__/chat-page.history-panel.test.tsx`

End-to-end through the page: navigate to a conversation containing a failed turn, see the chip, click Try-again, see `sendChat` fire.

- [ ] **Step 1: Add the failing test**

In `apps/web-dashboard/src/__tests__/chat-page.history-panel.test.tsx`, add this test inside the existing describe block:

```tsx
it("renders the FailureChip for a loaded failed turn and Try-again re-sends", async () => {
  fetchConversationMock.mockResolvedValueOnce({
    id: "conv-failed",
    title: "Failed",
    model: "llama3",
    provider: "ollama",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      {
        id: "u1",
        role: "user",
        content: "what time is it",
        toolCalls: null,
        toolCallId: null,
        turnId: "t1",
        status: "completed",
        createdAt: new Date().toISOString(),
      },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: null,
        toolCallId: null,
        turnId: "t1",
        status: "failed",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  sendChatMock.mockResolvedValue({
    headers: new Headers({ "x-conversation-id": "conv-failed" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`),
        );
        controller.close();
      },
    }),
  });

  renderChatPageAt("/chat?c=conv-failed"); // use the existing helper if present
  await waitFor(() =>
    expect(fetchConversationMock).toHaveBeenCalledWith("conv-failed"),
  );

  // Chip is visible.
  await waitFor(() =>
    expect(
      screen.getByText("Something went wrong on this turn."),
    ).toBeInTheDocument(),
  );

  await userEvent.click(
    screen.getByRole("button", { name: /try sending this message again/i }),
  );

  await waitFor(() => expect(sendChatMock).toHaveBeenCalledTimes(1));
  const replay = sendChatMock.mock.calls[0][0].messages;
  expect(replay.at(-1)).toEqual({ role: "user", content: "what time is it" });
});
```

If the existing file does not have a `renderChatPageAt` helper, look for how the existing tests in this file mount the page (they likely use `render(<ChatPage />)` after setting the URL search params on `window`). Match the pattern in this file — do not invent a new helper.

If `sendChatMock` doesn't exist yet in this file, search for `vi.mock(.*api.*)` near the top — it likely mocks `fetchConversation` only. Extend the mock to include `sendChat`:

```tsx
const fetchConversationMock = vi.fn();
const sendChatMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
    sendChat: (...a: unknown[]) => sendChatMock(...a),
  };
});
```

Reset both mocks in `beforeEach`.

- [ ] **Step 2: Run the test**

Run: `npm run test --workspace=@droplet/web-dashboard -- chat-page.history-panel.test --run`

Expected: PASS.

- [ ] **Step 3: Run the full web-dashboard test suite as a sanity check**

Run: `npm run test --workspace=@droplet/web-dashboard --run`

Expected: PASS. Watch for any regressions in tests that mounted the page without setting up `sendChatMock` — if you find any, the test in question may need to import the mock too, but most likely the existing setup already covers it (the chat page only calls `sendChat` on user action, not on mount).

- [ ] **Step 4: Commit**

```bash
git add apps/web-dashboard/src/__tests__/chat-page.history-panel.test.tsx
git commit -m "test(web-dashboard): integration test for FailureChip + Try-again"
```

---

## Task 10: Manual smoke test

**Files:** None (manual)

The CI tests cover the code paths; manual verification covers the visual output.

- [ ] **Step 1: Start the local stack**

Run from repo root:

```bash
npm run dev:docker
```

Wait until the dashboard responds at `http://localhost/` (or whatever host the stack uses for you).

- [ ] **Step 2: Seed a failed turn directly in the database**

The fastest way to produce a failed assistant row without contriving a crash is to set the status manually. From repo root:

```bash
docker compose -f docker/docker-compose.yml --env-file .env exec db \
  psql -U droplet -d droplet -c "
    INSERT INTO \"ChatSession\" (id, \"userId\", title, model, provider, \"createdAt\", \"updatedAt\")
    VALUES ('11111111-1111-1111-1111-111111111111', 'romain', 'Failure smoke', 'llama3', 'ollama', now(), now());
    INSERT INTO \"ChatMessage\" (id, \"sessionId\", role, content, \"turnId\", status, \"createdAt\")
    VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'user', 'this turn will fail', 'smoke-t1', 'completed', now()),
           ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'assistant', '', 'smoke-t1', 'failed', now()),
           ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'user', 'this one was aborted', 'smoke-t2', 'completed', now()),
           ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'assistant', 'half a reply', 'smoke-t2', 'aborted', now()),
           ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'user', 'crashed mid-stream', 'smoke-t3', 'completed', now()),
           ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'assistant', 'PWM is', 'smoke-t3', 'streaming', now()),
           ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'user', 'this user turn has no reply', 'smoke-t4', 'completed', now());
  "
```

The exact `\"userId\"` value must match an existing user — adjust if your dev user is not `romain`.

- [ ] **Step 2.5: Log in as the test user**

Open the dashboard in your browser. Log in with username `romain` / password `TestPass11!` (the test admin credentials Romain uses for manual verification).

- [ ] **Step 3: Open the seeded conversation**

Navigate to `http://localhost/chat?c=11111111-1111-1111-1111-111111111111` and verify each chip renders against the spec's `2026-05-14-chat-failure-states-mockup.html`:

- Turn 1 (failed): red AlertTriangle chip "Something went wrong on this turn." + Try again
- Turn 2 (aborted): partial bubble "half a reply" + grey StopCircle chip "Stopped" + Try again
- Turn 3 (interrupted): partial bubble "PWM is" + amber RotateCcw chip "Interrupted — the reply didn't finish." + Try again
- Turn 4 (missing reply): ghost dashed chip "No reply was saved for this turn." + Try again (no bubble above it)

- [ ] **Step 4: Click "Try again" on the failed turn and confirm the model retries**

Expected: the failed assistant row + its preceding user message are dropped from the visible thread; a fresh user bubble + streaming assistant bubble appear; the model responds.

- [ ] **Step 5: Clean up the seeded rows**

```bash
docker compose -f docker/docker-compose.yml --env-file .env exec db \
  psql -U droplet -d droplet -c "DELETE FROM \"ChatSession\" WHERE id = '11111111-1111-1111-1111-111111111111';"
```

- [ ] **Step 6: Final commit (if anything changed)**

Smoke testing usually changes nothing. If it did (e.g. you found a copy nit and fixed it):

```bash
git add -A
git commit -m "fix(web-dashboard): smoke-test polish on FailureChip"
```

Otherwise, no commit.

---

## Self-Review Notes

- **Spec coverage:** failed (Task 4, 7, 8), aborted (Task 4, 7, 8), interrupted (Task 4, 7, 8), missing (Task 5, 7, 8). Retry path: Task 6, integration Task 9. Server status return: Task 1. Type mirroring: Task 2, 3. Manual: Task 10. ✓
- **Placeholder scan:** none. Code blocks contain real code; commands are concrete; expected output is concrete.
- **Type consistency:** `failureKind` values (`"failed" | "aborted" | "interrupted" | "missing"`) match across types, tests, mapping, and component variants.
