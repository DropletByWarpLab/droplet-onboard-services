/**
 * WARP-1054 — the /login/passkey approval page state machine.
 *
 * The ceremony's constituent calls (options → browser ceremony → verify) are
 * mocked so we assert the page's own behaviour: auto-start on mount, the state
 * transitions and their copy, success → replace(safeNext(next)), the failure
 * causes and their guidance, cancel aborts the ceremony + preserves ?next=, the
 * unsupported branch, and the auto-start-refused `ready` fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const getOptions = vi.fn();
const runCeremony = vi.fn();
const verify = vi.fn();
const cancelCeremony = vi.fn();
const isPasskeySupported = vi.fn();
vi.mock("@/lib/webauthn", () => ({
  getPasskeyAuthenticationOptions: (...a: unknown[]) => getOptions(...a),
  runPasskeyAuthenticationCeremony: (...a: unknown[]) => runCeremony(...a),
  verifyPasskeyAuthentication: (...a: unknown[]) => verify(...a),
  cancelPasskeyCeremony: (...a: unknown[]) => cancelCeremony(...a),
  isPasskeySupported: (...a: unknown[]) => isPasskeySupported(...a),
}));

const setUserFromPasskey = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ setUserFromPasskey }),
}));

const replaceMock = vi.fn();
const pushMock = vi.fn();
let searchString = "";
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: replaceMock, back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(searchString),
    usePathname: () => "/login/passkey",
  };
});

import PasskeyApprovalPage from "@/app/login/passkey/page";

const USER = { id: "u-1", username: "stefan", displayName: "Stefan", role: "owner" as const };

/** A WebAuthn dismiss/timeout/no-match error (all surface as NotAllowedError). */
function notAllowed(): DOMException {
  return new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
}

/** Pin prefers-reduced-motion ON so the success redirect fires immediately
 *  (no 600ms hold to advance) — deterministic across the suite. */
function pinReducedMotion() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  searchString = "";
  isPasskeySupported.mockReturnValue(true);
  getOptions.mockResolvedValue({ challenge: "c", timeout: 60_000 });
  runCeremony.mockResolvedValue({ id: "cred", response: {} });
  verify.mockResolvedValue(USER);
  pinReducedMotion();
});

describe("/login/passkey — unsupported browser", () => {
  it("shows the unsupported state and never starts a ceremony", async () => {
    isPasskeySupported.mockReturnValue(false);
    render(<PasskeyApprovalPage />);

    expect(
      await screen.findByRole("heading", { name: /passkeys aren't available here/i }),
    ).toBeInTheDocument();
    expect(getOptions).not.toHaveBeenCalled();
    expect(runCeremony).not.toHaveBeenCalled();
    // There is still a way out.
    expect(screen.getByRole("button", { name: /back to sign in/i })).toBeInTheDocument();
  });
});

describe("/login/passkey — success", () => {
  it("auto-starts, verifies, hydrates the session and redirects to safeNext(next)", async () => {
    searchString = "next=/files";
    render(<PasskeyApprovalPage />);

    await waitFor(() => expect(setUserFromPasskey).toHaveBeenCalledWith(USER));
    expect(await screen.findByRole("heading", { name: /you're in/i })).toBeInTheDocument();
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/files"));
    // replace, not push, so Back can't land on the dead approval page.
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores an off-origin ?next= on success (no open redirect)", async () => {
    searchString = "next=//evil.example.com";
    render(<PasskeyApprovalPage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
  });
});

describe("/login/passkey — waiting + cancel", () => {
  it("shows the waiting state, focuses the heading, and cancel aborts + returns to /login with ?next=", async () => {
    searchString = "next=/files";
    // Ceremony stays in flight so the page holds on `waiting`.
    runCeremony.mockReturnValue(new Promise(() => {}));
    render(<PasskeyApprovalPage />);

    const heading = await screen.findByRole("heading", { name: /approve this sign-in/i });
    expect(heading).toBeInTheDocument();
    // A11y: focus moves to the status heading on the transition.
    expect(heading).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(cancelCeremony).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith("/login?next=%2Ffiles");
  });

  it("aborts the ceremony on unmount", async () => {
    runCeremony.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<PasskeyApprovalPage />);
    await screen.findByRole("heading", { name: /approve this sign-in/i });

    unmount();
    expect(cancelCeremony).toHaveBeenCalled();
  });
});

describe("/login/passkey — failure causes", () => {
  it("maps an unreachable box (options throw) to the network copy, with a way out", async () => {
    getOptions.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<PasskeyApprovalPage />);

    expect(
      await screen.findByText(/couldn't reach your droplet to finish signing in/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use your password instead/i }),
    ).toBeInTheDocument();
  });

  it("maps a server rejection at verify to the rejected copy", async () => {
    verify.mockRejectedValueOnce(new Error("Invalid credentials"));
    render(<PasskeyApprovalPage />);

    expect(
      await screen.findByText(/couldn't verify that passkey/i),
    ).toBeInTheDocument();
  });

  it("maps a transport failure at verify to the network copy", async () => {
    verify.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<PasskeyApprovalPage />);

    expect(
      await screen.findByText(/couldn't reach your droplet/i),
    ).toBeInTheDocument();
  });

  it("maps a generic ceremony error to the cancelled copy", async () => {
    runCeremony.mockRejectedValueOnce(new Error("ceremony blew up"));
    render(<PasskeyApprovalPage />);

    expect(
      await screen.findByText(/cancelled or no matching passkey/i),
    ).toBeInTheDocument();
  });

  it("'Use your password instead' from the failed state returns to /login with ?next=", async () => {
    searchString = "next=/files";
    getOptions.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<PasskeyApprovalPage />);

    await screen.findByText(/couldn't reach your droplet/i);
    fireEvent.click(screen.getByRole("button", { name: /use your password instead/i }));
    expect(replaceMock).toHaveBeenCalledWith("/login?next=%2Ffiles");
  });

  it("classifies a slow NotAllowedError on a manual retry as a timeout", async () => {
    // First (auto) attempt fails generically → cancelled. Retry (manual) hits a
    // NotAllowedError with a zero timeout, so the elapsed-time heuristic reads it
    // as a genuine timeout rather than the auto-start-refused `ready` fallback
    // (which only applies to the FIRST, auto-started attempt).
    getOptions.mockResolvedValue({ challenge: "c", timeout: 0 });
    runCeremony
      .mockRejectedValueOnce(new Error("generic"))
      .mockRejectedValueOnce(notAllowed());
    render(<PasskeyApprovalPage />);

    await screen.findByText(/cancelled or no matching passkey/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/timed out before a passkey was used/i)).toBeInTheDocument();
  });
});

describe("/login/passkey — ready fallback + retry", () => {
  it("falls back to `ready` when the browser refuses to auto-start, then Continue succeeds", async () => {
    // Auto attempt: an immediate NotAllowedError (elapsed under the refuse
    // threshold) → the explicit Continue affordance rather than a scary failure.
    runCeremony
      .mockRejectedValueOnce(notAllowed())
      .mockResolvedValueOnce({ id: "cred", response: {} });
    render(<PasskeyApprovalPage />);

    expect(
      await screen.findByRole("heading", { name: /sign in with your passkey/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(setUserFromPasskey).toHaveBeenCalledWith(USER));
    expect(await screen.findByRole("heading", { name: /you're in/i })).toBeInTheDocument();
  });

  it("retry from the failed state re-runs the ceremony to success", async () => {
    runCeremony
      .mockRejectedValueOnce(new Error("generic"))
      .mockResolvedValueOnce({ id: "cred", response: {} });
    render(<PasskeyApprovalPage />);

    await screen.findByText(/cancelled or no matching passkey/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(setUserFromPasskey).toHaveBeenCalledWith(USER));
  });
});

describe("/login/passkey — reassurance footer", () => {
  it("shows the local-first line while waiting and hides it on success", async () => {
    runCeremony.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<PasskeyApprovalPage />);
    await screen.findByRole("heading", { name: /approve this sign-in/i });
    expect(screen.getByText(/nothing leaves the box/i)).toBeInTheDocument();
    unmount();

    // Success: footer omitted (the page is leaving).
    runCeremony.mockResolvedValue({ id: "cred", response: {} });
    render(<PasskeyApprovalPage />);
    await screen.findByRole("heading", { name: /you're in/i });
    expect(screen.queryByText(/nothing leaves the box/i)).not.toBeInTheDocument();
  });
});
