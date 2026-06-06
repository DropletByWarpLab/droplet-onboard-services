/**
 * WARP-824 — forced password-change screen behaviour.
 *
 * - Submits current + new password via the changePassword() API.
 * - On success, flips the in-memory flag (markPasswordChanged) and routes to /.
 * - Enforces the shared policy client-side (disabled submit until the new
 *   password passes + confirm matches) so a user can't fire a guaranteed-400.
 * - Surfaces the server error code as friendly copy on failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

const changePasswordMock = vi.fn();
vi.mock("@/lib/api", () => ({
  changePassword: (...a: unknown[]) => changePasswordMock(...a),
}));

const markPasswordChangedMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "kid", displayName: "Kid", role: "family", mustChangePassword: true },
    markPasswordChanged: markPasswordChangedMock,
  }),
}));

import ChangePasswordPage from "@/app/change-password/page";

const STRONG = "Brand-new-secret123";

beforeEach(() => {
  pushMock.mockReset();
  changePasswordMock.mockReset();
  markPasswordChangedMock.mockReset();
});

function fill(testid: string, value: string) {
  fireEvent.change(screen.getByTestId(testid), { target: { value } });
}

describe("ChangePasswordPage", () => {
  it("keeps submit disabled until the new password passes policy AND confirm matches", () => {
    render(<ChangePasswordPage />);
    const submit = screen.getByRole("button", { name: /set new password/i });
    expect(submit).toBeDisabled();

    fill("current-password", "Temp-secret123");
    fill("new-password", "weak");
    fill("confirm-password", "weak");
    expect(submit).toBeDisabled(); // policy fails

    fill("new-password", STRONG);
    fill("confirm-password", "mismatch");
    expect(submit).toBeDisabled(); // confirm mismatches

    fill("confirm-password", STRONG);
    expect(submit).not.toBeDisabled();
  });

  it("on success calls changePassword, flips the flag, and routes to /", async () => {
    changePasswordMock.mockResolvedValueOnce(undefined);
    render(<ChangePasswordPage />);

    fill("current-password", "Temp-secret123");
    fill("new-password", STRONG);
    fill("confirm-password", STRONG);
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => expect(changePasswordMock).toHaveBeenCalledWith("Temp-secret123", STRONG));
    await waitFor(() => expect(markPasswordChangedMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
  });

  it("surfaces a friendly error on a wrong current password and does NOT route", async () => {
    const err = Object.assign(new Error("Invalid current password"), { code: "INVALID_PASSWORD" });
    changePasswordMock.mockRejectedValueOnce(err);
    render(<ChangePasswordPage />);

    fill("current-password", "wrong");
    fill("new-password", STRONG);
    fill("confirm-password", STRONG);
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(markPasswordChangedMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
