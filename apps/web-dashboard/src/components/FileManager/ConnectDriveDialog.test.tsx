/**
 * ConnectDriveDialog — per-user WebDAV "Your drive" section (POST
 * /api/storage/network-drive/personal, every user) plus the SMB "Droplet"
 * shared drive (GET /api/storage/network-drive, gated by `showSharedDrive`).
 *
 * Covers: personal login creation + one-time password + per-OS steps + error
 * copy; and for the shared section: happy-path render of both OS addresses +
 * credential, password masking/reveal, the disabled-share state, fetch-failure
 * copy, and the showSharedDrive gate. authFetch is mocked; no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth";
import { ConnectDriveDialog } from "./ConnectDriveDialog";

const authFetchMock = authFetch as ReturnType<typeof vi.fn>;

const INFO = {
  enabled: true,
  share: "Droplet",
  username: "droplet",
  password: "s3cretpass",
  hosts: { mdns: "droplet-ai.local", lan: "droplet-ai.lan" },
  windowsPath: "\\\\droplet-ai.lan\\Droplet",
  macosUrl: "smb://droplet-ai.local/Droplet",
};

function mockInfo(body: unknown, ok = true) {
  authFetchMock.mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConnectDriveDialog shared drive", () => {
  it("loads and renders both OS addresses and the username", async () => {
    mockInfo(INFO);
    render(<ConnectDriveDialog open onClose={() => {}} showSharedDrive />);
    await waitFor(() =>
      expect(screen.getByLabelText("Windows address")).toBeInTheDocument(),
    );
    expect(authFetchMock).toHaveBeenCalledWith("/api/storage/network-drive");
    expect(screen.getByLabelText("Windows address")).toHaveTextContent(
      "\\\\droplet-ai.lan\\Droplet",
    );
    expect(screen.getByLabelText("macOS address")).toHaveTextContent(
      "smb://droplet-ai.local/Droplet",
    );
    expect(screen.getByLabelText("Username")).toHaveTextContent("droplet");
  });

  it("masks the password until the reveal toggle is pressed", async () => {
    mockInfo(INFO);
    render(<ConnectDriveDialog open onClose={() => {}} showSharedDrive />);
    await waitFor(() =>
      expect(screen.getByLabelText("Password")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Password")).not.toHaveTextContent(
      "s3cretpass",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveTextContent("s3cretpass");
  });

  it("renders the disabled-share state without addresses", async () => {
    mockInfo({ ...INFO, enabled: false, password: null });
    render(<ConnectDriveDialog open onClose={() => {}} showSharedDrive />);
    await waitFor(() =>
      expect(
        screen.getByText(/isn't enabled on this Droplet/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Windows address")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("explains a missing credential instead of showing a blank password", async () => {
    mockInfo({ ...INFO, password: null });
    render(<ConnectDriveDialog open onClose={() => {}} showSharedDrive />);
    await waitFor(() =>
      expect(
        screen.getByText(/No drive password has been generated yet/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("shows friendly error copy when the endpoint fails", async () => {
    mockInfo({}, false);
    render(<ConnectDriveDialog open onClose={() => {}} showSharedDrive />);
    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't load the connection details/),
      ).toBeInTheDocument(),
    );
  });

  it("does not fetch while closed", () => {
    mockInfo(INFO);
    render(<ConnectDriveDialog open={false} onClose={() => {}} showSharedDrive />);
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});

describe("ConnectDriveDialog showSharedDrive gate", () => {
  it("neither fetches nor renders the shared share when showSharedDrive is off", () => {
    mockInfo(INFO);
    render(<ConnectDriveDialog open onClose={() => {}} />);
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Shared Droplet folder")).not.toBeInTheDocument();
    expect(screen.getByText("Your drive")).toBeInTheDocument();
  });
});

describe("ConnectDriveDialog personal drive", () => {
  const LOGIN = {
    deviceId: "dc-1",
    username: "alice",
    appPassword: "app-pw-123",
    webdavUrl: "https://droplet-ai.local/nextcloud/remote.php/dav/files/alice/",
    macosUrl: "https://droplet-ai.local/nextcloud/remote.php/dav/files/alice/",
    windowsPath: "\\\\droplet-ai.local@SSL\\nextcloud\\remote.php\\dav\\files\\alice",
  };

  it("creates a login for the chosen platform and shows the Mac steps + credentials once", async () => {
    mockInfo(LOGIN);
    render(<ConnectDriveDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Mac" }));
    fireEvent.click(screen.getByRole("button", { name: "Create my drive login" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Your drive address")).toBeInTheDocument(),
    );
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/storage/network-drive/personal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ platform: "macos" }),
      }),
    );
    expect(screen.getByLabelText("Your drive address")).toHaveTextContent(LOGIN.macosUrl);
    expect(screen.getByLabelText("Your drive username")).toHaveTextContent("alice");
    expect(screen.getByLabelText("Your drive password")).not.toHaveTextContent("app-pw-123");
    fireEvent.click(screen.getByRole("button", { name: "Show your drive password" }));
    expect(screen.getByLabelText("Your drive password")).toHaveTextContent("app-pw-123");
    expect(screen.getByText(/Remember this password in my keychain/)).toBeInTheDocument();
    expect(screen.getByText(/only shown now/)).toBeInTheDocument();
  });

  it("shows the Windows path and steps when Windows is chosen", async () => {
    mockInfo(LOGIN);
    render(<ConnectDriveDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Windows" }));
    fireEvent.click(screen.getByRole("button", { name: "Create my drive login" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Your drive address")).toHaveTextContent(LOGIN.windowsPath),
    );
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/storage/network-drive/personal",
      expect.objectContaining({ body: JSON.stringify({ platform: "windows" }) }),
    );
    expect(screen.getByText(/Reconnect at sign-in/)).toBeInTheDocument();
    expect(screen.getByText(/Connect using different credentials/)).toBeInTheDocument();
  });

  it("tells SSO/passkey users to sign in with their password once", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "nc_credential_unavailable" }),
    } as unknown as Response);
    render(<ConnectDriveDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create my drive login" }));
    await waitFor(() =>
      expect(screen.getByText(/sign out and sign in with your password once/)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Your drive password")).not.toBeInTheDocument();
  });

  it("shows generic error copy on other failures", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    render(<ConnectDriveDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create my drive login" }));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't create your drive login/)).toBeInTheDocument(),
    );
  });
});
