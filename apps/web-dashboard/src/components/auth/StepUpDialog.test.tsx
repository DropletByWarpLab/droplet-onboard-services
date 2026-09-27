/**
 * WARP-3180 — the step-up dialog: password + code only, fields cleared after
 * every attempt, and a failing protected action closes the dialog with its
 * own message rather than "couldn't reach your Droplet".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { StepUpDialog } from "./StepUpDialog";

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderDialog(onVerified = vi.fn(), onError = vi.fn(), onClose = vi.fn()) {
  render(<StepUpDialog open onClose={onClose} onVerified={onVerified} onError={onError} actionLabel="Go" />);
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  return { onVerified, onError, onClose };
}

describe("StepUpDialog", () => {
  it("has no account field", () => {
    render(<StepUpDialog open onClose={vi.fn()} onVerified={vi.fn()} onError={vi.fn()} actionLabel="Go" />);
    expect(screen.queryByLabelText(/email|user/i)).toBeNull();
  });

  it("clears both fields after a failed step-up and keeps the dialog open", async () => {
    fetchMock.mockResolvedValue(reply(401, { code: "STEP_UP_INVALID" }));
    const { onVerified, onClose } = renderDialog();
    expect(await screen.findByText(/wrong password or code/i)).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Two-factor code") as HTMLInputElement).value).toBe("");
    expect(onVerified).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a throwing action closes the dialog and reports its own error", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    const { onError, onClose } = renderDialog(vi.fn().mockRejectedValue(new Error("Disk full on the box")));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Disk full on the box"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText(/couldn't reach your Droplet/i)).toBeNull();
  });
});
