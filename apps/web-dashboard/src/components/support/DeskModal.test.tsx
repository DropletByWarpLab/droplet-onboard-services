/**
 * WARP-3528 — setting up and editing a service desk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const createDesk = vi.fn();
const updateDesk = vi.fn();
vi.mock("./useSupport", async () => {
  const actual = await vi.importActual<typeof import("./useSupport")>("./useSupport");
  return { ...actual, supportActions: () => ({ createDesk, updateDesk }) };
});

import { DeskModal } from "./DeskModal";
import { SupportRequestError } from "./useSupport";
import { makeDesk } from "./support.test-fixtures";

beforeEach(() => {
  vi.clearAllMocks();
  createDesk.mockResolvedValue({ desk: makeDesk({ name: "Help" }) });
  updateDesk.mockResolvedValue({ desk: makeDesk() });
});

describe("setting up a desk", () => {
  it("needs a name", () => {
    render(<DeskModal onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create desk" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add a name.");
    expect(createDesk).not.toHaveBeenCalled();
  });

  it("creates it with an optional key and description, leaving the key out when blank", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<DeskModal onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Help " } });
    fireEvent.click(screen.getByRole("button", { name: "Create desk" }));
    await waitFor(() => expect(createDesk).toHaveBeenCalledWith({ name: "Help" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Desk Help created", "success");
  });

  it("upper-cases the key and refuses one that is not 1 to 10 letters or numbers", async () => {
    render(<DeskModal onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Help" } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "sup" } });
    expect((screen.getByLabelText("Key") as HTMLInputElement).value).toBe("SUP");
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "no spaces" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Use 1 to 10 letters or numbers.");
    fireEvent.click(screen.getByRole("button", { name: "Create desk" }));
    expect(createDesk).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "SUP" } });
    fireEvent.click(screen.getByRole("button", { name: "Create desk" }));
    await waitFor(() => expect(createDesk).toHaveBeenCalledWith({ name: "Help", identifier: "SUP" }));
  });

  it("says a taken key is taken, in the brief's words, and stays open", async () => {
    createDesk.mockRejectedValue(new SupportRequestError("identifier_taken", 409, "identifier_taken"));
    const onClose = vi.fn();
    render(<DeskModal onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Help" } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "SUP" } });
    fireEvent.click(screen.getByRole("button", { name: "Create desk" }));
    await screen.findByText("That key is already taken — pick another.");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("desk settings", () => {
  it("shows the key but cannot change it, and saves a cleared description as null", async () => {
    render(<DeskModal desk={makeDesk({ description: "words" })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByDisplayValue("SUP")).toHaveAttribute("readonly");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateDesk).toHaveBeenCalledWith("desk-1", { name: "Support", description: null, archived: false }));
  });

  it("archives and restores with a plain note about what archiving does", async () => {
    const { unmount } = render(<DeskModal desk={makeDesk()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText("Archiving hides the desk and its tickets from the queues. You can restore it.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Archive this desk"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateDesk).toHaveBeenCalledWith("desk-1", expect.objectContaining({ archived: true })));
    unmount();
    render(<DeskModal desk={makeDesk({ archived: true })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText("Archive this desk")).toBeChecked();
  });
});
