/**
 * The Cameras sub-nav's Recordings chip: recordings are kept per camera, so
 * with one camera it is a plain link, with several it asks which, and with
 * none it is disabled and says why.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { RecordingsNavChip } from "./RecordingsNavChip";

afterEach(cleanup);

const front = { name: "front_door", displayName: "Front door" };
const garage = { name: "garage", displayName: "Garage" };

describe("RecordingsNavChip", () => {
  it("with no cameras is disabled and says to add one", () => {
    render(<RecordingsNavChip cameras={[]} />);
    const chip = screen.getByRole("button", { name: /recordings/i });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.getAttribute("title")).toBe("Add a camera to see recordings");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("with exactly one camera links straight to its recordings", () => {
    render(<RecordingsNavChip cameras={[front]} />);
    const link = screen.getByRole("link", { name: /recordings/i });
    expect(link.getAttribute("href")).toBe("/cameras/front_door/recordings");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("with several cameras opens a menu of them, each going to its own recordings", () => {
    render(<RecordingsNavChip cameras={[front, garage]} />);
    expect(screen.queryByRole("menu")).toBeNull();

    const chip = screen.getByRole("button", { name: /recordings/i });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("menu", { name: /recordings by camera/i });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((a) => a.textContent)).toEqual(["Front door", "Garage"]);
    expect(items.map((a) => a.getAttribute("href"))).toEqual([
      "/cameras/front_door/recordings",
      "/cameras/garage/recordings",
    ]);
  });

  it("closes on choosing a camera, on Escape and on a click elsewhere", () => {
    render(<RecordingsNavChip cameras={[front, garage]} />);
    const chip = screen.getByRole("button", { name: /recordings/i });

    fireEvent.click(chip);
    const item = screen.getByRole("menuitem", { name: "Garage" });
    item.addEventListener("click", (e) => e.preventDefault()); // jsdom: no navigation
    fireEvent.click(item);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(chip);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("encodes a camera name in the path", () => {
    render(<RecordingsNavChip cameras={[{ name: "a b", displayName: "A B" }]} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/cameras/a%20b/recordings");
  });
});
