/**
 * WARP-2977 P2b (ADR-059 §3.4) — the add / change-an-area side panel.
 *
 * Pins: every input is reachable by its label; a suggestion chip sets the
 * name AND the type; the five type pills and their words; the body sent
 * (trimmed name, only the changed fields plus the version the form was filled
 * from); a rejected save keeps the panel open; and the labelled Close control
 * a full-width phone sheet depends on.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AreaDialog,
  COPY,
  KIND_LABEL,
  KIND_ORDER,
  SUGGESTIONS,
  areaNameProblem,
  type AreaDialogProps,
} from "@/components/security/AreaDialog";
import type { SecurityZoneView } from "@/lib/types";

const ZONE: SecurityZoneView = {
  id: "z-stock",
  name: "Stock room",
  kind: "restricted",
  state: "active",
  version: 7,
  links: [],
};

function renderDialog(over: Partial<AreaDialogProps> = {}) {
  const props: AreaDialogProps = {
    open: true,
    onClose: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  const utils = render(<AreaDialog {...props} />);
  return { ...utils, props };
}

const kindGroup = () => screen.getByRole("group", { name: COPY.kindLabel });

describe("AreaDialog — adding an area", () => {
  it("is a titled dialog whose name input is reachable by its label", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Add an area" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Name")).toHaveAttribute("maxLength", "60");
  });

  it("offers exactly the five area types, in the owner's words", () => {
    renderDialog();
    const pills = within(kindGroup()).getAllByRole("button");
    expect(pills.map((b) => b.textContent)).toEqual(["Way in", "Inside", "Outside", "Parking", "Staff only"]);
    expect(KIND_ORDER.map((k) => KIND_LABEL[k])).toEqual(["Way in", "Inside", "Outside", "Parking", "Staff only"]);
    expect(pills.every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it.each([
    ["Front door", "Way in", "entry"],
    ["Stock room", "Staff only", "restricted"],
    ["Shop floor", "Inside", "interior"],
    ["Car park", "Parking", "parking"],
  ])("the '%s' suggestion fills the name and picks %s", async (name, kindText, kind) => {
    const { props } = renderDialog();
    fireEvent.click(within(screen.getByRole("group", { name: COPY.suggestions })).getByRole("button", { name }));
    expect(screen.getByLabelText("Name")).toHaveValue(name);
    expect(within(kindGroup()).getByRole("button", { name: kindText })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith({ name, kind }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("has exactly the four suggestions the spec names", () => {
    expect(SUGGESTIONS.map((s) => s.name)).toEqual(["Front door", "Stock room", "Shop floor", "Car park"]);
  });

  it("sends the trimmed name and the chosen type", async () => {
    const { props } = renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Side gate  " } });
    fireEvent.click(within(kindGroup()).getByRole("button", { name: "Outside" }));
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith({ name: "Side gate", kind: "perimeter" }));
  });

  it("refuses an empty name, and a missing type, without calling the server", async () => {
    const { props } = renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    fireEvent.click(within(kindGroup()).getByRole("button", { name: "Inside" }));
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    expect(await screen.findByRole("alert")).toHaveTextContent(COPY.nameRequired);
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Till" } });
    fireEvent.click(within(kindGroup()).getByRole("button", { name: "Inside" })); // still chosen
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("asks for a type when none is chosen", async () => {
    const { props } = renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Till" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    expect(await screen.findByRole("alert")).toHaveTextContent(COPY.kindRequired);
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("stays open when the save is rejected (the panel has shown why)", async () => {
    const onCreate = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "ZONE_NAME_TAKEN", status: 409 }));
    const { props } = renderDialog({ onCreate });
    fireEvent.click(screen.getByRole("button", { name: "Front door" }));
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: COPY.add })).not.toBeDisabled());
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("renders a labelled Close control that closes it (a phone sheet has no backdrop to tap)", () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("AreaDialog — changing an area", () => {
  it("is prefilled, offers no suggestions, and sends only what changed plus the version it was filled from", async () => {
    const { props } = renderDialog({ zone: ZONE });
    expect(screen.getByRole("dialog", { name: COPY.editTitle })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Stock room");
    expect(screen.queryByRole("group", { name: COPY.suggestions })).toBeNull();
    expect(within(kindGroup()).getByRole("button", { name: "Staff only" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(kindGroup()).getByRole("button", { name: "Inside" }));
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledTimes(1));
    expect(props.onUpdate).toHaveBeenCalledWith("z-stock", { expectedVersion: 7, kind: "interior" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("sends a renamed name (trimmed) and not the unchanged type", async () => {
    const { props } = renderDialog({ zone: ZONE });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Back store " } });
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("z-stock", { expectedVersion: 7, name: "Back store" }));
  });

  it("makes no request when nothing changed", async () => {
    const { props } = renderDialog({ zone: ZONE });
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("refills from a newer version instead of saving over it", async () => {
    const { props, rerender } = renderDialog({ zone: ZONE });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mine" } });
    const newer = { ...ZONE, name: "Theirs", version: 8 };
    rerender(<AreaDialog {...props} zone={newer} />);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Theirs"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("z-stock", { expectedVersion: 8, name: "Mine" }));
  });
});

describe("areaNameProblem — the server's rule, checked before the request", () => {
  it.each([
    ["", COPY.nameRequired],
    ["    ", COPY.nameRequired],
    ["x".repeat(61), COPY.nameTooLong],
    ["Till\tarea", COPY.nameBadChars],
    ["Till\u0085area", COPY.nameBadChars],
    // The server's NAME_FORBIDDEN also refuses the line and paragraph separators…
    ["Till area", COPY.nameBadChars],
    ["Till area", COPY.nameBadChars],
    // …and chainSafeText refuses a lone surrogate (it cannot be stored in the audit chain).
    ["Till\uD800area", COPY.nameBadChars],
    ["Till\uDC00area", COPY.nameBadChars],
    // 61 characters, however many UTF-16 units they take.
    ["🏪".repeat(61), COPY.nameTooLong],
  ])("%j → a problem", (raw, expected) => {
    expect(areaNameProblem(raw)).toBe(expected);
  });

  // The server counts characters ([...name].length), not UTF-16 units: 60 emoji are 120 units.
  it.each(["Front door", "  Car park  ", "x".repeat(60), "Café terrasse", "🏪".repeat(60)])("%j is fine", (raw) => {
    expect(areaNameProblem(raw)).toBeNull();
  });

  // Z1: the server now also refuses bidi override / isolate and zero-width
  // characters (anywhere, edges included) and a name with nothing visible.
  it.each(
    [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => [
      `U+${c.toString(16).toUpperCase()}`,
      String.fromCodePoint(c),
    ]),
  )("%s inside or at an edge → the hidden-characters problem", (_n, ch) => {
    expect(areaNameProblem(`Stock${ch}room`)).toBe(COPY.nameHiddenChars);
    expect(areaNameProblem(`Stock room${ch}`)).toBe(COPY.nameHiddenChars);
  });

  it.each([["\u00A0\u00A0"], ["\u0301"]])("%j has nothing visible → give it a name", (raw) => {
    expect(areaNameProblem(raw)).toBe(COPY.nameRequired);
  });

  // The whole \p{Cf} class and the non-Cf blanks, as the server now refuses them.
  it.each([
    ["\u3164"],
    ["\u200E"],
    ["\u00AD"],
    ["Front do\u00ADor"],
    [`Front door${String.fromCodePoint(0xe0069, 0xe0067)}`],
    ["Front\u2062door"],
    ["Front\u200E door"],
    ["Front\u061C door"],
    ["Front\u180Edoor"],
    ["Front\u034F door"],
    ["Front\u3164door"],
    ["\u2800"],
    ["Front\u2800door"],
  ])("%j → the hidden-characters problem", (raw) => {
    expect(areaNameProblem(raw)).toBe(COPY.nameHiddenChars);
  });

  it.each(["\u2764\uFE0F Kitchen", "Front\u00A0 door"])("%j (an emoji with VS16, a no-break space) is still fine", (raw) => {
    expect(areaNameProblem(raw)).toBeNull();
  });

  it.each(["Cafe\u0301", "מחסן", "İstanbul"])("%j (accents, right-to-left script) is still fine", (raw) => {
    expect(areaNameProblem(raw)).toBeNull();
  });
});
