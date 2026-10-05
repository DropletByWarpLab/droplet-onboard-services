/**
 * ConnectDriveDialog — per-user WebDAV "Your drive" section (POST
 * /api/storage/network-drive/personal, owner/admin/family while the owner has
 * turned personal drives on — `personalDriveEnabled` from GET
 * /api/settings/workspace) plus the SMB "Droplet" shared drive (GET
 * /api/storage/network-drive, gated by `showSharedDrive`).
 *
 * Covers: personal login creation + one-time password + per-OS steps + error
 * copy, and the owner-setting-off state; and for the shared section: happy-path render of both OS addresses +
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

/** Route by URL: the workspace flag GET and the personal-drive POST. */
function mockPersonal(opts: {
  enabled?: boolean;
  flag?: "fail";
  post?: { ok: boolean; status: number; body: unknown };
}) {
  authFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/settings/workspace") {
      if (opts.flag === "fail") {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ workspaceType: "business", personalDriveEnabled: opts.enabled ?? true }),
      } as unknown as Response;
    }
    const post = opts.post ?? { ok: true, status: 200, body: {} };
    return { ok: post.ok, status: post.status, json: async () => post.body } as unknown as Response;
  });
}

/** Wait until the "Your drive" section has resolved the flag and shows the button. */
async function createButton() {
  return screen.findByRole("button", { name: "Create my drive login" });
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

  it("links to the same shared folder in Files and closes the dialog on navigation", async () => {
    mockInfo(INFO);
    const onClose = vi.fn();
    render(<ConnectDriveDialog open onClose={onClose} showSharedDrive />);
    const link = await screen.findByRole("link", { name: "Open shared folder in Files" });
    expect(link).toHaveAttribute("href", "/files?path=%2FDroplet");
    expect(screen.getByText(/opens only the shared Droplet folder/)).toHaveTextContent(
      "My Files → Droplet",
    );
    // next/link is a plain anchor in the test harness; jsdom cannot navigate.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(onClose).toHaveBeenCalledOnce();
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
    expect(authFetchMock).not.toHaveBeenCalledWith("/api/storage/network-drive");
    expect(screen.queryByText("Shared Droplet folder")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open shared folder in Files" })).not.toBeInTheDocument();
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
    mockPersonal({ post: { ok: true, status: 200, body: LOGIN } });
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await createButton();
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
    mockPersonal({ post: { ok: true, status: 200, body: LOGIN } });
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await createButton();
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
    mockPersonal({
      post: { ok: false, status: 409, body: { error: "nc_credential_unavailable" } },
    });
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await createButton();
    fireEvent.click(screen.getByRole("button", { name: "Create my drive login" }));
    await waitFor(() =>
      expect(screen.getByText(/sign out and sign in with your password once/)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Your drive password")).not.toBeInTheDocument();
  });

  it("shows generic error copy on other failures", async () => {
    mockPersonal({ post: { ok: false, status: 500, body: {} } });
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await createButton();
    fireEvent.click(screen.getByRole("button", { name: "Create my drive login" }));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't create your drive login/)).toBeInTheDocument(),
    );
  });

  it("reads the owner setting from GET /api/settings/workspace when it opens", async () => {
    mockPersonal({});
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await createButton();
    expect(authFetchMock).toHaveBeenCalledWith("/api/settings/workspace");
    expect(screen.getByText(/All of My Files that your account can access/)).toHaveTextContent(
      "registered attached drives and permitted shared folders",
    );
    expect(screen.getByText(/doesn't share your computer's C: or D:/)).toBeInTheDocument();
  });

  it("does not read the setting while closed", () => {
    mockPersonal({});
    render(<ConnectDriveDialog open={false} onClose={() => {}} />);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("shows a note instead of the create button while the owner setting is off", async () => {
    mockPersonal({ enabled: false });
    render(<ConnectDriveDialog open onClose={() => {}} />);
    expect(await screen.findByText(/aren't turned on for this Droplet/)).toBeInTheDocument();
    expect(screen.getByText(/Your Droplet owner can turn them on in Settings/)).toBeInTheDocument();
    expect(screen.getByText("Your drive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create my drive login" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mac" })).not.toBeInTheDocument();
  });

  it("treats a response without the flag as off", async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ workspaceType: "business" }),
    } as unknown as Response);
    render(<ConnectDriveDialog open onClose={() => {}} />);
    expect(await screen.findByText(/aren't turned on for this Droplet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create my drive login" })).not.toBeInTheDocument();
  });

  it("does not offer the create button when the setting cannot be read", async () => {
    mockPersonal({ flag: "fail" });
    render(<ConnectDriveDialog open onClose={() => {}} />);
    expect(await screen.findByText(/Couldn't check whether personal drives are on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create my drive login" })).not.toBeInTheDocument();
  });

  it("falls back to the off note when the owner turns it off mid-session", async () => {
    mockPersonal({
      post: { ok: false, status: 403, body: { error: "personal_drive_disabled" } },
    });
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await createButton();
    fireEvent.click(screen.getByRole("button", { name: "Create my drive login" }));
    expect(await screen.findByText(/aren't turned on for this Droplet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create my drive login" })).not.toBeInTheDocument();
  });

  it("keeps the shared SMB section independent of the personal setting", async () => {
    authFetchMock.mockImplementation(async (url: string) => {
      const body = url === "/api/storage/network-drive" ? INFO : { personalDriveEnabled: false };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    });
    render(<ConnectDriveDialog open onClose={() => {}} showSharedDrive />);
    expect(await screen.findByLabelText("Windows address")).toBeInTheDocument();
    expect(screen.getByText(/aren't turned on for this Droplet/)).toBeInTheDocument();
  });
});
