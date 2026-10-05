// Unit tests for the work-item DetailDrawer — comment composer must revalidate
// the activity feed (the server writes a `commented` PmActivity row in the same
// transaction as the PmComment, so the timeline is stale until refetch). (WARP-882 / ADR-026 P5)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DetailDrawer } from "./detail";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmWorkItem } from "./types";

// Mock the auth layer that every usePm read/write flows through. We hand back
// canned JSON keyed by URL and record every call (with body) so we can assert
// the activity endpoint is re-fetched after a comment post AND that the labels
// editor PATCHes the work item with the chosen label ids.
const calls: { url: string; method: string; body?: unknown }[] = [];

// WARP-3536 — what the heartbeat answers: the OTHER people on the item.
const presence = { viewers: [] as string[] };

const PROJECT_LABELS = [
  { id: "lab-1", projectId: "p", name: "bug", color: "#ef4444" },
  { id: "lab-2", projectId: "p", name: "frontend", color: "#6366f1" },
];

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (resBody: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(resBody) } as Response);

    if (url.endsWith("/comments") && method === "POST") {
      return json({ comment: { id: "c-new", workItemId: "w1", authorId: "u1", commentHtml: "<p>hi</p>", createdAt: "2026-06-22T21:16:00.000Z" } });
    }
    if (url.includes("/comments")) return json({ comments: [], nextCursor: null, total: 0 });
    if (url.includes("/activity")) return json({ activity: [], nextCursor: null, total: 0 });
    if (url.includes("/work-items?parent=")) return json({ work_items: [] });
    if (url.endsWith("/labels")) return json({ labels: PROJECT_LABELS });
    if (url.match(/\/work-items\/[^/]+$/) && method === "PATCH") {
      return json({ work_item: { ...ITEM, labels: PROJECT_LABELS.filter((l) => body?.label_ids?.includes(l.id)) } });
    }
    if (url.endsWith("/presence")) return json({ viewers: presence.viewers });
    if (url.endsWith("/users")) return json({ users: [] });
    return json({});
  }),
}));

const ITEM: PmWorkItem = {
  id: "w1",
  projectId: "p",
  sequenceId: 1,
  key: "INBOX-1",
  name: "First task",
  descriptionHtml: null,
  stateId: "s1",
  state: { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  priority: "none",
  parentId: null,
  cycleId: null,
  department: null,
  assignees: [],
  labels: [],
  startDate: null,
  dueDate: null,
  sortOrder: 1,
  completedAt: null,
  createdById: null,
  commentCount: 0,
  subItemCount: 0,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function renderDrawer() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
        <DetailDrawer item={ITEM} onClose={() => undefined} onChanged={() => undefined} />
      </PeopleContext.Provider>
    </SWRConfig>,
  );
}

describe("DetailDrawer — comment post revalidates activity", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("re-fetches the activity feed after a comment is sent", async () => {
    renderDrawer();

    // Wait for the initial activity read so we can count subsequent ones.
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/activity") && c.method === "GET")).toBe(true);
    });
    const activityReadsBefore = calls.filter((c) => c.url.includes("/activity") && c.method === "GET").length;

    const textarea = screen.getByLabelText("Write a comment");
    fireEvent.change(textarea, { target: { value: "looks good" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));

    // The POST must land …
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/comments") && c.method === "POST")).toBe(true);
    });

    // … and the activity feed must be revalidated (an extra GET) afterwards.
    await waitFor(() => {
      const activityReadsAfter = calls.filter((c) => c.url.includes("/activity") && c.method === "GET").length;
      expect(activityReadsAfter).toBeGreaterThan(activityReadsBefore);
    });
  });
});

describe("DetailDrawer — Labels field can add a label (WARP-948)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("opens a label picker, applies the selection, and PATCHes the work item with label_ids", async () => {
    renderDrawer();

    // The Labels row exposes an affordance to edit labels — not a dead "None".
    const editLabels = await screen.findByRole("button", { name: /add label/i });
    fireEvent.click(editLabels);

    // The project's labels are fetched and offered as selectable options.
    const bugOption = await screen.findByRole("button", { name: /bug/i });
    fireEvent.click(bugOption);

    // Applying the selection PATCHes the work item with the chosen label id.
    await waitFor(() => {
      const patch = calls.find(
        (c) => /\/work-items\/[^/]+$/.test(c.url) && c.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect((patch?.body as { label_ids?: string[] } | undefined)?.label_ids).toContain("lab-1");
    });
  });
});

describe("DetailDrawer — Also viewing (WARP-3536)", () => {
  beforeEach(() => {
    calls.length = 0;
    presence.viewers = [];
  });

  const named = (id: string) => makePerson(id, ({ "u-ben": "Ben Ortiz", "u-cy": "Cy Dunn" } as Record<string, string>)[id] ?? "Tester");

  function renderWithPeople() {
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PeopleContext.Provider value={named}>
          <DetailDrawer item={ITEM} onClose={() => undefined} onChanged={() => undefined} />
        </PeopleContext.Provider>
      </SWRConfig>,
    );
  }

  it("sends the heartbeat for the open item", async () => {
    renderWithPeople();
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/pm/work-items/w1/presence" && c.method === "POST")).toBe(true);
    });
  });

  it("shows who else has it open, by name, in the header beside the key", async () => {
    presence.viewers = ["u-ben", "u-cy"];
    renderWithPeople();

    const group = await screen.findByRole("group", { name: "Also viewing" });
    expect(group.textContent).toContain("Also viewing");
    expect(within(group).getByLabelText("Ben Ortiz")).toBeTruthy();
    expect(within(group).getByLabelText("Cy Dunn")).toBeTruthy();
    // The header is the row that carries the key and the close button.
    // (the key appears twice: the drawer header's first, then the body's)
    const header = screen.getAllByText("INBOX-1")[0]!.parentElement as HTMLElement;
    expect(header.contains(group)).toBe(true);
    expect(header.contains(screen.getByRole("button", { name: "Close" }))).toBe(true);
  });

  it("shows nothing when nobody else is there: no empty label, no placeholder", async () => {
    renderWithPeople();
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/presence"))).toBe(true);
    });
    expect(screen.queryByRole("group", { name: "Also viewing" })).toBeNull();
    expect(screen.queryByText(/Also viewing/)).toBeNull();
  });
});
