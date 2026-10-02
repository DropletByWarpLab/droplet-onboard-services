/**
 * WARP-2991 — the consent prompt at a local→cloud switch names what would be
 * sent, and each button records exactly one decision.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CloudHistoryConsentDialog } from "@/components/chat/CloudHistoryConsentDialog";

const summary = {
  consent: "not_asked" as const,
  decidedAt: null,
  uncoveredOnBoxAnswers: 3,
  unaskedOnBoxAnswers: 3,
  userMessages: 4,
  drewOn: ["documents", "memory"],
  neverSent: [] as string[],
};

function renderDialog(onDecide = vi.fn(async () => {}), onClose = vi.fn(), over: Partial<typeof summary> = {}) {
  render(
    <CloudHistoryConsentDialog
      open
      summary={{ ...summary, ...over }}
      modelLabel="Claude Opus"
      onDecide={onDecide}
      onClose={onClose}
    />,
  );
  return { onDecide, onClose };
}

describe("CloudHistoryConsentDialog", () => {
  it("names the model, the count, and what the answers drew on", () => {
    renderDialog();
    expect(screen.getByText(/Send this conversation to Claude Opus\?/)).toBeTruthy();
    expect(screen.getByText(/3 earlier answers from the on-box model/)).toBeTruthy();
    expect(screen.getByText(/drawn from your documents, memory/)).toBeTruthy();
  });

  it("'Only my messages' records a decline", async () => {
    const { onDecide, onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Only my messages" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDecide).toHaveBeenCalledWith("declined");
  });

  it("'Send the whole conversation' records a grant", async () => {
    const { onDecide } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Send the whole conversation" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("granted"));
  });

  // The server never replays an answer that used a never-sent source, whatever is chosen.
  it("with a never-sent source: says it stays on the Droplet, and offers only what will happen", async () => {
    const { onDecide, onClose } = renderDialog(undefined, undefined, { neverSent: ["Private notes"] });
    expect(screen.getByText(/Answers that used Private notes stay on this Droplet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send the whole conversation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Only my messages" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Review #2420 (item 7): the lone button is an acknowledgement, not a choice. It records NOTHING, so an
    // earlier "send the whole conversation" is not overwritten (it still covers the answers that may be sent).
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("without one, both choices stay and no never-sent source is mentioned", () => {
    renderDialog();
    expect(screen.queryByText(/Private notes/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send the whole conversation" })).toBeTruthy();
  });

  it("stays open and says so when the choice cannot be saved", async () => {
    const { onClose } = renderDialog(vi.fn(async () => Promise.reject(new Error("x"))));
    fireEvent.click(screen.getByRole("button", { name: "Send the whole conversation" }));
    await waitFor(() => expect(screen.getByText(/could not be saved/)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});
