/**
 * WARP-883 (ADR-027 WS-5) — Files space switcher (My Files / Household).
 *
 * The switcher sits atop the Files surface and toggles the active space. It
 * only appears when the shared "Household" space is available; with only the
 * personal space it renders nothing (no lone toggle). Selecting a space fires
 * onChange with the space id so the page can re-root the listing.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SpaceSwitcher } from "./SpaceSwitcher";
import type { FileSpace } from "@/lib/types";

const PERSONAL: FileSpace = {
  id: "personal",
  name: "My Files",
  root: "/",
};
const SHARED: FileSpace = {
  id: "shared",
  name: "Household",
  root: "/Household",
  kind: "household",
  state: "active",
};

describe("SpaceSwitcher", () => {
  it("renders both spaces when the shared space is available", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, SHARED]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /my files/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /household/i })).toBeInTheDocument();
  });

  it("marks the active space as selected", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, SHARED]}
        active="shared"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /household/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: /my files/i })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("fires onChange with the chosen space id", () => {
    const onChange = vi.fn();
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, SHARED]}
        active="personal"
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: /household/i }));
    expect(onChange).toHaveBeenCalledWith("shared");
  });

  it("renders nothing when the shared space is not active yet", () => {
    const { container } = render(
      <SpaceSwitcher
        spaces={[PERSONAL, { ...SHARED, state: "pending" }]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("renders nothing when only the personal space is present", () => {
    const { container } = render(
      <SpaceSwitcher spaces={[PERSONAL]} active="personal" onChange={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("uses the shared space's name for its label (not a hardcoded string)", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, { ...SHARED, name: "Family" }]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /family/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^household$/i })).not.toBeInTheDocument();
  });
});
