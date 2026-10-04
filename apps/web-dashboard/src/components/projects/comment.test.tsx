// CommentCard + ReactionBar (WARP-3519): who may edit / delete / react, the
// tombstone, the AI treatment, and the optimistic reaction + inline edit +
// delete-confirm flows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PM_REACTION_EMOJI } from "@droplet/shared-types";
import { ToastProvider } from "@/components/Toast";
import { CommentCard } from "./comment";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmComment } from "./types";

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
// Skip framer-motion's enter/exit animation so dialogs open and close at once.
vi.mock("framer-motion", async () => ({
  ...(await vi.importActual<object>("framer-motion")),
  useReducedMotion: () => true,
}));

const ok = (body: unknown = {}) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const fail = (status = 500, error = "boom") =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) } as Response);

const NAMES: Record<string, string> = {
  u1: "Ada Lovelace",
  u2: "Bea Bell",
  u3: "Cy Young",
  u4: "Di Dunn",
  u5: "Ed Eaves",
  u6: "Flo Fox",
  u7: "Gus Gray",
};
const person = (id: string) => makePerson(id, NAMES[id] ?? `User ${id}`);

const [UP, , , , , HEART, ROCKET] = PM_REACTION_EMOJI;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function comment(over: Partial<PmComment> = {}): PmComment {
  return {
    id: "c1",
    workItemId: "w1",
    authorId: "u2",
    commentHtml: "<p>Hello <strong>team</strong></p>",
    createdAt: ago(5),
    updatedAt: ago(5),
    editedAt: null,
    deleted: false,
    deletedAt: null,
    deletedById: null,
    mentions: [],
    reactions: [],
    ...over,
  };
}

const TOMBSTONE = (over: Partial<PmComment> = {}) =>
  comment({ commentHtml: "", deleted: true, deletedAt: ago(2), deletedById: "u3", ...over });

function tree(
  c: PmComment,
  { viewerId = "u1", role = "family", onChanged = vi.fn() as () => void | Promise<void> } = {},
) {
  return (
    <ToastProvider>
      <PeopleContext.Provider value={person}>
        <CommentCard comment={c} viewerId={viewerId} role={role} mentionCandidates={[]} onChanged={onChanged} />
      </PeopleContext.Provider>
    </ToastProvider>
  );
}

function renderCard(c: PmComment, opts: { viewerId?: string; role?: string } = {}) {
  const onChanged = vi.fn();
  const view = render(tree(c, { ...opts, onChanged }));
  return { onChanged, ...view };
}

const button = (name: string | RegExp) => screen.queryByRole("button", { name });
const requests = () => h.calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  h.calls.length = 0;
  h.handler = () => ok({});
});

describe("CommentCard — what is on the card", () => {
  it("shows the author, a relative time and the server-sanitized html", () => {
    renderCard(comment());
    expect(screen.getByText("Bea Bell")).toBeInTheDocument();
    expect(screen.getByText("5 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("team").tagName).toBe("STRONG");
  });

  it("marks an edited comment with '(edited)' and the edit time in its title", () => {
    renderCard(comment({ editedAt: ago(1) }));
    const marker = screen.getByText("(edited)");
    expect(marker.getAttribute("title")).toBeTruthy();
  });

  it("has no '(edited)' marker on a comment that was never edited", () => {
    renderCard(comment());
    expect(screen.queryByText("(edited)")).toBeNull();
  });

  it("renders an AI comment as Droplet AI, in the aurora bubble, with the AI avatar", () => {
    const { container } = renderCard(comment({ authorId: null, commentHtml: "<p>Done.</p>" }));
    expect(screen.getByText("Droplet AI")).toBeInTheDocument();
    expect(container.querySelector(".pm-ai-av")?.textContent).toBe("AI");
    expect(container.querySelector(".pm-prose.pm-ai-bubble")).not.toBeNull();
  });

  it("a deleted comment is a tombstone: sentence, who and when, no body, no reactions, no actions", () => {
    const { container } = renderCard(
      TOMBSTONE({ reactions: [{ emoji: UP, count: 1, userIds: ["u1"] }] }),
      { viewerId: "u3", role: "admin" },
    );
    expect(screen.getByText("This comment was deleted.")).toBeInTheDocument();
    expect(screen.getByText(/by Cy Young/)).toBeInTheDocument();
    expect(screen.getByText("2 minutes ago")).toBeInTheDocument();
    expect(container.querySelector(".pm-prose")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("a tombstone with no known deleter says only that it was deleted", () => {
    renderCard(TOMBSTONE({ deletedById: null, deletedAt: null }));
    const tomb = screen.getByText("This comment was deleted.").parentElement!;
    expect(tomb.textContent).toBe("This comment was deleted.");
  });
});

describe("CommentCard — who gets which affordance", () => {
  it("the author (family) can Edit and Delete their own comment", () => {
    renderCard(comment({ authorId: "u1" }), { viewerId: "u1", role: "family" });
    expect(button("Edit")).toBeInTheDocument();
    expect(button("Delete")).toBeInTheDocument();
  });

  it("another family member gets neither Edit nor Delete", () => {
    renderCard(comment({ authorId: "u2" }), { viewerId: "u1", role: "family" });
    expect(button("Edit")).toBeNull();
    expect(button("Delete")).toBeNull();
  });

  it("an owner or admin can Delete somebody else's comment but never Edit it", () => {
    for (const role of ["owner", "admin"]) {
      const { unmount } = renderCard(comment({ authorId: "u2" }), { viewerId: "u1", role });
      expect(button("Delete"), role).toBeInTheDocument();
      expect(button("Edit"), role).toBeNull();
      unmount();
    }
  });

  it("an AI comment can be deleted by an admin only, and edited by nobody", () => {
    const ai = comment({ authorId: null });
    const { unmount } = renderCard(ai, { viewerId: "u1", role: "family" });
    expect(button("Delete")).toBeNull();
    expect(button("Edit")).toBeNull();
    unmount();

    renderCard(ai, { viewerId: "u1", role: "admin" });
    expect(button("Delete")).toBeInTheDocument();
    expect(button("Edit")).toBeNull();
  });

  it("does not offer Edit on a comment the editor cannot round-trip (a heading would be flattened)", () => {
    renderCard(comment({ authorId: "u1", commentHtml: "<h2>Plan</h2><p>x</p>" }), { viewerId: "u1" });
    expect(button("Edit")).toBeNull();
    expect(button("Delete")).toBeInTheDocument();
  });

  it("a read-only role sees the thread with no Edit, Delete or reaction buttons at all", () => {
    renderCard(
      comment({ authorId: "u1", reactions: [{ emoji: UP, count: 2, userIds: ["u2", "u3"] }] }),
      { viewerId: "u1", role: "guest" },
    );
    expect(button("Edit")).toBeNull();
    expect(button("Delete")).toBeNull();
    expect(button("Add reaction")).toBeNull();
    // The existing tally is still information — just not a control.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

describe("ReactionBar", () => {
  const withReactions = () =>
    comment({
      reactions: [
        { emoji: UP, count: 2, userIds: ["u1", "u3"] },
        { emoji: HEART, count: 1, userIds: ["u3"] },
      ],
    });

  it("shows a chip per reaction, labelled '{emoji} {count}', pressed for the viewer's own", () => {
    renderCard(withReactions(), { viewerId: "u1" });
    expect(button(`${UP} 2`)).toHaveAttribute("aria-pressed", "true");
    expect(button(`${HEART} 1`)).toHaveAttribute("aria-pressed", "false");
  });

  it("lists who reacted in the chip title", () => {
    renderCard(withReactions(), { viewerId: "u1" });
    expect(button(`${UP} 2`)).toHaveAttribute("title", "Ada Lovelace, Cy Young");
  });

  it("caps the title at five names, then 'and N more'", () => {
    const seven = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"];
    renderCard(comment({ reactions: [{ emoji: UP, count: 7, userIds: seven }] }), { viewerId: "u1" });
    expect(button(`${UP} 7`)).toHaveAttribute(
      "title",
      "Ada Lovelace, Bea Bell, Cy Young, Di Dunn, Ed Eaves and 2 more",
    );
  });

  it("flips the chip at once on click, then POSTs the reaction and refreshes", async () => {
    let finish: (v: unknown) => void = () => undefined;
    h.handler = () => new Promise((r) => (finish = r));
    const { onChanged } = renderCard(withReactions(), { viewerId: "u1" });

    fireEvent.click(button(`${HEART} 1`)!);

    // Optimistic: pressed and counted before the server has answered.
    expect(button(`${HEART} 2`)).toHaveAttribute("aria-pressed", "true");
    expect(requests()).toEqual([
      { url: "/api/pm/comments/c1/reactions", method: "POST", body: { emoji: HEART } },
    ]);
    expect(onChanged).not.toHaveBeenCalled();

    finish({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("clicking your own reaction takes it back with a DELETE (emoji percent-encoded)", async () => {
    const { onChanged } = renderCard(withReactions(), { viewerId: "u1" });

    fireEvent.click(button(`${UP} 2`)!);

    expect(button(`${UP} 1`)).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(requests()).toEqual([
      {
        url: `/api/pm/comments/c1/reactions?emoji=${encodeURIComponent(UP)}`,
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("rolls the chip back and says so when the server refuses", async () => {
    h.handler = () => fail(500);
    const { onChanged } = renderCard(withReactions(), { viewerId: "u1" });

    fireEvent.click(button(`${HEART} 1`)!);
    expect(button(`${HEART} 2`)).toBeInTheDocument();

    expect(await screen.findByText("Couldn't add that reaction — try again.")).toBeInTheDocument();
    await waitFor(() => expect(button(`${HEART} 1`)).toHaveAttribute("aria-pressed", "false"));
    expect(button(`${HEART} 2`)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("'Add reaction' opens the eight allowlisted reactions inline, named for assistive tech", () => {
    renderCard(comment(), { viewerId: "u1" });
    const add = button("Add reaction")!;
    expect(add).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(add);

    expect(add).toHaveAttribute("aria-expanded", "true");
    for (const name of ["thumbs up", "thumbs down", "smile", "party", "confused", "heart", "rocket", "eyes"]) {
      expect(button(name), name).toBeInTheDocument();
    }
  });

  it("picking one adds it, closes the row and hands focus back to 'Add reaction'", async () => {
    renderCard(comment(), { viewerId: "u1" });
    fireEvent.click(button("Add reaction")!);

    fireEvent.click(button("rocket")!);

    expect(requests()).toEqual([
      { url: "/api/pm/comments/c1/reactions", method: "POST", body: { emoji: ROCKET } },
    ]);
    expect(button("rocket")).toBeNull();
    expect(button("Add reaction")).toHaveFocus();
    await waitFor(() => expect(button(`${ROCKET} 1`)).toBeNull()); // prop never changed → rolls back to server state
  });

  it("Escape closes the row without closing the drawer around it", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      renderCard(comment(), { viewerId: "u1" });
      fireEvent.click(button("Add reaction")!);

      fireEvent.keyDown(button("heart")!, { key: "Escape" });

      expect(button("heart")).toBeNull();
      expect(button("Add reaction")).toHaveFocus();
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });
});

describe("CommentCard — inline edit", () => {
  const mine = () => comment({ authorId: "u1" });

  it("swaps the body for the editor, prefilled, with Save and Cancel", () => {
    const { container } = renderCard(mine(), { viewerId: "u1" });

    fireEvent.click(button("Edit")!);

    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    expect(editor).toHaveValue("Hello team");
    expect(container.querySelector(".pm-prose")).toBeNull();
    expect(button("Save")).toBeInTheDocument();
    expect(button("Cancel")).toBeInTheDocument();
  });

  it("Save PATCHes { comment_html }, refreshes, closes and returns focus to Edit", async () => {
    const { onChanged } = renderCard(mine(), { viewerId: "u1" });
    fireEvent.click(button("Edit")!);

    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), {
      target: { value: "Hello world" },
    });
    fireEvent.click(button("Save")!);

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(requests()).toEqual([
      { url: "/api/pm/comments/c1", method: "PATCH", body: { comment_html: "<p>Hello world</p>" } },
    ]);
    // The form closes once the thread has been re-read, not before.
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(button("Edit")).toHaveFocus();
  });

  it("⌘↵ saves", async () => {
    const { onChanged } = renderCard(mine(), { viewerId: "u1" });
    fireEvent.click(button("Edit")!);
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    fireEvent.change(editor, { target: { value: "Via keyboard" } });

    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(requests()[0]).toMatchObject({ body: { comment_html: "<p>Via keyboard</p>" } });
  });

  it("Cancel closes without a request and brings the original body back", () => {
    const { container } = renderCard(mine(), { viewerId: "u1" });
    fireEvent.click(button("Edit")!);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), {
      target: { value: "never sent" },
    });

    fireEvent.click(button("Cancel")!);

    expect(requests()).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(container.querySelector(".pm-prose")?.textContent).toBe("Hello team");
    expect(button("Edit")).toHaveFocus();
  });

  it("Escape cancels the edit and does not also close the drawer around it", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      renderCard(mine(), { viewerId: "u1" });
      fireEvent.click(button("Edit")!);

      fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit comment" }), { key: "Escape" });

      expect(screen.queryByRole("textbox")).toBeNull();
      expect(requests()).toHaveLength(0);
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("cannot save an emptied comment (Delete is how a comment goes away)", () => {
    renderCard(mine(), { viewerId: "u1" });
    fireEvent.click(button("Edit")!);
    const editor = screen.getByRole("textbox", { name: "Edit comment" });

    fireEvent.change(editor, { target: { value: "   " } });

    expect(button("Save")).toBeDisabled();
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(requests()).toHaveLength(0);
  });

  it("keeps the editor and the draft open, and says so, when the save fails", async () => {
    h.handler = () => fail(500);
    const { onChanged } = renderCard(mine(), { viewerId: "u1" });
    fireEvent.click(button("Edit")!);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), { target: { value: "Keep me" } });

    fireEvent.click(button("Save")!);

    expect(await screen.findByText("Couldn't edit that comment — try again.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue("Keep me");
    expect(button("Save")).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("CommentCard — delete", () => {
  const mine = () => comment({ authorId: "u1" });
  const openConfirm = () => {
    fireEvent.click(button("Delete")!);
    return screen.getByRole("dialog");
  };

  it("asks first, in the contract's words", () => {
    renderCard(mine(), { viewerId: "u1" });
    const dialog = openConfirm();
    expect(within(dialog).getByText("Delete this comment?")).toBeInTheDocument();
    expect(within(dialog).getByText("It will be removed from the thread. This can't be undone.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(requests()).toHaveLength(0);
  });

  it("Cancel sends nothing, closes the dialog and returns focus to Delete", async () => {
    renderCard(mine(), { viewerId: "u1" });
    const dialog = openConfirm();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(requests()).toHaveLength(0);
    await waitFor(() => expect(button("Delete")).toHaveFocus());
  });

  it("Delete DELETEs the comment, refreshes and closes the dialog", async () => {
    const { onChanged } = renderCard(mine(), { viewerId: "u1" });
    const dialog = openConfirm();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(requests()).toEqual([{ url: "/api/pm/comments/c1", method: "DELETE", body: undefined }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an admin deleting somebody else's comment goes through the same confirm", async () => {
    const { onChanged } = renderCard(comment({ authorId: "u2" }), { viewerId: "u1", role: "admin" });
    const dialog = openConfirm();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(requests()[0].method).toBe("DELETE");
  });

  it("stays open and says so when the delete fails", async () => {
    h.handler = () => fail(500);
    const { onChanged } = renderCard(mine(), { viewerId: "u1" });
    const dialog = openConfirm();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Couldn't delete that comment — try again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the confirm: the drawer's focus trap must not hear it through the React tree", () => {
    const heard = vi.fn();
    render(
      <div onKeyDown={heard}>
        <ToastProvider>
          <PeopleContext.Provider value={person}>
            <CommentCard comment={mine()} viewerId="u1" role="family" mentionCandidates={[]} onChanged={() => undefined} />
          </PeopleContext.Provider>
        </ToastProvider>
      </div>,
    );
    const dialog = openConfirm();

    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Delete" }), { key: "Tab" });

    expect(heard).not.toHaveBeenCalled();
  });

  it("moves focus to the tombstone once the comment turns into one (focus must not fall to <body>)", async () => {
    function Harness() {
      const [c, setC] = useState(mine());
      return tree(c, { viewerId: "u1", onChanged: () => setC(TOMBSTONE({ authorId: "u1", deletedById: "u1" })) });
    }
    const { container } = render(<Harness />);
    const dialog = openConfirm();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("This comment was deleted.")).toBeInTheDocument());
    await waitFor(() => expect(container.querySelector(".pm-tombstone")).toHaveFocus());
  });
});
