/**
 * WARP-1875 — keyboard contract for the email-citation viewer.
 *
 * The viewer has to portal to `document.body`: a citation renders wherever an
 * answer renders, and on Home that is inside a `.bento` widget shell, which is
 * a query container (`container-type: inline-size`) and therefore a containing
 * block for `position: fixed` descendants. Rendered in place the scrim would
 * resolve `inset: 0` against a ~240px tile and then be clipped by it.
 *
 * Portalling ALONE, though, is a regression for keyboard users. Before the
 * portal the dialog was the trigger's next DOM sibling, so Tab stepped into it.
 * At the end of `document.body` with `aria-modal="true"` and no focus
 * management, Tab lands on whatever follows the trigger — behind the scrim, in
 * a subtree `aria-modal` has just told assistive tech does not exist — and
 * Escape does nothing.
 *
 * So the viewer goes through the <Dialog> primitive (WARP-289), which owns the
 * portal AND the focus trap / initial focus / Escape / focus restore /
 * scroll-lock. This file is the guard that it keeps going through it: every
 * assertion below fails against a hand-rolled `fixed inset-0` div.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { EmailCitation } from "../EmailCitation";

const anchor = { kind: "email-part", messageId: "<m1@x>", partIndex: 1 } as const;

const hit = {
  fileId: "f-1",
  filename: "quote.eml",
  mimeType: "message/rfc822",
  chunkText: "the quoted body text",
  score: 0.9,
  anchor,
};

function renderCitation() {
  const view = render(<EmailCitation hit={hit} anchor={anchor} />);
  return { ...view, trigger: screen.getByTestId("email-card") };
}

describe("<EmailCitation> viewer keyboard contract", () => {
  it("portals the viewer out of the trigger's subtree", () => {
    const { container, trigger } = renderCitation();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(
      container.contains(dialog),
      "the viewer must portal to document.body — inside a `.bento` query " +
        "container a `position: fixed` scrim resolves against the tile",
    ).toBe(false);
  });

  it("names the dialog from its own heading rather than claiming a bare label", () => {
    const { trigger } = renderCitation();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy, "dialog has no aria-labelledby").toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("quote.eml");
  });

  it("moves focus INTO the dialog on open", async () => {
    const { trigger } = renderCitation();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(
        dialog.contains(document.activeElement),
        "focus stayed outside the dialog, so `aria-modal` is a lie: Tab walks " +
          "into content the screen reader has been told is not there",
      ).toBe(true);
    });
  });

  it("closes on Escape", async () => {
    const { trigger } = renderCitation();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("returns focus to the citation chip on close", async () => {
    const { trigger } = renderCitation();
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(
        document.activeElement,
        "focus was dropped on the body — a keyboard user loses their place in " +
          "the answer they were reading",
      ).toBe(trigger);
    });
  });

  it("still renders the part metadata the viewer exists for", () => {
    const { trigger } = renderCitation();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("<m1@x>");
    expect(dialog.textContent).toContain("#1");
    expect(dialog.textContent).toContain("the quoted body text");
  });
});
