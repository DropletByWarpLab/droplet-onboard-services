// Unit tests for the work-item DetailDrawer — the comment composer must
// revalidate the merged activity timeline (the server writes a `commented`
// PmActivity row in the same transaction as the PmComment, so the thread is stale
// until refetch). (WARP-882 / ADR-026 P5; the timeline itself is WARP-3519.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DetailDrawer } from "./detail";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmWorkItem } from "./types";

// Mock the auth layer that every usePm read/write flows through. We hand back
// canned JSON keyed by URL and record every call (with body) so we can assert
// the timeline endpoint is re-fetched after a comment post AND that the labels
// editor PATCHes the work item with the chosen label ids. The rich-text editor
// is the plain-textarea double (timeline.test.tsx covers the Activity section
// itself; this file only proves the drawer hosts it).
const calls: { url: string; method: string; body?: unknown }[] = [];

const PROJECT_LABELS = [
  { id: "lab-1", projectId: "p", name: "bug", color: "#ef4444" },
  { id: "lab-2", projectId: "p", name: "frontend", color: "#6366f1" },
];

vi.mock("./editor/RichTextEditor", () => import("./fakeEditor"));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "family" } }),
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (resBody: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(resBody) } as Response);

    if (url.endsWith("/comments") && method === "POST") {
      return json({ comment: { id: "c-new", workItemId: "w1", authorId: "u1", commentHtml: "<p>hi</p>", createdAt: "2026-06-22T21:16:00.000Z" } });
    }
    if (url.includes("/timeline")) {
      return json({ timeline: [], refs: { states: {}, labels: {}, workItems: {} }, nextCursor: null, total: 0 });
    }
    if (url.endsWith("/watchers")) return json({ watchers: [] });
    if (url.includes("/comments")) return json({ comments: [], nextCursor: null, total: 0 });
    if (url.includes("/activity")) return json({ activity: [], nextCursor: null, total: 0 });
    if (url.endsWith("/development")) return json({ links: [{
      id: "dev-1", provider: "GITHUB", kind: "PULL_REQUEST", url: "https://github.com/acme/app/pull/4",
      title: "INBOX-1 fix login", state: "OPEN", author: "octocat", ref: "inbox-1-fix-login",
      number: 4, externalUpdatedAt: "2026-10-04T00:00:00.000Z", repository: { fullName: "acme/app" },
    }] });
    if (url.includes("/work-items?parent=")) return json({ work_items: [] });
    if (url.endsWith("/labels")) return json({ labels: PROJECT_LABELS });
    if (url.match(/\/work-items\/[^/]+$/) && method === "PATCH") {
      return json({ work_item: { ...ITEM, labels: PROJECT_LABELS.filter((l) => body?.label_ids?.includes(l.id)) } });
    }
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

describe("DetailDrawer — comment post revalidates the timeline", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  const timelineReads = () =>
    calls.filter((c) => c.url.includes("/timeline") && c.method === "GET").length;

  it("re-fetches the timeline after a comment is sent", async () => {
    renderDrawer();

    // Wait for the initial timeline read so we can count subsequent ones.
    await waitFor(() => expect(timelineReads()).toBeGreaterThan(0));
    const readsBefore = timelineReads();

    const editor = screen.getByLabelText("Write a comment");
    fireEvent.change(editor, { target: { value: "looks good" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));

    // The POST must land …
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/comments") && c.method === "POST")).toBe(true);
    });

    // … and the thread must be revalidated (an extra GET) afterwards.
    await waitFor(() => expect(timelineReads()).toBeGreaterThan(readsBefore));
  });

  it("hosts the Activity section and the watch control", async () => {
    renderDrawer();
    expect(await screen.findByRole("heading", { name: /^Activity/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Watch" })).toBeInTheDocument();
    // The old append-only Comments section is gone (the filter pill is a button, not a heading).
    expect(screen.queryByRole("heading", { name: /^Comments/ })).toBeNull();
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

describe("DetailDrawer — Development links", () => {
  it("renders linked changes and copies the canonical branch name", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderDrawer();
    const link = await screen.findByRole("link", { name: /PR 4 INBOX-1 fix login open/i });
    expect(link).toHaveAttribute("href", "https://github.com/acme/app/pull/4");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: /copy development branch name/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("inbox-1-first-task"));
  });
});
