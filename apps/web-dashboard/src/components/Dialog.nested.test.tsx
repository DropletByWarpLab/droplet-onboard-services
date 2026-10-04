// A dialog opened from inside another dialog (a confirm over a drawer, a delete
// confirm over the project settings) is a React DESCENDANT of the outer one even
// though it is portal-mounted elsewhere in the DOM, so its Tab keydowns bubble
// through the outer dialog's React tree. The outer focus trap must not treat
// them as its own: focus belongs to the topmost dialog.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog } from "./Dialog";

const noop = () => undefined;

function Nested() {
  return (
    <Dialog open onClose={noop} labelledBy="outer-title">
      <h2 id="outer-title">Outer</h2>
      <button type="button">outer-1</button>
      <button type="button">outer-2</button>
      <Dialog open onClose={noop} labelledBy="inner-title">
        <h2 id="inner-title">Inner</h2>
        <button type="button">inner-1</button>
        <button type="button">inner-2</button>
      </Dialog>
    </Dialog>
  );
}

describe("nested dialogs keep their own focus trap", () => {
  it("Tab past the last control of the inner dialog wraps inside the inner dialog", () => {
    render(<Nested />);
    const innerLast = screen.getByRole("button", { name: "inner-2" });
    innerLast.focus();
    fireEvent.keyDown(innerLast, { key: "Tab" });
    expect(screen.getByRole("button", { name: "inner-1" })).toHaveFocus();
  });

  it("Shift+Tab before the first control of the inner dialog wraps to its last", () => {
    render(<Nested />);
    const innerFirst = screen.getByRole("button", { name: "inner-1" });
    innerFirst.focus();
    fireEvent.keyDown(innerFirst, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "inner-2" })).toHaveFocus();
  });

  it("still traps the outer dialog on its own", () => {
    render(<Nested />);
    const outerLast = screen.getByRole("button", { name: "outer-2" });
    outerLast.focus();
    fireEvent.keyDown(outerLast, { key: "Tab" });
    expect(screen.getByRole("button", { name: "outer-1" })).toHaveFocus();
  });
});
