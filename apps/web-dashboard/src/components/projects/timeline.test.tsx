// ActivitySection (WARP-3519): the merged comment + activity thread, its
// filter, its loading / empty / error / truncated states, and the composer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ToastProvider } from "@/components/Toast";
import { ActivitySection } from "./timeline";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmActivity, PmComment, PmTimelineEntry, PmTimelineRefs } from "./types";

const h = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; body?: unknown }[],
  handler: null as null | ((url: string, init?: RequestInit) => Promise<unknown>),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    h.calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return h.handler!(url, init);
  }),
}));
vi.mock("./editor/RichTextEditor", () => import("./fakeEditor"));
vi.mock("framer-motion", async () => ({
  ...(await vi.importActual<object>("framer-motion")),
  useReducedMotion: () => true,
}));

const ok = (body: unknown = {}) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const fail = (status = 500, error = "boom") =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) } as Response);

const NAMES: Record<string, string> = { u1: "Ada Lovelace", u2: "Bea Bell" };
const person = (id: string) => makePerson(id, NAMES[id] ?? `User ${id}`);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function comment(id: string, over: Partial<PmComment> = {}): PmComment {
  return {
    id,
    workItemId: "w1",
    authorId: "u2",
    commentHtml: `<p>Comment ${id}</p>`,
    createdAt: ago(30),
    updatedAt: ago(30),
    editedAt: null,
    deleted: false,
    deletedAt: null,
    deletedById: null,
    mentions: [],
    reactions: [],
    ...over,
  };
}

const commentEntry = (id: string, over: Partial<PmComment> = {}): PmTimelineEntry => {
  const c = comment(id, over);
  return { type: "comment", id, at: c.createdAt, comment: c };
};

const activityEntry = (id: string, over: Partial<PmActivity> = {}): PmTimelineEntry => {
  const activity: PmActivity = {
    id,
    workItemId: "w1",
    actorId: "u1",
    verb: "created",
    field: null,
    oldValue: null,
    newValue: null,
    createdAt: ago(60),
    ...over,
  };
  return { type: "activity", id, at: activity.createdAt, activity };
};

const REFS: PmTimelineRefs = {
  states: { s2: "In Progress" },
  labels: {},
  workItems: {},
};

const DIRECTORY = [
  { id: "ada", userId: "u1", username: "ada", displayName: "Ada Lovelace" },
  { id: "bea", userId: "u2", username: "bea", displayName: "Bea Bell" },
  { id: "ghost", userId: null, username: "ghost", displayName: "No Local Row" },
];

let timeline: PmTimelineEntry[] = [];

/** The default server: a one-page timeline and the people directory. */
function serve() {
  h.handler = (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/timeline")) {
      return ok({ timeline, refs: REFS, nextCursor: null, total: timeline.length });
    }
    if (url.endsWith("/users")) return ok({ users: DIRECTORY });
    return ok(method === "POST" ? { comment: comment("new") } : {});
  };
}

function renderSection(opts: { viewerId?: string; role?: string; onChanged?: () => void } = {}) {
  const onChanged = opts.onChanged ?? vi.fn();
  const view = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider>
        <PeopleContext.Provider value={person}>
          <ActivitySection
            itemId="w1"
            viewerId={opts.viewerId ?? "u1"}
            role={opts.role ?? "family"}
            onChanged={onChanged}
          />
        </PeopleContext.Provider>
      </ToastProvider>
    </SWRConfig>,
  );
  return { onChanged, ...view };
}

const timelineReads = () => h.calls.filter((c) => c.method === "GET" && c.url.includes("/timeline")).length;
const writes = () => h.calls.filter((c) => c.method !== "GET");
const composer = () => screen.getByRole("textbox", { name: "Write a comment" });
const pill = (name: string) => screen.getByRole("button", { name });
// "Send ⌘↵", but not "Sending… ⌘↵".
const sendButton = () => screen.getByRole("button", { name: /^Send\b/ });

beforeEach(() => {
  h.calls.length = 0;
  timeline = [];
  serve();
});

describe("ActivitySection — the thread", () => {
  beforeEach(() => {
    timeline = [
      activityEntry("a1", { verb: "created" }),
      commentEntry("c1", { commentHtml: "<p>First comment</p>" }),
      activityEntry("a2", { verb: "state_changed", newValue: "s2", createdAt: ago(20) }),
      commentEntry("c2", { authorId: "u1", commentHtml: "<p>Second comment</p>" }),
    ];
  });

  it("shows comments and activity interleaved, in the order the server sent them (newest last)", async () => {
    renderSection();

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("created this item");
    expect(items[1].textContent).toContain("First comment");
    expect(items[2].textContent).toContain("moved this to In Progress");
    expect(items[3].textContent).toContain("Second comment");
  });

  it("titles the section 'Activity' with the total", async () => {
    renderSection();
    expect(await screen.findByRole("heading", { name: "Activity 4" })).toBeInTheDocument();
  });

  it("writes an activity row as '<Actor> <sentence> · <relative time>', names from the page's refs", async () => {
    renderSection();
    const items = await screen.findAllByRole("listitem");
    expect(items[2].textContent).toBe("Ada Lovelace moved this to In Progress · 20 minutes ago");
  });

  it("attributes an activity row with no actor to Droplet AI", async () => {
    timeline = [activityEntry("a1", { actorId: null, verb: "archived" })];
    renderSection();
    const [row] = await screen.findAllByRole("listitem");
    expect(row.textContent).toContain("Droplet AI archived this item");
    expect(row.querySelector(".pm-ai-av")?.textContent).toBe("AI");
  });

  it("does not crash on a verb a newer server invented", async () => {
    timeline = [activityEntry("a1", { verb: "teleported" as PmActivity["verb"] })];
    renderSection();
    const [row] = await screen.findAllByRole("listitem");
    expect(row.textContent).toContain("Ada Lovelace did something");
  });

  it("hands each comment the viewer, so the author alone gets Edit", async () => {
    renderSection({ viewerId: "u1", role: "family" });
    await screen.findAllByRole("listitem");
    // Ada (the viewer) wrote c2; Bea wrote c1.
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    const own = screen.getByText("Second comment").closest("li")!;
    expect(within(own).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("re-reads the thread and refreshes the counts after an edit lands", async () => {
    const { onChanged } = renderSection({ viewerId: "u1", role: "family" });
    await screen.findAllByRole("listitem");
    const readsBefore = timelineReads();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), { target: { value: "Better" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(timelineReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()[0]).toMatchObject({ url: "/api/pm/comments/c2", method: "PATCH" });
  });

  it("is read-only for a role that cannot write, composer aside", async () => {
    renderSection({ viewerId: "u1", role: "guest" });
    await screen.findAllByRole("listitem");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull();
    // The composer keeps today's visibility — the server decides who may post.
    expect(composer()).toBeInTheDocument();
  });
});

describe("ActivitySection — filter", () => {
  beforeEach(() => {
    timeline = [
      activityEntry("a1"),
      commentEntry("c1"),
      activityEntry("a2", { verb: "archived" }),
      commentEntry("c2"),
    ];
  });

  it("offers All, Comments and History as toggle buttons, All pressed to start", async () => {
    renderSection();
    await screen.findAllByRole("listitem");
    expect(pill("All")).toHaveAttribute("aria-pressed", "true");
    expect(pill("Comments")).toHaveAttribute("aria-pressed", "false");
    expect(pill("History")).toHaveAttribute("aria-pressed", "false");
  });

  it("Comments shows only the comments, History only what happened", async () => {
    renderSection();
    await screen.findAllByRole("listitem");

    fireEvent.click(pill("Comments"));
    expect(pill("Comments")).toHaveAttribute("aria-pressed", "true");
    expect(pill("All")).toHaveAttribute("aria-pressed", "false");
    let items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Comment c1"),
      expect.stringContaining("Comment c2"),
    ]);

    fireEvent.click(pill("History"));
    items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("created this item");
    expect(items[1].textContent).toContain("archived this item");

    fireEvent.click(pill("All"));
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("says 'No comments yet.' on Comments when the thread is all history", async () => {
    timeline = [activityEntry("a1")];
    renderSection();
    await screen.findAllByRole("listitem");

    fireEvent.click(pill("Comments"));

    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("says 'No activity yet.' on History when the thread is all comments", async () => {
    timeline = [commentEntry("c1")];
    renderSection();
    await screen.findAllByRole("listitem");

    fireEvent.click(pill("History"));

    expect(screen.getByText("No activity yet.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

describe("ActivitySection — states", () => {
  it("shows 'No activity yet.' for a thread with nothing in it, composer still there", async () => {
    renderSection();
    expect(await screen.findByText("No activity yet.")).toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });

  it("shows a skeleton — not the empty copy — while the thread is loading", async () => {
    h.handler = (url) => (url.includes("/timeline") ? new Promise(() => undefined) : ok({ users: [] }));
    const { container } = renderSection();

    await waitFor(() => expect(container.querySelector(".pm-skel")).not.toBeNull());
    expect(screen.queryByText("No activity yet.")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(composer()).toBeInTheDocument();
  });

  it("explains a failed load and offers Try again, which reads it again", async () => {
    h.handler = (url) => (url.includes("/timeline") ? fail(500) : ok({ users: [] }));
    renderSection();

    expect(
      await screen.findByText("Couldn't load activity. Check the appliance connection and try again."),
    ).toBeInTheDocument();
    expect(composer()).toBeInTheDocument();

    timeline = [commentEntry("c1", { commentHtml: "<p>Back again</p>" })];
    serve();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Back again")).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load activity. Check the appliance connection and try again."),
    ).toBeNull();
  });

  it("says how much it is showing when the thread is longer than it will load", async () => {
    let n = 0;
    h.handler = (url) =>
      url.includes("/timeline")
        ? ok({ timeline: [activityEntry(`a${++n}`)], refs: REFS, nextCursor: `c${n}`, total: 37 })
        : ok({ users: [] });
    renderSection();

    expect(await screen.findByText("Showing the first 20 of 37 entries.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
  });

  it("does not show the 'showing the first' line for a thread it loaded whole", async () => {
    timeline = [commentEntry("c1")];
    renderSection();
    await screen.findAllByRole("listitem");
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });
});

describe("ActivitySection — composer", () => {
  it("labels and hints the editor 'Write a comment' and starts with Send disabled", async () => {
    renderSection();
    await screen.findByText("No activity yet.");
    expect(composer()).toHaveAttribute("placeholder", "Write a comment");
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("⌘↵")).toBeInTheDocument();
    expect(screen.getByText("Write · confirm to apply")).toBeInTheDocument();
  });

  it("offers the people in the directory who have a local account as @mention candidates", async () => {
    renderSection();
    await waitFor(() => expect(composer()).toHaveAttribute("data-mention-candidates", "u1=Ada Lovelace,u2=Bea Bell"));
  });

  it("tells the editor the people are unavailable when the directory cannot be read", async () => {
    h.handler = (url) => (url.endsWith("/users") ? fail(403, "forbidden") : ok({ timeline: [], refs: REFS, nextCursor: null, total: 0 }));
    renderSection();
    await screen.findByText("No activity yet.");
    expect(composer()).toHaveAttribute("data-mention-candidates", "unavailable");
  });

  it("sends the comment, clears the editor, re-reads the thread and refreshes the counts", async () => {
    const { onChanged } = renderSection();
    await screen.findByText("No activity yet.");
    const readsBefore = timelineReads();

    fireEvent.change(composer(), { target: { value: "looks good" } });
    expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());

    await waitFor(() => expect(timelineReads()).toBeGreaterThan(readsBefore));
    expect(writes()).toEqual([
      {
        url: "/api/pm/work-items/w1/comments",
        method: "POST",
        body: { comment_html: "<p>looks good</p>" },
      },
    ]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(composer()).toHaveValue("");
    expect(sendButton()).toBeDisabled();
  });

  it("says 'Sending…' and cannot be sent twice while the request is in flight", async () => {
    let finish: (v: unknown) => void = () => undefined;
    h.handler = (url, init) =>
      (init?.method ?? "GET") === "POST"
        ? new Promise((r) => (finish = r))
        : url.includes("/timeline")
          ? ok({ timeline: [], refs: REFS, nextCursor: null, total: 0 })
          : ok({ users: [] });
    renderSection();
    await screen.findByText("No activity yet.");
    fireEvent.change(composer(), { target: { value: "once" } });

    fireEvent.click(sendButton());
    fireEvent.keyDown(composer(), { key: "Enter", metaKey: true });

    expect(screen.getByRole("button", { name: /Sending…/ })).toBeDisabled();
    expect(writes()).toHaveLength(1);

    finish({ ok: true, status: 201, json: () => Promise.resolve({}) });
    await waitFor(() => expect(sendButton()).toBeDisabled());
  });

  it("⌘↵ sends, and does nothing on an empty editor", async () => {
    renderSection();
    await screen.findByText("No activity yet.");

    fireEvent.keyDown(composer(), { key: "Enter", metaKey: true });
    expect(writes()).toHaveLength(0);

    fireEvent.change(composer(), { target: { value: "via keyboard" } });
    fireEvent.keyDown(composer(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ comment_html: "<p>via keyboard</p>" });
  });

  it("keeps what was typed and tells the person, in plain words, when sending fails", async () => {
    h.handler = (url, init) =>
      (init?.method ?? "GET") === "POST"
        ? fail(500)
        : url.includes("/timeline")
          ? ok({ timeline: [], refs: REFS, nextCursor: null, total: 0 })
          : ok({ users: [] });
    renderSection();
    await screen.findByText("No activity yet.");
    fireEvent.change(composer(), { target: { value: "do not lose me" } });

    fireEvent.click(sendButton());

    expect(
      await screen.findByText("We couldn't save that change right now. Try again in a moment."),
    ).toBeInTheDocument();
    expect(composer()).toHaveValue("do not lose me");
    expect(sendButton()).toBeEnabled();
  });
});
