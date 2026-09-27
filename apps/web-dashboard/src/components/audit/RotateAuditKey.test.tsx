/**
 * WARP-3180 — owner-only audit key rotation: two red confirms, the MFA
 * step-up (re-sign-in with a code) BEFORE the API call, the new key id
 * after, plain messages for each refusal, and nothing for admins/members.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const authFetchMock = vi.fn();
const loginMock = vi.fn();
let role = "owner";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "o", role }, login: loginMock }),
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
  loginMock.mockReset();
  role = "owner";
});

async function walkToStepUp() {
  fireEvent.click(screen.getByRole("button", { name: /rotate audit signing key/i }));
  expect(screen.getByText(ROTATE_EXPLAINER)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText(/confirm it's you/i);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@acme.test" } });
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

  it("steps up, then rotates and shows the new key id", async () => {
    const order: string[] = [];
    loginMock.mockImplementation(async () => void order.push("login"));
    authFetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      order.push(`${init.method} ${url}`);
      return reply(200, { rotated: true, previousKeyId: "aaaa", newKeyId: "bbbb1234" });
    });
    const onRotated = vi.fn();
    render(<RotateAuditKey onRotated={onRotated} />);
    await walkToStepUp();

    expect(await screen.findByText("bbbb1234")).toBeTruthy();
    expect(order).toEqual(["login", "POST /api/activity/rotate-key"]);
    expect(loginMock).toHaveBeenCalledWith("owner@acme.test", "pw", { totp: "123456" });
    expect(onRotated).toHaveBeenCalledOnce();
  });

  it("does not call the API when the step-up fails", async () => {
    loginMock.mockRejectedValue(new Error("Invalid credentials"));
    render(<RotateAuditKey />);
    await walkToStepUp();
    expect(await screen.findByText(/didn't match/i)).toBeTruthy();
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("cancelling the first confirm never reaches the step-up", () => {
    render(<RotateAuditKey />);
    fireEvent.click(screen.getByRole("button", { name: /rotate audit signing key/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/confirm it's you/i)).toBeNull();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, { code: "RETIRED_KEY_DIR_MISSING", error: "x" }, /latest update applied/],
    [503, { code: "HOST_HELPER_UNAVAILABLE", error: "x" }, /rotate-audit-key\.sh/],
    [401, { error: "mfa_required" }, /two-factor sign-in from the last minute/],
    [502, { code: "ROTATION_FAILED", error: "The key could not be rotated. Nothing changed." }, /could not be rotated/],
  ])("maps %s to a plain message", async (status, body, text) => {
    loginMock.mockResolvedValue(undefined);
    authFetchMock.mockResolvedValue(reply(status, body));
    const onRotated = vi.fn();
    render(<RotateAuditKey onRotated={onRotated} />);
    await walkToStepUp();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(text));
    expect(onRotated).not.toHaveBeenCalled();
  });
});
