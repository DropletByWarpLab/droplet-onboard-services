import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Aurora sign-in — composition, gated methods, and submit wiring.
 * (Friendly-error translation is covered separately in login.errors.test.tsx.)
 */

const loginMock = vi.fn();
const setUserMock = vi.fn();
const pushMock = vi.fn();
let searchString = "";

// WARP-629: the login page discovers configured SSO providers at runtime via
// this helper (GET /api/sso/oidc/providers). Mock it so each test controls the
// advertised set without standing up a network/IdP. Default: nothing
// configured (a password-only appliance) — tests override per case.
const getEnabledSsoProvidersMock = vi.fn<[], Promise<string[]>>();
vi.mock("@/lib/api", () => ({
  getEnabledSsoProviders: () => getEnabledSsoProvidersMock(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ login: loginMock, setUserFromPasskey: setUserMock }),
}));

// PR #377 — passkeys are live on this branch. jsdom has no WebAuthn API, so
// pin support on (the real browserSupportsWebAuthn would return false here and
// hide the affordance); the unsupported-browser case is covered in
// login.passkey.test.tsx. The ceremony helper is never invoked by this suite.
vi.mock("@/lib/webauthn", () => ({
  isPasskeySupported: () => true,
  signInWithPasskey: vi.fn(),
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>(
    "next/navigation",
  );
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(searchString),
    usePathname: () => "/login",
  };
});

import LoginPage from "@/app/login/page";

describe("Aurora LoginPage", () => {
  beforeEach(() => {
    loginMock.mockReset();
    pushMock.mockReset();
    getEnabledSsoProvidersMock.mockReset();
    // Default: no SSO configured. Discovery-specific tests override this.
    getEnabledSsoProvidersMock.mockResolvedValue([]);
    searchString = "";
  });

  it("renders the brand hero and the sign-in form", () => {
    render(<LoginPage />);
    // The hero's positioning line is brand copy, not document structure, so
    // it is deliberately NOT a heading — it used to be a second <h1> that
    // competed with "Welcome back" for the page's top-level heading, which
    // landed screen-reader users on the marketing pitch instead of the form.
    // Assert the copy renders; the heading role is asserted below.
    expect(screen.getByText(/on your premises/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /welcome back/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });

  it("exposes exactly one top-level heading — the form's, not the hero's", () => {
    render(<LoginPage />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/welcome back/i);
  });

  // WARP-629: SSO buttons are RUNTIME-DISCOVERED. An appliance that has
  // configured Google (and only Google) shows a single live Google button —
  // no Microsoft/Okta, no "Soon" pill.
  it("renders only the discovered SSO providers (google) as live buttons", async () => {
    getEnabledSsoProvidersMock.mockResolvedValue(["google"]);
    render(<LoginPage />);

    const google = await screen.findByRole("button", {
      name: /continue with google/i,
    });
    expect(google).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /continue with microsoft/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue with okta/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/soon/i)).not.toBeInTheDocument();
  });

  // WARP-629: local-first. With nothing configured, the login is password-only
  // — no SSO buttons and no "OR USE YOUR DIRECTORY ACCOUNT" divider.
  it("renders no SSO buttons or divider when discovery returns an empty list", async () => {
    getEnabledSsoProvidersMock.mockResolvedValue([]);
    render(<LoginPage />);

    // Wait a tick for the discovery effect to settle, then assert absence.
    await waitFor(() => expect(getEnabledSsoProvidersMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /continue with/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/or use your directory account/i),
    ).not.toBeInTheDocument();
    // Password form is present and usable.
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });

  // WARP-629: discovery is purely additive. If it errors/times out, the
  // email/password form still renders AND submits — SSO never gates login.
  it("keeps password login working when SSO discovery rejects", async () => {
    getEnabledSsoProvidersMock.mockRejectedValue(new Error("discovery timed out"));
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    // No SSO buttons surfaced from a failed probe, but the form is fully live.
    await waitFor(() => expect(getEnabledSsoProvidersMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /continue with/i }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "stefan@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith("stefan@acme.co", "hunter2"),
    );
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  // PR #377 ships the WebAuthn backend, so the passkey affordance flips from a
  // disabled "Soon" placeholder to the single live "Sign in with a passkey"
  // action (rendered by SignInForm via onPasskey).
  it("renders exactly one passkey action and it is enabled", () => {
    render(<LoginPage />);
    const passkeyButtons = screen.getAllByRole("button", { name: /passkey/i });
    expect(passkeyButtons).toHaveLength(1);
    expect(passkeyButtons[0]).toBeEnabled();
  });

  it("submits email + password to login() and routes home on success", async () => {
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "stefan@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith("stefan@acme.co", "hunter2"),
    );
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("honours a safe ?next= redirect after login", async () => {
    searchString = "next=/files";
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "stefan@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/files"));
  });

  it("ignores an off-origin ?next= (no open redirect)", async () => {
    searchString = "next=//evil.example.com";
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "stefan@acme.co" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
  });

  // Regression: a naive `startsWith("/")` / `startsWith("//")` string guard is
  // defeated because the WHATWG URL parser (used by router.push → new URL(next,
  // origin) in Next 14.2) collapses `\` → `/` and strips leading tab/newline,
  // turning these into an off-origin authority AFTER the string guard passed.
  // Note: URLSearchParams already percent-decodes, so the component's safeNext
  // receives the decoded form below (e.g. "/\evil.com") — exactly prod.
  it.each([
    ["backslash authority", "next=/%5Cevil.com"], // -> "/\evil.com"  -> http://evil.com
    ["tab-prefixed authority", "next=/%09/evil.com"], // -> "/\t/evil.com" -> http://evil.com
    ["newline-prefixed authority", "next=/%0A//evil.com"], // -> "/\n//evil.com" -> http://evil.com
  ])(
    "blocks a normalization-bypass ?next= (%s) and redirects home",
    async (_label, query) => {
      searchString = query;
      loginMock.mockResolvedValueOnce(undefined);
      render(<LoginPage />);

      fireEvent.change(screen.getByLabelText("Work email"), {
        target: { value: "stefan@acme.co" },
      });
      fireEvent.change(screen.getByPlaceholderText("Password"), {
        target: { value: "hunter2" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
      // Hard guarantee: never hand router.push anything resolving off-origin.
      for (const [arg] of pushMock.mock.calls) {
        expect(new URL(arg as string, "http://x.invalid").origin).toBe(
          "http://x.invalid",
        );
      }
    },
  );

  // Residual (post-safeNext-v1): the sentinel-origin guard is NOT sufficient on
  // its own. `..` resolution can pop the empty leading segment and leave the
  // RETURNED path itself an authority — e.g. `/..//evil.com` resolves to
  // `.pathname === "//evil.com"` while `.origin` stays the sentinel, so the
  // origin check PASSES and safeNext hands back `//evil.com`. router.push then
  // resolves that against the REAL location.origin → off-origin nav. The fix is
  // an explicit guard on the returned path (`startsWith("//")` / `"/\\"`), which
  // is why re-checking origin against the sentinel cannot catch this.
  // (URLSearchParams percent-decodes, so safeNext sees the decoded form — prod.)
  it.each([
    ["dotdot to //authority", "next=%2F..%2F%2Fevil.com"], // -> "/..//evil.com"   -> "//evil.com"
    ["nested dotdot to //authority", "next=/x/..//evil.com"], // -> "//evil.com"
    ["dot-then-//authority", "next=/.//evil.com"], // -> "//evil.com"
    ["dotdot+backslash authority", "next=/../\\evil.com"], // -> "/../\evil.com" -> "//evil.com"
  ])(
    "blocks a path-traversal-to-authority ?next= (%s) and redirects home",
    async (_label, query) => {
      searchString = query;
      loginMock.mockResolvedValueOnce(undefined);
      render(<LoginPage />);

      fireEvent.change(screen.getByLabelText("Work email"), {
        target: { value: "stefan@acme.co" },
      });
      fireEvent.change(screen.getByPlaceholderText("Password"), {
        target: { value: "hunter2" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
      // Hard guarantee: never hand router.push anything resolving off-origin.
      for (const [arg] of pushMock.mock.calls) {
        expect(new URL(arg as string, "http://x.invalid").origin).toBe(
          "http://x.invalid",
        );
      }
    },
  );

  it.each([
    ["root", "next=/"],
    ["files", "next=/files"],
    ["setup with query", "next=/setup?from=x"],
  ])(
    "honours a legit same-origin ?next= (%s) unchanged after login",
    async (_label, query) => {
      searchString = query;
      const expected = new URLSearchParams(query).get("next") as string;
      loginMock.mockResolvedValueOnce(undefined);
      render(<LoginPage />);

      fireEvent.change(screen.getByLabelText("Work email"), {
        target: { value: "stefan@acme.co" },
      });
      fireEvent.change(screen.getByPlaceholderText("Password"), {
        target: { value: "hunter2" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith(expected));
    },
  );

  it("validates locally and does not call login when fields are empty", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(loginMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/enter your work email and password/i),
    ).toBeInTheDocument();
  });

  it("shows the post-setup confirmation chip when ?from=setup", () => {
    searchString = "from=setup";
    render(<LoginPage />);
    expect(
      screen.getByText(/setup already completed/i),
    ).toBeInTheDocument();
  });
});
