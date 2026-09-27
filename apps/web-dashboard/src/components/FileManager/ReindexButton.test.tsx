/**
 * WARP-3252 — a stale-MFA re-index opens the step-up dialog (no redirect to
 * the /settings/mfa page that never existed) and retries after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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
});
