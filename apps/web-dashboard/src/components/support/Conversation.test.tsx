/**
 * WARP-3528 — the conversation: a public reply and an internal note must never
 * be mistaken for one another, and the history reads as sentences.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import React from "react";
import { Conversation, activitySentence } from "./Conversation";
import { comment } from "./support.test-fixtures";
import type { ConversationEntry } from "./types";

type Activity = Extract<ConversationEntry, { type: "activity" }>;
const act = (over: Partial<Activity>): Activity => ({
  type: "activity",
  id: "a-1",
  verb: "updated",
  field: null,
  from: null,
  to: null,
  actor: { id: "u-1", displayName: "Ada" },
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

const view = (entries: ConversationEntry[] | undefined, over: Partial<React.ComponentProps<typeof Conversation>> = {}) =>
  render(
    <Conversation entries={entries} truncated={false} loading={false} error={false} onRetry={vi.fn()} {...over} />,
  );

describe("replies and notes are told apart", () => {
  it("labels a note 'Internal note — not sent' on a tinted surface, and a reply 'Reply'", () => {
    view([
      comment({ id: "r", visibility: "PUBLIC", html: "<p>Public words</p>" }),
      comment({ id: "n", visibility: "INTERNAL", html: "<p>Private words</p>" }),
    ]);
    const note = screen.getByRole("listitem", { name: "Internal note" });
    const reply = screen.getByRole("listitem", { name: "Reply" });
    expect(note).toHaveClass("sp-entry", "note");
    expect(reply).toHaveClass("sp-entry", "reply");
    expect(note).not.toHaveClass("reply");
    expect(within(note).getByText("Internal note — not sent")).toBeInTheDocument();
    expect(within(reply).getByText("Reply")).toBeInTheDocument();
    expect(within(reply).queryByText(/not sent/i)).toBeNull();
    expect(within(note).getByText("Private words")).toBeInTheDocument();
  });

  it("names the author, and says what kind of party a customer or the system is", () => {
    view([
      comment({ id: "1", author: { id: "u-1", displayName: "Ada" } }),
      comment({ id: "2", authorKind: "CONTACT", author: { id: "c-1", displayName: "Dana Reyes" } }),
      comment({ id: "3", authorKind: "SYSTEM", author: null }),
    ]);
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
    expect(screen.getByText("· Customer")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("keeps the server's already-sanitised paragraphs as paragraphs", () => {
    view([comment({ html: "<p>First</p><p>Second</p>" })]);
    expect(screen.getByText("First").tagName).toBe("P");
    expect(screen.getByText("Second").tagName).toBe("P");
  });
});

describe("the history reads as sentences", () => {
  it.each<[Partial<Activity>, string]>([
    [{ verb: "created" }, "Ada opened this ticket"],
    [{ verb: "state_changed", from: "New", to: "Open" }, "Ada changed the status from New to Open"],
    [{ verb: "assigned", to: "Bo" }, "Ada assigned this to Bo"],
    [{ verb: "unassigned", from: "Bo" }, "Ada took Bo off this ticket"],
    [{ verb: "title_changed", to: "Wi-Fi down" }, "Ada changed the subject to “Wi-Fi down”"],
    [{ verb: "description_changed" }, "Ada edited the details"],
    [{ verb: "label_added", to: "Incident" }, "Ada added the label Incident"],
    [{ verb: "label_removed", from: "Question" }, "Ada removed the label Question"],
    [{ verb: "relation_added", to: "ENG-12" }, "Ada linked this to ENG-12"],
    [{ verb: "relation_removed", from: "a work item" }, "Ada removed a link to a work item"],
    [{ verb: "updated", field: "priority", from: "None", to: "High" }, "Ada changed the priority from None to High"],
    [{ verb: "updated", field: "department", to: "Front desk" }, "Ada moved this to Front desk"],
    [{ verb: "updated", field: "department", to: null }, "Ada cleared the department"],
    [{ verb: "updated", field: "company", to: "Acme" }, "Ada filed this under Acme"],
    [{ verb: "updated", field: "company", to: null }, "Ada cleared the customer"],
    [{ verb: "updated", field: "fields" }, "Ada updated this ticket"],
    [{ verb: "something_new" }, "Ada updated this ticket"],
    [{ verb: "state_changed", from: "a removed status", to: "Open", actor: null }, "Droplet changed the status from a removed status to Open"],
  ])("%j -> %s", (over, sentence) => {
    expect(activitySentence(act(over))).toBe(sentence);
  });

  it("never hides an unknown change", () => {
    view([act({ verb: "from_the_future" })]);
    expect(screen.getByText("Ada updated this ticket")).toBeInTheDocument();
  });
});

describe("states", () => {
  it("shows skeletons while loading, not a spinner", () => {
    view(undefined, { loading: true });
    expect(screen.getByLabelText("Loading the conversation")).toHaveAttribute("aria-busy", "true");
  });

  it("offers Try again on a load failure and calls back", () => {
    const onRetry = vi.fn();
    view(undefined, { error: true, onRetry });
    expect(screen.getByText("Couldn't load the conversation.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("says what appears here when nothing has been said", () => {
    view([]);
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
  });

  it("says plainly when the history was cut short", () => {
    view([comment()], { truncated: true });
    expect(screen.getByRole("status")).toHaveTextContent(/only the most recent entries/i);
  });
});
