/**
 * WARP-3180 — owner-only audit key rotation: two red confirms, the step-up
 * (POST /api/auth/step-up for THIS session) BEFORE the rotate call, the new
 * key id after, plain messages for each refusal, nothing for admins/members.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const authFetchMock = vi.fn();
const fetchMock = vi.fn();
let role = "owner";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "o", role } }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import { RotateAuditKey, ROTATE_EXPLAINER } from "./RotateAuditKey";

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
  role = "owner";
});
afterEach(() => vi.unstubAllGlobals());

async function walkToStepUp() {
  fireEvent.click(screen.getByRole("button", { name: /rotate audit signing key/i }));
  expect(screen.getByText(ROTATE_EXPLAINER)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText(/confirm it's you/i);
  expect(screen.queryByLabelText(/email/i)).toBeNull();
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
  fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
}

describe("RotateAuditKey", () => {
  it.each(["admin", "family", "guest"])("renders nothing for %s", (r) => {
    role = r;
    const { container } = render(<RotateAuditKey />);
    expect(container.innerHTML).toBe("");
  });

  it("steps up this session, then rotates and shows the new key id", async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      order.push(`${init.method} ${url}`);
      return reply(200, { ok: true });
    });
    authFetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      order.push(`${init.method} ${url}`);
      return reply(200, { rotated: true, previousKeyId: "aaaa", newKeyId: "bbbb1234" });
    });
    const onRotated = vi.fn();
    render(<RotateAuditKey onRotated={onRotated} />);
    await walkToStepUp();

    expect(await screen.findByText("bbbb1234")).toBeTruthy();
    expect(order).toEqual(["POST /api/auth/step-up", "POST /api/activity/rotate-key"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ password: "pw", totp: "123456" });
    expect(onRotated).toHaveBeenCalledOnce();
  });

  it("a failed step-up never calls rotate and clears both fields", async () => {
    fetchMock.mockResolvedValue(reply(401, { code: "STEP_UP_INVALID" }));
    render(<RotateAuditKey />);
    await walkToStepUp();
    expect(await screen.findByText(/wrong password or code/i)).toBeTruthy();
    expect(authFetchMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Two-factor code") as HTMLInputElement).value).toBe("");
  });

  it("cancelling the first confirm never reaches the step-up", () => {
    render(<RotateAuditKey />);
    fireEvent.click(screen.getByRole("button", { name: /rotate audit signing key/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/confirm it's you/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, { code: "RETIRED_KEY_DIR_MISSING", error: "x" }, /latest update applied/],
    [503, { code: "HOST_HELPER_UNAVAILABLE", error: "x" }, /rotate-audit-key\.sh/],
    [401, { error: "mfa_stale" }, /confirmation expired/],
    [401, { error: "auth_required" }, /session ended/],
    [409, { code: "ROTATION_IN_PROGRESS", error: "A key rotation is already running. Wait for it to finish." }, /already running/],
    [502, { code: "ROTATION_FAILED", error: "The key could not be rotated. Nothing changed." }, /could not be rotated/],
  ])("maps %s to a plain message", async (status, body, text) => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    authFetchMock.mockResolvedValue(reply(status, body));
    const onRotated = vi.fn();
    render(<RotateAuditKey onRotated={onRotated} />);
    await walkToStepUp();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(text));
    expect(onRotated).not.toHaveBeenCalled();
  });
});
