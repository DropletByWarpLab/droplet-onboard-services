// The Activity section with the REAL Tiptap editor behind it (WARP-3519).
//
// timeline.test.tsx and comment.test.tsx drive the section through a textarea
// double so they test OUR wiring without ProseMirror. This file is the seam
// between the two: what the composer and the inline editor actually put on the
// wire when a person types, picks somebody with @, and sends or saves.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ToastProvider } from "@/components/Toast";
import { ActivitySection } from "./timeline";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import { editorOf, installJsdomPolyfills, typeText } from "./editor/test-utils";
import type { PmComment, PmTimelineEntry } from "./types";

installJsdomPolyfills();

const h = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; body?: { comment_html?: string } }[],
  timeline: [] as unknown[],
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    h.calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    if (url.includes("/timeline")) {
      return ok({
        timeline: h.timeline,
        refs: { states: {}, labels: {}, workItems: {} },
        nextCursor: null,
        total: h.timeline.length,
      });
    }
    if (url.endsWith("/users")) {
      return ok({
        users: [
          { id: "ada", userId: "u1", username: "ada", displayName: "Ada Lovelace" },
          { id: "bea", userId: "u2", username: "bea", displayName: "Bea Bell" },
        ],
      });
    }
    return ok({ comment: {} });
  }),
}));
vi.mock("framer-motion", async () => ({
  ...(await vi.importActual<object>("framer-motion")),
  useReducedMotion: () => true,
}));

const NAMES: Record<string, string> = { u1: "Ada Lovelace", u2: "Bea Bell" };
const person = (id: string) => makePerson(id, NAMES[id] ?? `User ${id}`);

function ownComment(html: string): PmTimelineEntry {
  const comment: PmComment = {
    id: "c1",
    workItemId: "w1",
    authorId: "u1",
    commentHtml: html,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    editedAt: null,
    deleted: false,
    deletedAt: null,
    deletedById: null,
    mentions: [],
    reactions: [],
  };
  return { type: "comment", id: "c1", at: comment.createdAt, comment };
}

function renderSection() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider>
        <PeopleContext.Provider value={person}>
          <ActivitySection itemId="w1" viewerId="u1" role="family" onChanged={() => undefined} />
        </PeopleContext.Provider>
      </ToastProvider>
    </SWRConfig>,
  );
}

const writes = () => h.calls.filter((c) => c.method !== "GET");
const focusAtEnd = (box: HTMLElement) =>
  act(() => {
    const editor = editorOf(box);
    editor.commands.focus("end");
    editor.view.focus();
  });

beforeEach(() => {
  h.calls.length = 0;
  h.timeline = [];
});

describe("ActivitySection with the real editor", () => {
  it("sends what was typed, with a picked person as a bare mention span, then starts over empty", async () => {
    renderSection();
    const box = await screen.findByRole("textbox", { name: "Write a comment" });
    // The directory has to have arrived before the picker has anyone to offer.
    await waitFor(() => expect(h.calls.some((c) => c.url.endsWith("/users"))).toBe(true));
    const send = screen.getByRole("button", { name: /^Send\b/ });
    expect(send).toBeDisabled();

    focusAtEnd(box);
    typeText(editorOf(box), "ping @be");
    const bea = await screen.findByRole("option", { name: "Bea Bell" });
    expect(bea).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    typeText(editorOf(box), "please look");

    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/pm/work-items/w1/comments", method: "POST" });
    // The one shape the server's sanitizer keeps and parses mentions out of.
    expect(writes()[0].body?.comment_html).toBe(
      '<p>ping <span data-mention-id="u2">@Bea Bell</span> please look</p>',
    );
    await waitFor(() => expect(send).toBeDisabled());
    expect(editorOf(box).getHTML()).toBe("<p></p>");
  });

  it("does not send an empty or whitespace-only comment, by button or by Cmd+Enter", async () => {
    renderSection();
    const box = await screen.findByRole("textbox", { name: "Write a comment" });
    focusAtEnd(box);
    typeText(editorOf(box), "   ");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(screen.getByRole("button", { name: /^Send\b/ })).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });

  it("edits your own comment in place and saves the new html with PATCH", async () => {
    h.timeline = [ownComment('<p>first <span data-mention-id="u2">@Bea Bell</span></p>')];
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const box = await screen.findByRole("textbox", { name: "Edit comment" });
    // The stored mention is loaded as a mention, not as text.
    expect(editorOf(box).getHTML()).toBe('<p>first <span data-mention-id="u2">@Bea Bell</span></p>');

    focusAtEnd(box);
    typeText(editorOf(box), " thanks");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/pm/comments/c1", method: "PATCH" });
    expect(writes()[0].body?.comment_html).toBe(
      '<p>first <span data-mention-id="u2">@Bea Bell</span> thanks</p>',
    );
  });

  it("leaves the section's Escape to the editor: it cancels the edit and goes no further", async () => {
    h.timeline = [ownComment("<p>plain</p>")];
    renderSection();
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
      const box = await screen.findByRole("textbox", { name: "Edit comment" });
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull());
      expect(onWindowKey).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });
});
