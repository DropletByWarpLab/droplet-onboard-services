/**
 * WARP-3135 — one show-password eye, and a revealed password never outlives
 * the moment it was revealed for.
 *
 * Two defects on every auth field that draws its own eye (/login,
 * /change-password, /invite/[token]):
 *
 * 1. Edge (and the Windows app, which is WebView2 = Edge) paints its native
 *    `::-ms-reveal` eye inside any `type=password` input, right next to ours.
 *    The fields that already draw an eye opt out of the native one with the
 *    `[&::-ms-reveal]:hidden` arbitrary variant. The temporary-password field
 *    on /change-password has no eye of its own, so it keeps the browser's.
 *
 * 2. A revealed password stayed revealed: through a failed sign-in, and while
 *    the user Alt+Tabbed away and back. Mirrors the Mac client (DropletAgent
 *    #9, WARP-3086): re-mask on every submit attempt, and when the window
 *    loses focus or the page is hidden. An input's own blur is NOT a trigger —
 *    clicking the eye blurs the input, so that would make the eye unusable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const loginMock = vi.fn();
const changePasswordMock = vi.fn();
const getInviteMock = vi.fn();
const acceptInviteMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    login: loginMock,
    user: { id: "u1", username: "kid", displayName: "Kid", role: "family", mustChangePassword: true },
    markPasswordChanged: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("@/lib/api", () => ({
  getEnabledSsoProviders: () => Promise.resolve([]),
  changePassword: (...a: unknown[]) => changePasswordMock(...a),
  getInvite: (...a: unknown[]) => getInviteMock(...a),
  acceptInvite: (...a: unknown[]) => acceptInviteMock(...a),
}));

import LoginPage from "@/app/login/page";
import ChangePasswordPage from "@/app/change-password/page";
import InviteAcceptPage from "@/app/invite/[token]/page";

/** Hides Edge's native `::-ms-reveal` eye. */
const NO_NATIVE_EYE = "[&::-ms-reveal]:hidden";

/** Tier-1 policy-passing password (same shape invite.accept.test.tsx uses). */
const STRONG = "Abcdefghijk1";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function windowBlur() {
  fireEvent.blur(window);
}

function pageVisibility(state: DocumentVisibilityState) {
  setVisibility(state);
  fireEvent(document, new Event("visibilitychange"));
}

beforeEach(() => {
  loginMock.mockReset();
  changePasswordMock.mockReset();
  getInviteMock.mockReset();
  acceptInviteMock.mockReset();
});

afterEach(() => {
  // Drop the own-property shadow so jsdom's prototype getter is back.
  delete (document as { visibilityState?: unknown }).visibilityState;
});

async function renderInvite() {
  getInviteMock.mockResolvedValueOnce({
    username: "alice",
    displayName: "Alice",
    role: "user",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await act(async () => {
    render(<InviteAcceptPage params={Promise.resolve({ token: "valid" })} />);
  });
  await screen.findByRole("button", { name: /accept invite/i });
}

describe("LoginPage — revealed password re-masks (WARP-3135)", () => {
  function reveal() {
    const field = screen.getByPlaceholderText("Password");
    fireEvent.change(field, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field).toHaveAttribute("type", "text");
    return field;
  }

  it("aria-pressed tracks the reveal, and a failed sign-in leaves the field masked", async () => {
    loginMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 401 }));
    render(<LoginPage />);

    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "alice@acme.co" },
    });
    const field = reveal();
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await screen.findByRole("alert");

    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("re-masks when the window loses focus (Alt+Tab)", () => {
    render(<LoginPage />);
    const field = reveal();

    windowBlur();

    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("re-masks when the page is hidden, not when it becomes visible", () => {
    render(<LoginPage />);
    const field = reveal();

    pageVisibility("visible");
    expect(field).toHaveAttribute("type", "text");

    pageVisibility("hidden");
    expect(field).toHaveAttribute("type", "password");
  });

  it("the input's own blur does not re-mask (clicking the eye blurs the input)", () => {
    render(<LoginPage />);
    const field = reveal();

    fireEvent.blur(field);

    expect(field).toHaveAttribute("type", "text");
  });
});

describe("ChangePasswordPage — revealed password re-masks (WARP-3135)", () => {
  it("aria-pressed tracks the reveal, and a failed submit re-masks both new-password fields", async () => {
    changePasswordMock.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { status: 401, code: "INVALID_CREDENTIALS" }),
    );
    render(<ChangePasswordPage />);

    fireEvent.change(screen.getByTestId("current-password"), {
      target: { value: "Temp-secret123" },
    });
    fireEvent.change(screen.getByTestId("new-password"), { target: { value: STRONG } });
    fireEvent.change(screen.getByTestId("confirm-password"), { target: { value: STRONG } });

    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByTestId("new-password")).toHaveAttribute("type", "text");
    expect(screen.getByTestId("confirm-password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));
    await screen.findByRole("alert");

    expect(changePasswordMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("new-password")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("confirm-password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("re-masks on window blur and on the page going hidden", () => {
    render(<ChangePasswordPage />);
    const eye = () => screen.getByRole("button", { name: /(show|hide) password/i });

    fireEvent.click(eye());
    expect(screen.getByTestId("new-password")).toHaveAttribute("type", "text");
    windowBlur();
    expect(screen.getByTestId("new-password")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("confirm-password")).toHaveAttribute("type", "password");

    fireEvent.click(eye());
    expect(screen.getByTestId("new-password")).toHaveAttribute("type", "text");
    pageVisibility("hidden");
    expect(screen.getByTestId("new-password")).toHaveAttribute("type", "password");
  });
});

describe("InviteAcceptPage — revealed password re-masks (WARP-3135)", () => {
  it("aria-pressed tracks the reveal, and a failed accept re-masks both fields", async () => {
    acceptInviteMock.mockRejectedValueOnce(new Error("Could not create your account."));
    await renderInvite();

    const password = screen.getByLabelText("Choose a password");
    const confirm = screen.getByLabelText("Confirm password");
    fireEvent.change(password, { target: { value: STRONG } });
    fireEvent.change(confirm, { target: { value: STRONG } });

    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(confirm).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /accept invite/i }));
    await waitFor(() => expect(acceptInviteMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept invite/i })).toBeEnabled(),
    );

    expect(password).toHaveAttribute("type", "password");
    expect(confirm).toHaveAttribute("type", "password");
  });

  it("re-masks on window blur and on the page going hidden", async () => {
    await renderInvite();
    const password = screen.getByLabelText("Choose a password");
    const eye = () => screen.getByRole("button", { name: /(show|hide) password/i });

    fireEvent.click(eye());
    expect(password).toHaveAttribute("type", "text");
    windowBlur();
    expect(password).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("type", "password");

    fireEvent.click(eye());
    expect(password).toHaveAttribute("type", "text");
    pageVisibility("hidden");
    expect(password).toHaveAttribute("type", "password");
  });
});

describe("Only one eye per field — Edge's native reveal is off where we draw our own (WARP-3135)", () => {
  it("/login password field hides the native eye", () => {
    render(<LoginPage />);
    expect(screen.getByPlaceholderText("Password")).toHaveClass(NO_NATIVE_EYE);
  });

  it("/change-password: the eyed fields hide it; the temporary-password field keeps it", () => {
    render(<ChangePasswordPage />);
    expect(screen.getByTestId("new-password")).toHaveClass(NO_NATIVE_EYE);
    // Its type follows the new-password eye, so a native eye here would be a
    // second, disagreeing control.
    expect(screen.getByTestId("confirm-password")).toHaveClass(NO_NATIVE_EYE);
    // No custom eye on this one — the browser's is the only reveal it has.
    expect(screen.getByTestId("current-password")).not.toHaveClass(NO_NATIVE_EYE);
  });

  it("/invite/[token]: both password fields hide it", async () => {
    await renderInvite();
    expect(screen.getByLabelText("Choose a password")).toHaveClass(NO_NATIVE_EYE);
    expect(screen.getByLabelText("Confirm password")).toHaveClass(NO_NATIVE_EYE);
  });
});
