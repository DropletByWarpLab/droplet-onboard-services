/**
 * PR #377 (WARP-___) — Settings "Passkeys" section.
 *
 * The in-product home for enrolling a passkey (the AC allows Account-step OR
 * settings; settings is chosen because the wizard's AccountStep auto-advances
 * and enrolment is optional). Scope is REGISTER only — listing/revoking
 * passkeys is a follow-up (no GET/DELETE endpoint in this PR).
 *
 *   - Renders an "Add a passkey" action when WebAuthn is supported.
 *   - Clicking it runs registerPasskey and shows a success confirmation.
 *   - A failed enrolment shows a friendly error, never the raw ceremony error.
 *   - When WebAuthn is unsupported, the action is replaced by an explanatory
 *     unsupported note (no dead button).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const registerPasskey = vi.fn();
const isPasskeySupported = vi.fn();
const listPasskeys = vi.fn();
const renamePasskey = vi.fn();
const removePasskey = vi.fn();
vi.mock("@/lib/webauthn", async () => ({
  // WARP-1157: real error mapping + origin check; only the wire is faked.
  ...(await vi.importActual<typeof import("@/lib/webauthn")>("@/lib/webauthn")),
  registerPasskey: (...a: unknown[]) => registerPasskey(...a),
  isPasskeySupported: (...a: unknown[]) => isPasskeySupported(...a),
  listPasskeys: (...a: unknown[]) => listPasskeys(...a),
  renamePasskey: (...a: unknown[]) => renamePasskey(...a),
  removePasskey: (...a: unknown[]) => removePasskey(...a),
}));

import { PasskeysSection } from "./PasskeysSection";

describe("PasskeysSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPasskeySupported.mockReturnValue(true);
    listPasskeys.mockResolvedValue([]);
  });

  it("renders the add-a-passkey action when supported", () => {
    render(<PasskeysSection />);
    expect(screen.getByRole("button", { name: /add a passkey/i })).toBeInTheDocument();
  });

  it("renders the group header via the shell Sect pattern — sentence case, no uppercase eyebrow (WARP-1344)", () => {
    render(<PasskeysSection />);
    const heading = screen.getByRole("heading", { name: "Passkeys" });
    expect(heading.className).not.toMatch(/uppercase/);
    expect(heading.closest(".sect")).not.toBeNull();
  });

  it("enrols a passkey and shows a success confirmation", async () => {
    registerPasskey.mockResolvedValueOnce(undefined);
    render(<PasskeysSection />);

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));

    await waitFor(() => expect(registerPasskey).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByText(/passkey added|registered/i)).toBeInTheDocument();
    });
  });

  it("shows a friendly error and never echoes the raw ceremony failure", async () => {
    const SECRET = "NotAllowedError: user cancelled ECONNREFUSED";
    registerPasskey.mockRejectedValueOnce(new Error(SECRET));
    render(<PasskeysSection />);

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/couldn't add|try again/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("shows an unsupported note instead of a dead button when WebAuthn is unavailable", () => {
    isPasskeySupported.mockReturnValue(false);
    render(<PasskeysSection />);
    expect(screen.queryByRole("button", { name: /add a passkey/i })).not.toBeInTheDocument();
    expect(screen.getByText(/doesn't support passkeys|not supported/i)).toBeInTheDocument();
  });

  // =====================================================================
  // WARP-1156 — the live failure: on plain-HTTP droplet.local the browser
  // refuses navigator.credentials.create() outright, and the old section
  // showed a doomed button whose every attempt died as the same generic
  // "Try again." The section must pre-empt the insecure context, and map
  // the distinguishable ceremony failures to honest copy.
  // =====================================================================

  it("replaces the button with an honest secure-address note when the context is not secure (WARP-1156)", () => {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    try {
      render(<PasskeysSection />);
      // No doomed button — the browser would reject every attempt.
      expect(
        screen.queryByRole("button", { name: /add a passkey/i }),
      ).not.toBeInTheDocument();
      // Honest, actionable copy: this needs the secure (https) address.
      expect(screen.getByText(/secure .*(address|connection)/i)).toBeInTheDocument();
      expect(screen.getByText(/https/i)).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "isSecureContext", {
        value: true,
        configurable: true,
      });
    }
  });

  it("says the prompt was closed or timed out on NotAllowedError — and keeps the retry (WARP-1156)", async () => {
    registerPasskey.mockRejectedValueOnce(
      new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"),
    );
    render(<PasskeysSection />);

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/closed or timed out/i)).toBeInTheDocument();
    });
    // Retry stays available — this failure is the user's to redo.
    expect(screen.getByRole("button", { name: /add a passkey/i })).toBeEnabled();
  });

  it("says this device already has a passkey on InvalidStateError (WARP-1156)", async () => {
    registerPasskey.mockRejectedValueOnce(
      new DOMException("The authenticator was previously registered", "InvalidStateError"),
    );
    render(<PasskeysSection />);

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/already has a passkey/i)).toBeInTheDocument();
    });
  });

  it("points at the secure address on SecurityError (origin/RP mismatch) (WARP-1156)", async () => {
    registerPasskey.mockRejectedValueOnce(
      new DOMException("The relying party ID is not a registrable domain suffix", "SecurityError"),
    );
    render(<PasskeysSection />);

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/secure .*address/i)).toBeInTheDocument();
    });
  });

  // =====================================================================
  // WARP-1157 — the address check runs first, box failures are named, and
  // the owner can see, rename and remove their passkeys.
  // =====================================================================

  it("on plain http blames the connection, not the browser (WARP-1157)", () => {
    // Browsers hide WebAuthn on http, so support reads false there too.
    isPasskeySupported.mockReturnValue(false);
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      render(<PasskeysSection />);
      expect(screen.getByText(/secure connection/i)).toBeInTheDocument();
      expect(screen.queryByText(/doesn't support passkeys/i)).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    }
  });

  it("names a storage failure on the box and does not tell the user to retry now (WARP-1157)", async () => {
    const { PasskeyServerError } = await vi.importActual<typeof import("@/lib/webauthn")>("@/lib/webauthn");
    registerPasskey.mockRejectedValueOnce(new PasskeyServerError(500, "storage_failed", "x"));
    render(<PasskeysSection />);
    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't save the passkey/i);
    expect(alert).toHaveTextContent(/on the Droplet, not your device/i);
    expect(alert).not.toHaveTextContent(/^.*Try again\.$/);
  });

  it("lists my passkeys with where each works and when it was added (WARP-1157)", async () => {
    listPasskeys.mockResolvedValue([
      {
        id: "p1",
        name: "Work laptop",
        rpId: "localhost",
        transports: ["internal"],
        createdAt: "2026-09-01T10:00:00Z",
        lastUsedAt: null,
      },
      {
        id: "p2",
        name: null,
        rpId: "d-abc.droplet-us.com",
        transports: [],
        createdAt: "2026-09-02T10:00:00Z",
        lastUsedAt: "2026-09-10T10:00:00Z",
      },
    ]);
    render(<PasskeysSection />);
    const list = await screen.findByRole("list", { name: /your passkeys/i });
    expect(list).toHaveTextContent("Work laptop");
    expect(list).toHaveTextContent("Works at localhost");
    expect(list).toHaveTextContent("Unnamed passkey");
    // A passkey made on another address is flagged — it won't be offered here.
    expect(list).toHaveTextContent("Works at d-abc.droplet-us.com (not this address)");
    expect(list).toHaveTextContent(/Not used yet/);
    expect(list).toHaveTextContent(/Last used/);
  });

  it("renames a passkey", async () => {
    listPasskeys.mockResolvedValue([
      { id: "p1", name: null, rpId: "localhost", transports: [], createdAt: "2026-09-01T10:00:00Z", lastUsedAt: null },
    ]);
    renamePasskey.mockResolvedValue(undefined);
    render(<PasskeysSection />);
    fireEvent.click(await screen.findByRole("button", { name: /rename unnamed passkey/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /passkey name/i }), {
      target: { value: "Phone" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(renamePasskey).toHaveBeenCalledWith("p1", "Phone"));
    await waitFor(() => expect(listPasskeys).toHaveBeenCalledTimes(2));
  });

  it("removes a passkey after confirming", async () => {
    listPasskeys.mockResolvedValue([
      { id: "p1", name: "Phone", rpId: "localhost", transports: [], createdAt: "2026-09-01T10:00:00Z", lastUsedAt: null },
    ]);
    removePasskey.mockResolvedValue(undefined);
    render(<PasskeysSection />);
    fireEvent.click(await screen.findByRole("button", { name: /remove phone/i }));
    fireEvent.click(await screen.findByRole("button", { name: /remove passkey/i }));
    await waitFor(() => expect(removePasskey).toHaveBeenCalledWith("p1"));
  });
});
