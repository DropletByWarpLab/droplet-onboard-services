# WARP-331 Chat History Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent chat-history panel and switcher to `/chat`, with rename + delete, backed by the existing WARP-304/329 persistence layer plus one new `PATCH` endpoint.

**Architecture:** Backend gets one new route + service method for rename (the list/load/delete already exist). Frontend gets a 280px left-column `ChatHistoryPanel` mounted inside `/chat/page.tsx` (drawer on `<lg`), a `useConversationList` hook that paginates `GET /api/llm/conversations`, and wiring in `useChat` so the list updates optimistically when a new chat is started and reactively on `droplet/chat/<userId>/turn-completed` MQTT events.

**Tech Stack:** Node + Express + Prisma (orchestrator); Next.js 14 + React + Vitest + RTL + Tailwind + lucide-react (web-dashboard).

**Spec:** [docs/superpowers/specs/2026-05-13-warp-331-chat-history-sidebar-design.md](../specs/2026-05-13-warp-331-chat-history-sidebar-design.md)

---

## Conventions used in this plan

- All paths are repo-relative.
- Tests use `vitest`. Commands:
  - Orchestrator: `cd apps/orchestrator && npx vitest run <path>`
  - Dashboard: `cd apps/web-dashboard && npx vitest run <path>`
- Commit at the end of every task. Commit messages prefix with `WARP-331:`.
- Branch: `worktree-WARP-331-chat-history-sidebar` (already created).

---

## Task 1: Service method `renameConversationForUser`

**Files:**
- Modify: `apps/orchestrator/src/services/chat-persistence.service.ts` (add method near `deleteConversationForUser`, ~line 152)
- Modify: `apps/orchestrator/src/services/chat-persistence.service.test.ts` (extend existing `describe` block + mock)

**Behavior:**
- Accepts `(conversationId, userId, rawTitle)`. Trims `rawTitle`, rejects empty (`throw new Error("title_required")`), clamps to 64 chars. Updates the matching row scoped by `userId`. Returns the new title, or `null` if no row matched (used by the route to send 404). **Does not bump `updatedAt`** — rename is a metadata edit, not new activity.

- [ ] **Step 1.1: Extend the Prisma mock to support `findFirst` for rename + `update`-with-title**

In `apps/orchestrator/src/services/chat-persistence.service.test.ts`, the existing `chatSession.update` mock only handles `data: { updatedAt: Date }`. Widen it to also accept `data: { title: string }`:

```ts
    update: vi.fn(async (args: { where: { id: string }; data: { updatedAt?: Date; title?: string } }) => {
      const row = sessions.find((s) => s.id === args.where.id);
      if (!row) return null;
      if (args.data.updatedAt !== undefined) row.updatedAt = args.data.updatedAt;
      if (args.data.title !== undefined) row.title = args.data.title;
      return row;
    }),
```

Also add a `findFirst` overload that supports `where: { id, userId }` *with no `include`* (already covered by the existing mock at lines 38-47 — verify it still returns the row).

- [ ] **Step 1.2: Write failing tests for `renameConversationForUser`**

Append inside the existing `describe("ChatPersistenceService (WARP-304)", ...)` block in `chat-persistence.service.test.ts`:

```ts
  it("renameConversationForUser updates a row owned by the user and returns the trimmed title", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Old",
      model: null,
      provider: null,
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const result = await svc.renameConversationForUser("s1", "alice", "  Frigate ports  ");
    expect(result).toBe("Frigate ports");
    expect(sessions[0].title).toBe("Frigate ports");
    // updatedAt MUST NOT be bumped on rename.
    expect(sessions[0].updatedAt.getTime()).toBe(new Date(2026, 0, 1).getTime());
  });

  it("renameConversationForUser clamps to 64 chars", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const long = "x".repeat(200);
    const result = await svc.renameConversationForUser("s1", "alice", long);
    expect(result?.length).toBe(64);
    expect(sessions[0].title?.length).toBe(64);
  });

  it("renameConversationForUser rejects empty / whitespace-only titles", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s1",
      userId: "alice",
      title: "Old",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    await expect(svc.renameConversationForUser("s1", "alice", "   ")).rejects.toThrow(/title_required/);
    expect(sessions[0].title).toBe("Old"); // unchanged
  });

  it("renameConversationForUser returns null when row belongs to another user", async () => {
    const { prisma, sessions } = makePrismaMock();
    sessions.push({
      id: "s-bob",
      userId: "bob",
      title: "Bob's chat",
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = new ChatPersistenceService(prisma as never);
    const result = await svc.renameConversationForUser("s-bob", "alice", "Hijack");
    expect(result).toBeNull();
    expect(sessions[0].title).toBe("Bob's chat");
  });
```

- [ ] **Step 1.3: Run tests to verify they fail**

```bash
cd apps/orchestrator && npx vitest run src/services/chat-persistence.service.test.ts
```

Expected: 4 failures with `svc.renameConversationForUser is not a function`.

- [ ] **Step 1.4: Implement the method**

In `apps/orchestrator/src/services/chat-persistence.service.ts`, immediately below `deleteConversationForUser` (around line 152):

```ts
  /**
   * Rename a conversation owned by the user. Trims and clamps to
   * `TITLE_MAX_LEN` to match the auto-derived title cap. Returns the
   * final stored title, or `null` if no row matched the (id, userId)
   * pair (other user, or doesn't exist — callers map both to 404).
   *
   * Does NOT bump `updatedAt`: rename is a metadata edit. New-activity
   * recency comes from sends, not from typing in the title.
   */
  async renameConversationForUser(
    conversationId: string,
    userId: string,
    rawTitle: string,
  ): Promise<string | null> {
    const trimmed = rawTitle.trim();
    if (trimmed.length === 0) {
      throw new Error("title_required");
    }
    const next = trimmed.slice(0, TITLE_MAX_LEN);
    const existing = await this.prisma.chatSession.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!existing) return null;
    await this.prisma.chatSession.update({
      where: { id: existing.id },
      data: { title: next },
    });
    return next;
  }
```

- [ ] **Step 1.5: Run tests to verify they pass**

```bash
cd apps/orchestrator && npx vitest run src/services/chat-persistence.service.test.ts
```

Expected: all tests green (the 4 new ones plus the pre-existing ones).

- [ ] **Step 1.6: Commit**

```bash
git add apps/orchestrator/src/services/chat-persistence.service.ts \
        apps/orchestrator/src/services/chat-persistence.service.test.ts
git commit -m "WARP-331: add renameConversationForUser service method

Trims + 64-char clamp matching the auto-derive cap. Scoped by userId
so cross-user renames return null (mapped to 404 at the route). Does
not bump updatedAt — rename is metadata, not new activity.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Route `PATCH /api/llm/conversations/:id`

**Files:**
- Modify: `apps/orchestrator/src/routes/llm.ts` (insert after the DELETE handler at line 568)
- Modify (test): `apps/orchestrator/src/__tests__/llm.test.ts`

**Behavior:** Body `{ title: string }`. 200 with `{ id, title, updatedAt }` on success. 400 if title missing / empty / non-string. 401 if unauthed. 404 if the row doesn't belong to the user. Reuses the existing `persistence` instance and auth-middleware `req.user.username`.

- [ ] **Step 2.1: Write failing route test**

Append a `describe` block to `apps/orchestrator/src/__tests__/llm.test.ts` (look at the existing `describe("LLM routes", ...)` setup at line 40 for how `persistence`, `app`, and auth are wired; mirror that). Add:

```ts
  describe("PATCH /api/llm/conversations/:id", () => {
    it("renames a conversation owned by the caller", async () => {
      const renameSpy = vi
        .spyOn(persistence, "renameConversationForUser")
        .mockResolvedValue("Frigate ports");

      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("Cookie", "droplet_session=alice")
        .send({ title: "  Frigate ports  " });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "abc", title: "Frigate ports" });
      expect(renameSpy).toHaveBeenCalledWith("abc", "alice", "  Frigate ports  ");
    });

    it("returns 400 when title is missing or not a string", async () => {
      const res1 = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("Cookie", "droplet_session=alice")
        .send({});
      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("Cookie", "droplet_session=alice")
        .send({ title: 42 });
      expect(res2.status).toBe(400);
    });

    it("returns 400 when service rejects an empty title", async () => {
      vi.spyOn(persistence, "renameConversationForUser").mockRejectedValue(
        new Error("title_required"),
      );
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("Cookie", "droplet_session=alice")
        .send({ title: "   " });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "title_required" });
    });

    it("returns 404 when the row doesn't belong to the caller", async () => {
      vi.spyOn(persistence, "renameConversationForUser").mockResolvedValue(null);
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("Cookie", "droplet_session=alice")
        .send({ title: "Whatever" });
      expect(res.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .send({ title: "Whatever" });
      expect(res.status).toBe(401);
    });
  });
```

If the existing test file uses a different auth-mocking convention (read lines 40-58 of `llm.test.ts` first), match it instead of `Cookie: droplet_session=alice`.

- [ ] **Step 2.2: Run test to verify it fails**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm.test.ts -t "PATCH /api/llm/conversations"
```

Expected: 5 failures with 404 (no route registered) for all of them.

- [ ] **Step 2.3: Implement the route**

In `apps/orchestrator/src/routes/llm.ts`, insert immediately after the existing `router.delete("/llm/conversations/:id", ...)` block (after line 568):

```ts
  // WARP-331: rename. Mirrors the GET/DELETE handlers above — scoped by
  // req.user.username, service maps "no such row owned by this user"
  // to a null return, and we surface that as 404.
  router.patch("/llm/conversations/:id", async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).user?.username;
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const body = req.body as { title?: unknown };
      if (typeof body?.title !== "string") {
        res.status(400).json({ error: "title_required" });
        return;
      }
      let finalTitle: string | null;
      try {
        finalTitle = await persistence.renameConversationForUser(
          req.params.id,
          userId,
          body.title,
        );
      } catch (err) {
        if (err instanceof Error && err.message === "title_required") {
          res.status(400).json({ error: "title_required" });
          return;
        }
        throw err;
      }
      if (finalTitle === null) {
        res.status(404).json({ error: "conversation_not_found" });
        return;
      }
      res.json({
        id: req.params.id,
        title: finalTitle,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm.test.ts -t "PATCH /api/llm/conversations"
```

Expected: 5 PASS.

- [ ] **Step 2.5: Commit**

```bash
git add apps/orchestrator/src/routes/llm.ts apps/orchestrator/src/__tests__/llm.test.ts
git commit -m "WARP-331: PATCH /api/llm/conversations/:id (rename)

Mirrors the GET/DELETE handlers — userId scoping, null-from-service
maps to 404, empty-title throw from service maps to 400.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Date-grouping utility

**Files:**
- Create: `apps/web-dashboard/src/lib/group-conversations-by-date.ts`
- Create: `apps/web-dashboard/src/lib/group-conversations-by-date.test.ts`

**Behavior:** Pure function `groupConversationsByDate<T>(items, now)` — generic over any shape with `{ id, title, updatedAt }`. Returns an ordered `Array<{ label: string; items: T[] }>` with groups: **Today**, **Yesterday**, **Previous 7 days**, **Previous 30 days**, then by month label `"May 2026"` (current year) / `"April 2025"` (older). `now` is injected so tests are deterministic. Being generic avoids duplicating the `ConversationSummary` interface across `api.ts` and this util.

- [ ] **Step 3.1: Write failing tests**

Create `apps/web-dashboard/src/lib/group-conversations-by-date.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupConversationsByDate, type DatedItem } from "./group-conversations-by-date";

const now = new Date("2026-05-13T12:00:00Z");

function row(id: string, daysAgo: number): DatedItem {
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return { id, title: `chat-${id}`, updatedAt: d.toISOString() };
}

describe("groupConversationsByDate", () => {
  it("returns an empty array when there are no items", () => {
    expect(groupConversationsByDate([], now)).toEqual([]);
  });

  it("groups items into Today / Yesterday / Previous 7 days / Previous 30 days / months", () => {
    const items = [
      row("a", 0), // today
      row("b", 1), // yesterday
      row("c", 3), // previous 7
      row("d", 15), // previous 30
      row("e", 60), // March 2026
      row("f", 400), // April 2025
    ];
    const groups = groupConversationsByDate(items, now);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 days",
      "Previous 30 days",
      "March 2026",
      "April 2025",
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a"]);
    expect(groups[4].items.map((i) => i.id)).toEqual(["e"]);
  });

  it("preserves input order within a group (callers pass items sorted newest-first)", () => {
    const items = [row("a", 0), row("b", 0), row("c", 0)];
    const groups = groupConversationsByDate(items, now);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("treats 'yesterday' as the calendar day before, not a 24h window", () => {
    // updatedAt is 25h ago: still yesterday by calendar, even though > 24h.
    const items = [
      { id: "x", title: "x", updatedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() },
    ];
    const groups = groupConversationsByDate(items, now);
    expect(groups[0].label).toBe("Yesterday");
  });

  it("uses month-only labels for older years too (no double-counting)", () => {
    const items = [row("a", 365 + 30)]; // ~April 2025
    const groups = groupConversationsByDate(items, now);
    expect(groups[0].label).toMatch(/\b2025\b/);
  });
});
```

- [ ] **Step 3.2: Run to verify it fails**

```bash
cd apps/web-dashboard && npx vitest run src/lib/group-conversations-by-date.test.ts
```

Expected: module-not-found.

- [ ] **Step 3.3: Implement**

Create `apps/web-dashboard/src/lib/group-conversations-by-date.ts`:

```ts
/**
 * WARP-331 — group conversations by date for the chat history sidebar.
 *
 * Buckets (in order): Today, Yesterday, Previous 7 days, Previous 30 days,
 * then per-month ("May 2026", "April 2025", ...). Callers must pass items
 * sorted newest-first; this function preserves that order within buckets.
 *
 * Generic over any shape carrying `{ id, title, updatedAt }` so we don't
 * duplicate the ConversationSummary interface — `api.ts` owns the wide
 * shape and this util just consumes what it needs.
 *
 * `now` is injected so tests can pin time.
 */
export interface DatedItem {
  id: string;
  title: string | null;
  updatedAt: string; // ISO
}

export interface ConversationGroup<T extends DatedItem = DatedItem> {
  label: string;
  items: T[];
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function monthLabel(d: Date): string {
  // Always include year so April-of-this-year ≠ April-of-last-year.
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

export function groupConversationsByDate<T extends DatedItem>(
  items: T[],
  now: Date,
): ConversationGroup<T>[] {
  if (items.length === 0) return [];

  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 7);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  // Insertion-ordered map so the result is in the desired chronological order.
  const buckets = new Map<string, ConversationSummary[]>();
  const ensure = (label: string): ConversationSummary[] => {
    let arr = buckets.get(label);
    if (!arr) {
      arr = [];
      buckets.set(label, arr);
    }
    return arr;
  };

  // Seed in display order so an empty Today doesn't push Yesterday to the top
  // accidentally — we drop empty buckets at the end.
  ensure("Today");
  ensure("Yesterday");
  ensure("Previous 7 days");
  ensure("Previous 30 days");

  for (const item of items) {
    const updated = new Date(item.updatedAt);
    const day = startOfDay(updated);
    if (day.getTime() === today.getTime()) ensure("Today").push(item);
    else if (day.getTime() === yesterday.getTime()) ensure("Yesterday").push(item);
    else if (day >= sevenDaysAgo) ensure("Previous 7 days").push(item);
    else if (day >= thirtyDaysAgo) ensure("Previous 30 days").push(item);
    else ensure(monthLabel(updated)).push(item);
  }

  return Array.from(buckets.entries())
    .filter(([, arr]) => arr.length > 0)
    .map(([label, items]) => ({ label, items }));
}
```

- [ ] **Step 3.4: Run to verify it passes**

```bash
cd apps/web-dashboard && npx vitest run src/lib/group-conversations-by-date.test.ts
```

Expected: 5 PASS.

- [ ] **Step 3.5: Commit**

```bash
git add apps/web-dashboard/src/lib/group-conversations-by-date.ts \
        apps/web-dashboard/src/lib/group-conversations-by-date.test.ts
git commit -m "WARP-331: groupConversationsByDate utility

Pure function with injected 'now' for deterministic tests. Buckets:
Today / Yesterday / Previous 7 days / Previous 30 days / per-month.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: API client helpers

**Files:**
- Modify: `apps/web-dashboard/src/lib/api.ts` (append next to the existing `fetchConversation` at line 1364)

These are thin wrappers; behavior is exercised by Task 5's hook tests. No dedicated unit test.

- [ ] **Step 4.1: Add three exports next to `fetchConversation`**

In `apps/web-dashboard/src/lib/api.ts`, immediately after the `fetchConversation` function (after line 1375), insert:

```ts
/**
 * WARP-331 — list a user's conversations newest-first. Paginated.
 * Powers the chat history sidebar on /chat.
 */
export interface ConversationSummary {
  id: string;
  title: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listConversations(args: {
  limit: number;
  offset: number;
}): Promise<ConversationSummary[]> {
  const qs = new URLSearchParams({
    limit: String(args.limit),
    offset: String(args.offset),
  });
  const res = await authFetch(`${BASE}/api/llm/conversations?${qs}`);
  if (!res.ok) throw new Error(`Failed to list conversations: ${res.status}`);
  const body = (await res.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

/** WARP-331 — rename a conversation. Server trims + clamps to 64 chars.
 *  Returns the canonical stored title. No `updatedAt` is returned because
 *  the service intentionally does not bump the DB column on rename (rename
 *  is metadata; see chat-persistence.service.ts). */
export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<{ id: string; title: string }> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!res.ok) {
    let body: { error?: string } = {};
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    throw new Error(body.error || `Failed to rename conversation: ${res.status}`);
  }
  return res.json() as Promise<{ id: string; title: string }>;
}

/** WARP-331 — delete a conversation. Returns true on 200, false on 404. */
export async function deleteConversation(conversationId: string): Promise<boolean> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE" },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Failed to delete conversation: ${res.status}`);
  return true;
}
```

- [ ] **Step 4.2: Smoke-test the build**

```bash
cd apps/web-dashboard && npx tsc --noEmit
```

Expected: clean (only the pre-existing warnings, if any). If a circular type pops up, the `ConversationSummary` interface here intentionally matches `group-conversations-by-date.ts`. Re-export from one or the other if you want to dedupe — but for v1, two co-located interfaces are fine.

- [ ] **Step 4.3: Commit**

```bash
git add apps/web-dashboard/src/lib/api.ts
git commit -m "WARP-331: listConversations / renameConversation / deleteConversation helpers

Thin authFetch wrappers next to the existing fetchConversation. Exercised
indirectly by the useConversationList hook tests in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `useConversationList` hook

**Files:**
- Create: `apps/web-dashboard/src/lib/hooks/useConversationList.ts`
- Create: `apps/web-dashboard/src/lib/hooks/useConversationList.test.tsx`

**Surface:**

```ts
useConversationList(): {
  groups: ConversationGroup[];        // grouped by date for render
  flat: ConversationSummary[];        // raw list (used for "find active row")
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  optimisticInsert: (item: ConversationSummary) => void;
  applyTurnCompleted: (id: string) => Promise<void>; // refetch one row
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
}
```

Initial mount fetches page 1 (`limit=30, offset=0`). `loadMore()` fetches the next 30 and concatenates. `optimisticInsert` prepends (because lists sort by updatedAt desc, new chats belong at the top). `applyTurnCompleted` refetches the *single* row by calling `fetchConversation(id)` and overwriting its summary fields (title + updatedAt) — the row may have been auto-titled server-side. `rename` does an optimistic update and reverts on error. `remove` calls `deleteConversation` and removes the row (no optimistic since the rare 404 is benign).

- [ ] **Step 5.1: Write failing tests**

Create `apps/web-dashboard/src/lib/hooks/useConversationList.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const listConversationsMock = vi.fn();
const renameConversationMock = vi.fn();
const deleteConversationMock = vi.fn();
const fetchConversationMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listConversations: (...a: unknown[]) => listConversationsMock(...a),
  renameConversation: (...a: unknown[]) => renameConversationMock(...a),
  deleteConversation: (...a: unknown[]) => deleteConversationMock(...a),
  fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
}));

import { useConversationList } from "./useConversationList";

function row(id: string, daysAgo = 0, title: string | null = `chat-${id}`) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    title,
    model: "llama3",
    provider: "ollama",
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
  };
}

beforeEach(() => {
  listConversationsMock.mockReset();
  renameConversationMock.mockReset();
  deleteConversationMock.mockReset();
  fetchConversationMock.mockReset();
});

describe("useConversationList", () => {
  it("fetches the first page on mount", async () => {
    listConversationsMock.mockResolvedValue([row("a"), row("b")]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.flat.map((c) => c.id)).toEqual(["a", "b"]);
    expect(listConversationsMock).toHaveBeenCalledWith({ limit: 30, offset: 0 });
  });

  it("loadMore appends the next page and tracks hasMore", async () => {
    listConversationsMock.mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => row(`a${i}`)));
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(30));
    expect(result.current.hasMore).toBe(true);

    listConversationsMock.mockResolvedValueOnce([row("z1"), row("z2")]);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.flat.length).toBe(32);
    expect(result.current.hasMore).toBe(false);
    expect(listConversationsMock).toHaveBeenNthCalledWith(2, { limit: 30, offset: 30 });
  });

  it("optimisticInsert prepends a new row", async () => {
    listConversationsMock.mockResolvedValue([row("a", 1)]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));
    act(() => {
      result.current.optimisticInsert(row("new", 0, "freshly minted"));
    });
    expect(result.current.flat[0].id).toBe("new");
    expect(result.current.flat[0].title).toBe("freshly minted");
  });

  it("applyTurnCompleted overwrites a row's title + updatedAt from the server", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0, "old title")]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));

    fetchConversationMock.mockResolvedValueOnce({
      id: "a",
      title: "server-derived",
      updatedAt: new Date().toISOString(),
      model: "llama3",
      provider: "ollama",
      createdAt: result.current.flat[0].createdAt,
      messages: [],
    });
    await act(async () => {
      await result.current.applyTurnCompleted("a");
    });
    expect(result.current.flat[0].title).toBe("server-derived");
  });

  it("rename updates optimistically and reverts on error", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0, "old")]);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(1));

    renameConversationMock.mockRejectedValueOnce(new Error("title_required"));
    await act(async () => {
      await expect(result.current.rename("a", "new")).rejects.toThrow();
    });
    expect(result.current.flat[0].title).toBe("old");
  });

  it("remove deletes the row when the server returns success", async () => {
    listConversationsMock.mockResolvedValue([row("a"), row("b")]);
    deleteConversationMock.mockResolvedValue(true);
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.flat.length).toBe(2));

    await act(async () => {
      await result.current.remove("a");
    });
    expect(result.current.flat.map((c) => c.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 5.2: Run to verify it fails**

```bash
cd apps/web-dashboard && npx vitest run src/lib/hooks/useConversationList.test.tsx
```

Expected: module-not-found.

- [ ] **Step 5.3: Implement the hook**

Create `apps/web-dashboard/src/lib/hooks/useConversationList.ts`:

```ts
/**
 * WARP-331 — paginated chat-history list for /chat.
 *
 * Drives `ChatHistoryPanel`. Owns the list state, exposes the mutation
 * helpers the panel + useChat call into. Date-grouping is derived on
 * every render via `groupConversationsByDate` — cheap, keeps state flat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listConversations,
  renameConversation,
  deleteConversation,
  fetchConversation,
  type ConversationSummary,
} from "@/lib/api";
import {
  groupConversationsByDate,
  type ConversationGroup,
} from "@/lib/group-conversations-by-date";

type ConversationGroupRow = ConversationGroup<ConversationSummary>;

const PAGE_SIZE = 30;

export function useConversationList(): {
  groups: ConversationGroupRow[];
  flat: ConversationSummary[];
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  optimisticInsert: (item: ConversationSummary) => void;
  applyTurnCompleted: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
} {
  const [flat, setFlat] = useState<ConversationSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const inFlightRef = useRef(false);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await listConversations({ limit: PAGE_SIZE, offset: 0 });
        if (cancelled) return;
        setFlat(page);
        offsetRef.current = page.length;
        setHasMore(page.length === PAGE_SIZE);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load conversations");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasMore) return;
    inFlightRef.current = true;
    try {
      const next = await listConversations({
        limit: PAGE_SIZE,
        offset: offsetRef.current,
      });
      setFlat((prev) => [...prev, ...next]);
      offsetRef.current += next.length;
      setHasMore(next.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      inFlightRef.current = false;
    }
  }, [hasMore]);

  const optimisticInsert = useCallback((item: ConversationSummary) => {
    setFlat((prev) => {
      // De-dupe by id (the server may already have raced us with the real row).
      const without = prev.filter((c) => c.id !== item.id);
      return [item, ...without];
    });
  }, []);

  const applyTurnCompleted = useCallback(async (id: string) => {
    const detail = await fetchConversation(id);
    if (!detail) return;
    setFlat((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, title: detail.title, updatedAt: detail.updatedAt }
          : c,
      ),
    );
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    // Optimistic
    let prevTitle: string | null = null;
    setFlat((prev) =>
      prev.map((c) => {
        if (c.id === id) {
          prevTitle = c.title;
          return { ...c, title };
        }
        return c;
      }),
    );
    try {
      const final = await renameConversation(id, title);
      setFlat((prev) => prev.map((c) => (c.id === id ? { ...c, title: final.title } : c)));
    } catch (err) {
      // Revert
      setFlat((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: prevTitle } : c)),
      );
      throw err;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    const ok = await deleteConversation(id);
    if (ok) setFlat((prev) => prev.filter((c) => c.id !== id));
    return ok;
  }, []);

  const groups = useMemo(
    () => groupConversationsByDate(flat, new Date()),
    [flat],
  );

  return {
    groups,
    flat,
    hasMore,
    isLoading,
    error,
    loadMore,
    optimisticInsert,
    applyTurnCompleted,
    rename,
    remove,
  };
}
```

- [ ] **Step 5.4: Run to verify it passes**

```bash
cd apps/web-dashboard && npx vitest run src/lib/hooks/useConversationList.test.tsx
```

Expected: 6 PASS.

- [ ] **Step 5.5: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/useConversationList.ts \
        apps/web-dashboard/src/lib/hooks/useConversationList.test.tsx
git commit -m "WARP-331: useConversationList hook

Paginated fetch (30/page), optimistic insert/rename, applyTurnCompleted
that refetches a single row to pick up the server-derived title.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `ChatHistoryRow` component

**Files:**
- Create: `apps/web-dashboard/src/components/chat/ChatHistoryRow.tsx`
- Create: `apps/web-dashboard/src/components/chat/ChatHistoryRow.test.tsx`

**Behavior:** Renders a single row with truncated title + a hover-revealed `⋯` kebab menu containing **Rename** and **Delete**. Rename swaps the title into inline-edit mode (text input + ✓ / ✕); Enter submits, Escape cancels. Active row gets the accent highlight. Click anywhere not on the input/menu fires `onSelect()`. Keyboard: `F2` opens rename, `Delete` opens delete confirm.

- [ ] **Step 6.1: Write failing tests**

Create `apps/web-dashboard/src/components/chat/ChatHistoryRow.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatHistoryRow } from "./ChatHistoryRow";

const baseProps = {
  id: "abc",
  title: "Frigate ports",
  active: false,
  onSelect: vi.fn(),
  onRenameSubmit: vi.fn().mockResolvedValue(undefined),
  onDeleteRequest: vi.fn(),
};

describe("ChatHistoryRow", () => {
  it("renders the title", () => {
    render(<ChatHistoryRow {...baseProps} />);
    expect(screen.getByText("Frigate ports")).toBeInTheDocument();
  });

  it("falls back to 'Untitled chat' when title is null", () => {
    render(<ChatHistoryRow {...baseProps} title={null} />);
    expect(screen.getByText("Untitled chat")).toBeInTheDocument();
  });

  it("fires onSelect when the row is clicked", () => {
    const onSelect = vi.fn();
    render(<ChatHistoryRow {...baseProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /open chat/i }));
    expect(onSelect).toHaveBeenCalled();
  });

  it("opens inline rename when the Rename menu item is chosen", () => {
    render(<ChatHistoryRow {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    expect(screen.getByRole("textbox", { name: /chat title/i })).toBeInTheDocument();
  });

  it("submits rename on Enter and calls onRenameSubmit with the trimmed value", async () => {
    const onRenameSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ChatHistoryRow {...baseProps} onRenameSubmit={onRenameSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    const input = screen.getByRole("textbox", { name: /chat title/i }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameSubmit).toHaveBeenCalledWith("New title");
  });

  it("cancels rename on Escape and restores the original title", () => {
    render(<ChatHistoryRow {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    const input = screen.getByRole("textbox", { name: /chat title/i }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Frigate ports")).toBeInTheDocument();
  });

  it("calls onDeleteRequest when Delete menu item is chosen", () => {
    const onDeleteRequest = vi.fn();
    render(<ChatHistoryRow {...baseProps} onDeleteRequest={onDeleteRequest} />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(onDeleteRequest).toHaveBeenCalled();
  });

  it("applies the active highlight when active=true", () => {
    render(<ChatHistoryRow {...baseProps} active />);
    expect(screen.getByRole("button", { name: /open chat/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
```

- [ ] **Step 6.2: Run to verify it fails**

```bash
cd apps/web-dashboard && npx vitest run src/components/chat/ChatHistoryRow.test.tsx
```

Expected: module-not-found.

- [ ] **Step 6.3: Implement**

Create `apps/web-dashboard/src/components/chat/ChatHistoryRow.tsx`:

```tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

export interface ChatHistoryRowProps {
  id: string;
  title: string | null;
  active: boolean;
  onSelect: () => void;
  onRenameSubmit: (newTitle: string) => Promise<void>;
  onDeleteRequest: () => void;
}

const DISPLAY_TITLE = (title: string | null) => title?.trim() || "Untitled chat";

export function ChatHistoryRow({
  id,
  title,
  active,
  onSelect,
  onRenameSubmit,
  onDeleteRequest,
}: ChatHistoryRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(DISPLAY_TITLE(title));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const openRename = () => {
    setMenuOpen(false);
    setDraft(DISPLAY_TITLE(title));
    setRenaming(true);
  };

  const submitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setRenaming(false);
      return;
    }
    setRenaming(false);
    await onRenameSubmit(trimmed);
  };

  const cancelRename = () => {
    setDraft(DISPLAY_TITLE(title));
    setRenaming(false);
  };

  // Keyboard shortcuts on the row button.
  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      openRename();
    } else if (e.key === "Delete") {
      e.preventDefault();
      onDeleteRequest();
    }
  };

  return (
    <div className="group relative">
      {renaming ? (
        <div className="flex items-center gap-1 px-2 h-8 rounded-md bg-surface-secondary">
          <input
            ref={inputRef}
            aria-label="Chat title"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            onBlur={submitRename}
            maxLength={64}
            className="flex-1 bg-transparent type-footnote text-label-primary outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Open chat: ${DISPLAY_TITLE(title)}`}
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
          onKeyDown={onRowKeyDown}
          className={`
            w-full text-left px-2 h-8 rounded-md type-footnote
            flex items-center
            transition-colors duration-150
            ${
              active
                ? "bg-accent-subtle text-accent font-medium"
                : "text-label-secondary hover:bg-surface-secondary hover:text-label-primary"
            }
          `}
        >
          <span className="truncate flex-1">{DISPLAY_TITLE(title)}</span>
        </button>
      )}

      {!renaming && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            aria-label={`More actions for ${DISPLAY_TITLE(title)}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="p-1 rounded text-label-tertiary hover:text-label-primary hover:bg-surface-tertiary"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-1 w-32 bg-surface-elevated dp-material rounded-md shadow-lg border border-separator z-10"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                type="button"
                role="menuitem"
                onClick={openRename}
                className="w-full flex items-center gap-2 px-3 py-2 type-footnote text-label-primary hover:bg-surface-secondary"
              >
                <Pencil size={12} /> Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDeleteRequest();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 type-footnote text-system-red hover:bg-system-red/10"
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6.4: Run to verify it passes**

```bash
cd apps/web-dashboard && npx vitest run src/components/chat/ChatHistoryRow.test.tsx
```

Expected: 8 PASS. If any Tailwind class names referenced (`bg-accent-subtle`, `dp-material`, etc.) trip a test, those are pure presentational classes — the tests don't assert on them.

- [ ] **Step 6.5: Commit**

```bash
git add apps/web-dashboard/src/components/chat/ChatHistoryRow.tsx \
        apps/web-dashboard/src/components/chat/ChatHistoryRow.test.tsx
git commit -m "WARP-331: ChatHistoryRow component

Truncated title, hover kebab menu (Rename / Delete), inline-edit on
rename with Enter/Escape, F2/Delete keyboard shortcuts, active-row
aria-current.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `ChatHistoryPanel` component

**Files:**
- Create: `apps/web-dashboard/src/components/chat/ChatHistoryPanel.tsx`
- Create: `apps/web-dashboard/src/components/chat/ChatHistoryPanel.test.tsx`

**Behavior:** Composes `useConversationList` + `ChatHistoryRow` + date headers + a `+ New chat` button at the top + an IntersectionObserver-driven sentinel that triggers `loadMore()` when in view. Renders a `<Dialog>` for delete confirmation. Empty / loading / error states. Accepts `activeConversationId` to highlight the right row, plus `onSelect(id)` and `onNewChat()` callbacks so the parent owns routing.

- [ ] **Step 7.1: Write failing tests**

Create `apps/web-dashboard/src/components/chat/ChatHistoryPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listConversationsMock = vi.fn();
const renameConversationMock = vi.fn();
const deleteConversationMock = vi.fn();
const fetchConversationMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listConversations: (...a: unknown[]) => listConversationsMock(...a),
  renameConversation: (...a: unknown[]) => renameConversationMock(...a),
  deleteConversation: (...a: unknown[]) => deleteConversationMock(...a),
  fetchConversation: (...a: unknown[]) => fetchConversationMock(...a),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { ChatHistoryPanel } from "./ChatHistoryPanel";

beforeEach(() => {
  listConversationsMock.mockReset();
  renameConversationMock.mockReset();
  deleteConversationMock.mockReset();
  fetchConversationMock.mockReset();
});

const row = (id: string, daysAgo = 0, title: string | null = `chat-${id}`) => {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    title,
    model: "llama3",
    provider: "ollama",
    createdAt: d.toISOString(),
    updatedAt: d.toISOString(),
  };
};

describe("ChatHistoryPanel", () => {
  it("shows the empty state when there are no conversations", async () => {
    listConversationsMock.mockResolvedValue([]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/no chats yet/i)).toBeInTheDocument());
  });

  it("renders date group headers and rows", async () => {
    listConversationsMock.mockResolvedValue([row("a", 0), row("b", 1), row("c", 10)]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("Previous 30 days")).toBeInTheDocument();
  });

  it("fires onSelect with the row id", async () => {
    const onSelect = vi.fn();
    listConversationsMock.mockResolvedValue([row("a")]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={onSelect}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /open chat/i }));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("fires onNewChat from the + New chat button", async () => {
    const onNewChat = vi.fn();
    listConversationsMock.mockResolvedValue([]);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={onNewChat}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /new chat/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalled();
  });

  it("confirms before deleting and calls deleteConversation on confirm", async () => {
    listConversationsMock.mockResolvedValue([row("a")]);
    deleteConversationMock.mockResolvedValue(true);
    render(
      <ChatHistoryPanel
        activeConversationId={null}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(screen.getByText(/delete this chat/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(deleteConversationMock).toHaveBeenCalledWith("a"));
  });

  it("calls onNewChat after deleting the currently-active conversation", async () => {
    const onNewChat = vi.fn();
    listConversationsMock.mockResolvedValue([row("a")]);
    deleteConversationMock.mockResolvedValue(true);
    render(
      <ChatHistoryPanel
        activeConversationId="a"
        onSelect={vi.fn()}
        onNewChat={onNewChat}
      />,
    );
    await waitFor(() => expect(screen.getByText("chat-a")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(onNewChat).toHaveBeenCalled());
  });
});
```

- [ ] **Step 7.2: Run to verify it fails**

```bash
cd apps/web-dashboard && npx vitest run src/components/chat/ChatHistoryPanel.test.tsx
```

Expected: module-not-found.

- [ ] **Step 7.3: Expose a way for the parent to drive optimistic insert / turn-completed from useChat**

The panel owns the hook, but `useChat` needs to call `optimisticInsert` and `applyTurnCompleted` on it. Solve via a `ref`-style imperative handle. Inside `ChatHistoryPanel`, expose:

```ts
export interface ChatHistoryPanelHandle {
  optimisticInsert: (item: ConversationSummary) => void;
  applyTurnCompleted: (id: string) => Promise<void>;
}
```

…and accept a `handleRef?: React.MutableRefObject<ChatHistoryPanelHandle | null>` prop (full code below).

- [ ] **Step 7.4: Implement the panel**

Create `apps/web-dashboard/src/components/chat/ChatHistoryPanel.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { useConversationList } from "@/lib/hooks/useConversationList";
import type { ConversationSummary } from "@/lib/api";
import { ChatHistoryRow } from "./ChatHistoryRow";

export interface ChatHistoryPanelHandle {
  optimisticInsert: (item: ConversationSummary) => void;
  applyTurnCompleted: (id: string) => Promise<void>;
}

export interface ChatHistoryPanelProps {
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** When provided, the panel writes its imperative handle here so the
   *  parent (e.g. useChat) can drive optimistic insert + turn-completed. */
  handleRef?: React.MutableRefObject<ChatHistoryPanelHandle | null>;
}

export function ChatHistoryPanel({
  activeConversationId,
  onSelect,
  onNewChat,
  handleRef,
}: ChatHistoryPanelProps) {
  const {
    groups,
    flat,
    hasMore,
    isLoading,
    error,
    loadMore,
    optimisticInsert,
    applyTurnCompleted,
    rename,
    remove,
  } = useConversationList();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const deleteHeadingId = "chat-history-delete-heading";

  // Publish imperative handle for useChat to call into.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { optimisticInsert, applyTurnCompleted };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, optimisticInsert, applyTurnCompleted]);

  // Infinite scroll sentinel.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || isLoading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadMore]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      const ok = await remove(target.id);
      if (!ok) toast("Chat already deleted");
      // If the user just deleted the chat they're currently viewing,
      // route back to a fresh /chat so the messages column doesn't keep
      // pointing at a dead id. The parent owns routing — we ask via
      // onNewChat() rather than calling router.push ourselves.
      if (target.id === activeConversationId) {
        onNewChat();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleRename = async (id: string, title: string) => {
    try {
      await rename(id, title);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Rename failed");
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-2 border-b border-separator">
        <button
          type="button"
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-2 h-9 rounded-md
                     bg-accent text-white type-subheadline font-medium
                     hover:bg-accent-strong transition-colors"
        >
          <Plus size={16} /> New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {isLoading && flat.length === 0 ? (
          <div className="px-2 py-4 type-footnote text-label-tertiary">Loading chats…</div>
        ) : error ? (
          <div className="px-2 py-4 type-footnote text-system-red">{error}</div>
        ) : flat.length === 0 ? (
          <div className="px-2 py-8 text-center type-footnote text-label-tertiary">
            No chats yet. Start by asking something below.
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.label} className="mb-3">
                <div className="px-2 py-1 type-caption-2 text-label-tertiary uppercase tracking-wide">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <ChatHistoryRow
                      key={item.id}
                      id={item.id}
                      title={item.title}
                      active={item.id === activeConversationId}
                      onSelect={() => onSelect(item.id)}
                      onRenameSubmit={(title) => handleRename(item.id, title)}
                      onDeleteRequest={() => setPendingDelete(item)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {hasMore && <div ref={sentinelRef} className="h-4" aria-hidden />}
          </>
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        labelledBy={deleteHeadingId}
        maxWidth="sm"
      >
        <div className="p-5">
          <h2 id={deleteHeadingId} className="type-headline mb-2">
            Delete this chat?
          </h2>
          <p className="type-subheadline text-label-secondary mb-4">
            "{pendingDelete?.title?.trim() || "Untitled chat"}" will be permanently removed.
            This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="dp-btn-secondary px-3 h-9"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              className="dp-btn-danger px-3 h-9"
            >
              Delete
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
```

If `dp-btn-secondary` / `dp-btn-danger` aren't in the project's globals.css, fall back to inline Tailwind matching the existing Dialog use sites (`grep -rn "dp-btn-" apps/web-dashboard/src/components/Dialog*` or check a sibling page like `apps/web-dashboard/src/app/files/page.tsx` for the exact class names in use).

- [ ] **Step 7.5: Run to verify it passes**

```bash
cd apps/web-dashboard && npx vitest run src/components/chat/ChatHistoryPanel.test.tsx
```

Expected: 6 PASS. The IntersectionObserver isn't fired in jsdom (jsdom has a shim that no-ops it) so the sentinel is not load-tested here; it's covered by manual E2E.

- [ ] **Step 7.6: Commit**

```bash
git add apps/web-dashboard/src/components/chat/ChatHistoryPanel.tsx \
        apps/web-dashboard/src/components/chat/ChatHistoryPanel.test.tsx
git commit -m "WARP-331: ChatHistoryPanel component

Composes useConversationList + ChatHistoryRow, date-group headers,
+ New chat button, IO sentinel for infinite scroll, delete-confirm
Dialog, imperative handle for useChat to drive optimistic inserts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire `useChat` for optimistic insert + turn-completed

**Files:**
- Modify: `apps/web-dashboard/src/lib/hooks/useChat.ts` (around lines 132-134, 246-250, 323-328, 504)

**Behavior:** `useChat` accepts an optional `historyHandleRef: MutableRefObject<ChatHistoryPanelHandle | null>`. When `setConversationId(headerId)` fires *for a brand-new conversation* (no prior id), we call `historyHandleRef.current?.optimisticInsert(...)`. When the `turn-completed` MQTT event fires, we additionally call `applyTurnCompleted(conversationId)`.

- [ ] **Step 8.1: Add a focused test for the optimistic-insert and turn-completed wiring**

Append to (or create alongside) the existing chat hook tests. If there's no `useChat.test.ts` yet, create `apps/web-dashboard/src/lib/hooks/useChat.history-wiring.test.ts` with only the wiring assertion (we don't need to re-test the whole chat lifecycle):

```ts
import { describe, it, expect, vi } from "vitest";
import type { ChatHistoryPanelHandle } from "@/components/chat/ChatHistoryPanel";

// We deliberately test the wiring logic as a small pure helper so we
// don't have to stand up the entire useChat hook (which depends on
// WebSocket + fetch + AbortController). Extract the helper out of
// useChat.ts as `notifyHistoryOfTurnCompleted(handle, id)`.

import { notifyHistoryOfTurnCompleted, notifyHistoryOfNewConversation } from "./useChat";

describe("useChat → ChatHistoryPanel wiring", () => {
  it("notifyHistoryOfNewConversation calls optimisticInsert with a derived title", () => {
    const handle: ChatHistoryPanelHandle = {
      optimisticInsert: vi.fn(),
      applyTurnCompleted: vi.fn().mockResolvedValue(undefined),
    };
    notifyHistoryOfNewConversation(handle, {
      id: "new-id",
      firstUserContent: "  Why doesn't the chat history show?  ",
    });
    expect(handle.optimisticInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "new-id",
        title: "Why doesn't the chat history show?",
      }),
    );
  });

  it("notifyHistoryOfNewConversation clamps the optimistic title to 64 chars", () => {
    const handle: ChatHistoryPanelHandle = {
      optimisticInsert: vi.fn(),
      applyTurnCompleted: vi.fn().mockResolvedValue(undefined),
    };
    notifyHistoryOfNewConversation(handle, {
      id: "new-id",
      firstUserContent: "x".repeat(200),
    });
    const call = (handle.optimisticInsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.title.length).toBeLessThanOrEqual(64);
  });

  it("notifyHistoryOfTurnCompleted calls applyTurnCompleted", async () => {
    const handle: ChatHistoryPanelHandle = {
      optimisticInsert: vi.fn(),
      applyTurnCompleted: vi.fn().mockResolvedValue(undefined),
    };
    await notifyHistoryOfTurnCompleted(handle, "abc");
    expect(handle.applyTurnCompleted).toHaveBeenCalledWith("abc");
  });

  it("both helpers no-op when handle is null", async () => {
    expect(() =>
      notifyHistoryOfNewConversation(null, { id: "x", firstUserContent: "y" }),
    ).not.toThrow();
    await expect(notifyHistoryOfTurnCompleted(null, "x")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 8.2: Run to verify it fails**

```bash
cd apps/web-dashboard && npx vitest run src/lib/hooks/useChat.history-wiring.test.ts
```

Expected: import error — `notifyHistoryOfTurnCompleted` and `notifyHistoryOfNewConversation` not exported.

- [ ] **Step 8.3: Implement the helpers and wire them in**

In `apps/web-dashboard/src/lib/hooks/useChat.ts`:

**(a)** At the top-level (above the `useChat` hook), add the helper exports:

```ts
import type { ChatHistoryPanelHandle } from "@/components/chat/ChatHistoryPanel";

const TITLE_MAX_LEN = 64;

/** WARP-331 — derive the optimistic title from the first user message. */
function deriveOptimisticTitle(firstUserContent: string): string {
  const trimmed = firstUserContent.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed;
  const slice = trimmed.slice(0, TITLE_MAX_LEN);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > TITLE_MAX_LEN / 2 ? slice.slice(0, lastSpace) : slice) + "…";
}

export function notifyHistoryOfNewConversation(
  handle: ChatHistoryPanelHandle | null,
  args: { id: string; firstUserContent: string },
): void {
  if (!handle) return;
  const now = new Date().toISOString();
  handle.optimisticInsert({
    id: args.id,
    title: deriveOptimisticTitle(args.firstUserContent),
    model: null,
    provider: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function notifyHistoryOfTurnCompleted(
  handle: ChatHistoryPanelHandle | null,
  conversationId: string,
): Promise<void> {
  if (!handle) return;
  await handle.applyTurnCompleted(conversationId);
}
```

**(b)** Change the `useChat` signature to accept the ref:

```ts
export function useChat(opts?: {
  historyHandleRef?: React.MutableRefObject<ChatHistoryPanelHandle | null>;
}) {
  // ... existing body
}
```

**(c)** At the existing `setConversationId(headerId)` call (~line 504), if `conversationId` was previously `null`, also call `notifyHistoryOfNewConversation` with the user message that just went out:

```ts
        if (headerId) {
          const wasNew = conversationId === null;
          setConversationId(headerId);
          if (wasNew) {
            notifyHistoryOfNewConversation(opts?.historyHandleRef?.current ?? null, {
              id: headerId,
              firstUserContent: userContentForOptimistic, // the user text we just sent
            });
          }
        }
```

You may need to capture `userContentForOptimistic` near the top of the send function — it's the same string the route receives. Read `useChat.ts:480-510` for the exact local-variable name; it's typically `content` or `userMessage.content`.

**(d)** At the existing turn-completed handler (~line 328), after the existing logic, call:

```ts
      if (data.topic.endsWith("/turn-completed")) {
        // ... existing handling
        const id = conversationId; // closure-captured
        if (id) {
          void notifyHistoryOfTurnCompleted(opts?.historyHandleRef?.current ?? null, id);
        }
      }
```

**(e)** Delete the obsolete comment block at lines 132-134:

```ts
 * The session-based UX (server-side history, sidebar of past chats)
 * went away with WARP-104. If reintroduced it would need an
 * orchestrator-side persistence layer; see the WARP-104 PR body.
```

Replace with a one-line note pointing at WARP-331:

```ts
 * Conversation history is rendered by ChatHistoryPanel (WARP-331),
 * which receives optimistic inserts + turn-completed refetches via
 * the `historyHandleRef` option on this hook.
```

- [ ] **Step 8.4: Run wiring test to verify it passes**

```bash
cd apps/web-dashboard && npx vitest run src/lib/hooks/useChat.history-wiring.test.ts
```

Expected: 4 PASS.

- [ ] **Step 8.5: Run the full dashboard test suite to ensure nothing regressed**

```bash
cd apps/web-dashboard && npx vitest run
```

Expected: all green. If a pre-existing test breaks because the `useChat` signature changed, update the call site to pass no options (`useChat()` should still work; the new param is optional).

- [ ] **Step 8.6: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/useChat.ts \
        apps/web-dashboard/src/lib/hooks/useChat.history-wiring.test.ts
git commit -m "WARP-331: wire useChat to ChatHistoryPanel via imperative handle

On first send of a new conversation, optimistically insert a row with
the user's message as the provisional title. On turn-completed MQTT,
refetch that one row to pick up the server-derived title.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Mount the panel on `/chat`

**Files:**
- Modify: `apps/web-dashboard/src/app/chat/page.tsx`

**Behavior:** Two-column layout on `lg+`: 280px panel + flex-1 message area. Below `lg`: panel hidden; new `PanelLeftOpen` icon button in the chat header opens the panel in a `<Dialog placement="right">`. Selecting a row navigates to `/chat?c=<id>` and closes the drawer. The page owns the `historyHandleRef` and passes it both to `<ChatHistoryPanel>` and to `useChat({ historyHandleRef })`.

- [ ] **Step 9.1: Add a focused render test for the two-column structure**

Create `apps/web-dashboard/src/__tests__/chat-page.history-panel.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock api so the page renders without hitting the network.
const listConversationsMock = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listConversations: (...a: unknown[]) => listConversationsMock(...a),
    // The chat page also imports things like fetchModels — keep them as no-ops.
    fetchModels: vi.fn().mockResolvedValue([]),
  };
});

// next/navigation mocks
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/chat",
}));

import ChatPage from "@/app/chat/page";

describe("/chat page mounts the history panel", () => {
  it("renders the + New chat button (panel mounted)", async () => {
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /new chat/i })).toBeInTheDocument());
  });
});
```

This is a light smoke test — full chat-page coverage stays in the existing `chat-page.jump-pill.test.tsx` etc.

- [ ] **Step 9.2: Run to verify it fails**

```bash
cd apps/web-dashboard && npx vitest run src/__tests__/chat-page.history-panel.test.tsx
```

Expected: "New chat" button not in document.

- [ ] **Step 9.3: Modify `apps/web-dashboard/src/app/chat/page.tsx`**

The exact edits depend on the existing structure. Apply this template:

**(a)** Add imports at the top:

```ts
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PanelLeftOpen } from "lucide-react";
import { ChatHistoryPanel, type ChatHistoryPanelHandle } from "@/components/chat/ChatHistoryPanel";
import { Dialog } from "@/components/Dialog";
```

(Some of these may already be imported. Don't duplicate.)

**(b)** Inside the `ChatPage` component, near the existing hooks:

```ts
  const router = useRouter();
  const searchParams = useSearchParams();
  const historyHandleRef = useRef<ChatHistoryPanelHandle | null>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);
```

**(c)** Wire `useChat`:

```ts
  // EXISTING:  const chat = useChat();
  const chat = useChat({ historyHandleRef });
```

**(d)** Define handlers:

```ts
  const handleSelectConversation = (id: string) => {
    setMobileHistoryOpen(false);
    router.push(`/chat?c=${encodeURIComponent(id)}`);
  };
  const handleNewChat = () => {
    setMobileHistoryOpen(false);
    router.push("/chat");
  };
```

**(e)** Wrap the existing chat content in a two-column layout. Replace the page's outer `<main>` (or top-level `<div>`) with:

```tsx
return (
  <div className="flex h-[100dvh]">
    {/* Desktop: persistent left panel */}
    <aside
      className="hidden lg:flex lg:flex-col lg:w-[280px] lg:flex-shrink-0
                 border-r border-separator bg-surface-secondary"
      aria-label="Chat history"
    >
      <ChatHistoryPanel
        activeConversationId={chat.conversationId}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        handleRef={historyHandleRef}
      />
    </aside>

    {/* Right column: existing chat UI */}
    <div className="flex-1 flex flex-col min-w-0">
      {/* Mobile-only history trigger in the chat header */}
      <div className="lg:hidden flex items-center px-3 h-12 border-b border-separator">
        <button
          ref={historyTriggerRef}
          type="button"
          onClick={() => setMobileHistoryOpen(true)}
          aria-label="Open chat history"
          aria-haspopup="dialog"
          aria-expanded={mobileHistoryOpen}
          className="p-2 -ml-2 rounded-md text-label-secondary hover:bg-surface-tertiary"
        >
          <PanelLeftOpen size={18} />
        </button>
      </div>

      {/* EXISTING chat body goes here — keep the existing JSX intact */}
      {/* <ModelSelector ... /> <SessionHeader ... /> <Messages ... /> <ChatInput ... /> */}
    </div>

    {/* Mobile drawer */}
    <Dialog
      open={mobileHistoryOpen}
      onClose={() => setMobileHistoryOpen(false)}
      triggerRef={historyTriggerRef}
      labelledBy="mobile-history-heading"
      placement="right"
    >
      <div className="flex flex-col h-full w-[320px] max-w-[85vw]">
        <h2 id="mobile-history-heading" className="sr-only">Chat history</h2>
        <ChatHistoryPanel
          activeConversationId={chat.conversationId}
          onSelect={handleSelectConversation}
          onNewChat={handleNewChat}
        />
      </div>
    </Dialog>
  </div>
);
```

**Important:** the mobile drawer's `<ChatHistoryPanel>` does NOT receive `handleRef` — only the desktop panel does, since both would race to claim the ref and `useChat` only needs one consumer. (The drawer panel is fine without; rename / delete / loadMore still work because they don't depend on the handle.)

- [ ] **Step 9.4: Run the new smoke test**

```bash
cd apps/web-dashboard && npx vitest run src/__tests__/chat-page.history-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 9.5: Run the entire dashboard test suite**

```bash
cd apps/web-dashboard && npx vitest run
```

Expected: all green, including pre-existing `chat-page.*.test.tsx` files. If `chat-page.jump-pill.test.tsx` (or similar) breaks because it queried by container layout, adjust the query to be DOM-structure-agnostic (`screen.getByRole(...)`).

- [ ] **Step 9.6: Smoke-test the build**

```bash
cd apps/web-dashboard && npx tsc --noEmit && npm run build
```

Expected: clean Next.js build. If `useSearchParams` triggers the "must be used in a Suspense boundary" Next.js 14 warning, wrap the page export in a `<Suspense>` per the existing pattern in sibling pages (`grep -rn "Suspense" apps/web-dashboard/src/app/`).

- [ ] **Step 9.7: Commit**

```bash
git add apps/web-dashboard/src/app/chat/page.tsx \
        apps/web-dashboard/src/__tests__/chat-page.history-panel.test.tsx
git commit -m "WARP-331: mount ChatHistoryPanel on /chat (desktop + mobile drawer)

Two-column lg+ layout (280px panel + flex-1 messages); below lg the
panel is hidden and a PanelLeftOpen header button opens the same
panel inside the Dialog placement=right primitive. useChat receives
the imperative handle so new conversations appear instantly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Final verification + push

- [ ] **Step 10.1: Run every affected test suite**

```bash
cd apps/orchestrator && npx vitest run
cd ../.. && cd apps/web-dashboard && npx vitest run
```

Expected: all green in both packages.

- [ ] **Step 10.2: Run the security guard**

```bash
./scripts/test-security.sh
```

Expected: no new regressions. We didn't add any env vars or secrets, so this is just a sanity check.

- [ ] **Step 10.3: Manual E2E checklist (record results in the PR description)**

1. `npm run dev:docker`, log into the dashboard at https://localhost, go to `/chat`.
2. Send a message → row appears in the left panel under "Today" with the user's first message as the provisional title.
3. After the assistant replies, the row's title settles to the server-derived title.
4. Open a second tab at `/chat` → both rows visible.
5. Click a different row → URL becomes `/chat?c=<id>` and the thread rehydrates.
6. Hover a row → `⋯` appears → Rename → type "Renamed!" → Enter → row title is "Renamed!" → reload page → title still "Renamed!".
7. Hover a row → `⋯` → Delete → confirm modal → Delete → row disappears.
8. If the deleted row was active, the page navigates to `/chat` cleanly.
9. Resize browser to <1024px → left panel hidden, `PanelLeftOpen` icon appears in the chat header → click → drawer opens with the same list → click a row → drawer closes and thread loads.
10. With 30+ chats, scroll the panel to the bottom → next page loads automatically; date headers continue to be correct.

- [ ] **Step 10.4: Push and open a PR**

```bash
git push -u origin worktree-WARP-331-chat-history-sidebar
gh pr create --title "WARP-331: chat history sidebar + switcher" \
  --body "$(printf 'Closes WARP-331.\n\n## What\n\nAdds the chat-history panel to /chat. Backend list/load/delete were\nalready in place from WARP-304/329; this ticket adds:\n\n- New PATCH /api/llm/conversations/:id (rename) + service method\n- New ChatHistoryPanel + ChatHistoryRow components\n- New useConversationList hook\n- Two-column /chat layout on lg+, drawer below lg via Dialog placement=right\n- Optimistic insert on first send + soft-refetch on droplet/chat/<userId>/turn-completed\n\n## Out of scope\n\n- Archive state (needs a Prisma column; tracked separately)\n- Full-text search across chats\n- Cross-tab live new-conversation creation (turn-completed MQTT covers cross-tab after first reply)\n\n## Test plan\n\nSee Task 10.3 in docs/superpowers/plans/2026-05-13-warp-331-chat-history-sidebar-plan.md for the manual E2E checklist; results below.\n\n- [ ] Step 1\n- [ ] Step 2\n- [ ] ...\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n')"
```

(Fill in the manual checklist results before requesting review.)

---

## Spec coverage check

| Spec requirement | Implemented by |
|---|---|
| New `PATCH /api/llm/conversations/:id` rename route | Task 2 |
| `renameConversationForUser` service method | Task 1 |
| `listConversations` / `renameConversation` / `deleteConversation` api.ts helpers | Task 4 |
| `useConversationList` hook | Task 5 |
| `groupConversationsByDate` (Today / Yesterday / Previous 7 days / Previous 30 days / per-month) | Task 3 |
| `ChatHistoryRow` (truncate, hover kebab, inline rename, F2 / Delete keys, active highlight) | Task 6 |
| `ChatHistoryPanel` (empty / loading / error / groups / IO sentinel / delete confirm) | Task 7 |
| Optimistic insert on first send | Task 8 |
| Soft refetch on `turn-completed` MQTT | Task 8 |
| Two-column `/chat/page.tsx` layout | Task 9 |
| Mobile drawer via `<Dialog placement="right">` | Task 9 |
| Remove obsolete WARP-104 comment in `useChat.ts` | Task 8.3(e) |
| Delete the active conversation → redirect to `/chat` | Task 7's `confirmDelete` calls `onNewChat()` when `target.id === activeConversationId`; tested in Step 7.1 ("calls onNewChat after deleting the currently-active conversation") |

No gaps.
