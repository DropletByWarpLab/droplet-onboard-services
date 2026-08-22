/**
 * ConnectDriveDialog — connect instructions for the SMB "Droplet" network
 * drive (GET /api/storage/network-drive).
 *
 * Covers: happy-path render of both OS addresses + credential, password
 * masking/reveal, the disabled-share state, and fetch-failure copy. authFetch
 * is mocked; no network.
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

describe("ConnectDriveDialog", () => {
  it("loads and renders both OS addresses and the username", async () => {
    mockInfo(INFO);
    render(<ConnectDriveDialog open onClose={() => {}} />);
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
    render(<ConnectDriveDialog open onClose={() => {}} />);
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
    render(<ConnectDriveDialog open onClose={() => {}} />);
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
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No drive password has been generated yet/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("shows friendly error copy when the endpoint fails", async () => {
    mockInfo({}, false);
    render(<ConnectDriveDialog open onClose={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't load the connection details/),
      ).toBeInTheDocument(),
    );
  });

  it("does not fetch while closed", () => {
    mockInfo(INFO);
    render(<ConnectDriveDialog open={false} onClose={() => {}} />);
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
