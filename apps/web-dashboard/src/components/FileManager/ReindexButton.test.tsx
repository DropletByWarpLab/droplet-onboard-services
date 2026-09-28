/**
 * WARP-3252 — a stale-MFA re-index opens the step-up dialog (no redirect to
 * the /settings/mfa page that never existed) and retries after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const authFetchMock = vi.fn();
const fetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import { ReindexButton } from "./ReindexButton";

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  cleanup();
  authFetchMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("ReindexButton step-up", () => {
  it.each(["mfa_required", "mfa_stale"])("%s opens the step-up and retries", async (error) => {
    authFetchMock
      .mockResolvedValueOnce(reply(401, { error }))
      .mockResolvedValueOnce(reply(200, { chunksWritten: 7 }));
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    render(<ReindexButton fileId="/a.txt" />);
    fireEvent.click(screen.getByTestId("reindex-button"));
    await screen.findByText(/confirm it's you$/i, { selector: "h2" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Re-index" }));
    expect(await screen.findByText("Re-indexed 7 chunks.")).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/step-up");
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancelling the step-up clears the prompt", async () => {
    authFetchMock.mockResolvedValueOnce(reply(401, { error: "mfa_stale" }));
    render(<ReindexButton fileId="/a.txt" />);
    fireEvent.click(screen.getByTestId("reindex-button"));
    await screen.findByText(/confirm it's you$/i, { selector: "h2" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Confirm it's you to re-index.")).toBeNull());
  });

  it("a retry that asks for MFA again keeps the reopened dialog open", async () => {
    authFetchMock
      .mockResolvedValueOnce(reply(401, { error: "mfa_stale" }))
      .mockResolvedValueOnce(reply(401, { error: "mfa_stale" }));
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    render(<ReindexButton fileId="/a.txt" />);
    fireEvent.click(screen.getByTestId("reindex-button"));
    await screen.findByText(/confirm it's you$/i, { selector: "h2" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Re-index" }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/confirm it's you$/i, { selector: "h2" })).toBeTruthy();
  });
});
