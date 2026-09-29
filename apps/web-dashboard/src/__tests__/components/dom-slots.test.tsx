/**
 * WARP-3043 — a DOM slot: a page registers an element, and a component
 * mounted elsewhere (HelpLauncher, beside the routed page) portals into it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createDomSlot, type DomSlot } from "@/components/shell/dom-slots";

afterEach(() => cleanup());

function Registrant({ slot, id, label }: { slot: DomSlot; id: string; label?: string }) {
  const register = slot.useRegister();
  return (
    <span ref={register} data-testid={id}>
      {label}
    </span>
  );
}

function Reader({ slot, seen }: { slot: DomSlot; seen: Array<HTMLElement | null> }) {
  seen.push(slot.useTarget());
  return null;
}

describe("createDomSlot (WARP-3043)", () => {
  it("has no target until something registers, and loses it when that unmounts", () => {
    const slot = createDomSlot();
    const seen: Array<HTMLElement | null> = [];
    const { rerender, getByTestId } = render(<Reader slot={slot} seen={seen} />);
    expect(seen.at(-1)).toBeNull();

    rerender(
      <>
        <Reader slot={slot} seen={seen} />
        <Registrant slot={slot} id="a" />
      </>,
    );
    expect(seen.at(-1)).toBe(getByTestId("a"));

    rerender(<Reader slot={slot} seen={seen} />);
    expect(seen.at(-1)).toBeNull();
  });

  it("an unmounting registrant clears the slot only if it still owns it", () => {
    const slot = createDomSlot();
    const seen: Array<HTMLElement | null> = [];
    const { rerender, getByTestId } = render(
      <>
        <Reader slot={slot} seen={seen} />
        <Registrant key="a" slot={slot} id="a" />
        <Registrant key="b" slot={slot} id="b" />
      </>,
    );
    // The later registrant owns it.
    expect(seen.at(-1)).toBe(getByTestId("b"));

    // A — no longer the owner — goes: B keeps the slot.
    rerender(
      <>
        <Reader slot={slot} seen={seen} />
        <Registrant key="b" slot={slot} id="b" />
      </>,
    );
    expect(seen.at(-1)).toBe(getByTestId("b"));
  });

  it("a re-render of the registrant keeps the same element", () => {
    const slot = createDomSlot();
    const seen: Array<HTMLElement | null> = [];
    const { rerender, getByTestId } = render(
      <>
        <Reader slot={slot} seen={seen} />
        <Registrant slot={slot} id="a" label="one" />
      </>,
    );
    const first = getByTestId("a");
    expect(seen.at(-1)).toBe(first);
    const before = seen.length;

    rerender(
      <>
        <Reader slot={slot} seen={seen} />
        <Registrant slot={slot} id="a" label="two" />
      </>,
    );
    expect(getByTestId("a")).toBe(first);
    // Every read since — including the re-render's — saw the same element,
    // never a null in between.
    expect(seen.slice(before).every((t) => t === first)).toBe(true);
  });
});
