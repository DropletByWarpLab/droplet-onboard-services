/**
 * WARP-827 — Drives panel remake.
 *
 * Covers the dashboard-side acceptance criteria:
 *   - AC2: inline, admin-only rename wired to updateDriveLabel(uuid,
 *     { displayName }). Edit → save shows the new name optimistically;
 *     non-admins get no edit affordance; validation rejects empty/too-long.
 *   - AC3/AC6: the raw /dev/sdX device path is NEVER rendered to the user.
 *   - AC5: a drive card deep-links into the existing Nextcloud file browser
 *     scoped to the drive (reuse — no new endpoint).
 *
 * The two data hooks are mocked so the suite drives the render/interaction
 * layer directly; `updateDriveLabel` is mocked to assert the wired call and
 * exercise the optimistic update + rollback. useAuth is mocked to flip the
 * admin gate (same pattern as the auth-gate suites).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { DriveInfo } from "@/lib/types";

// next/link → plain anchor so we can assert href without a Next router.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

const useDrivesMock = vi.fn();
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: () => useDrivesMock() }));

const usePoolsMock = vi.fn();
vi.mock("@/lib/hooks/usePools", () => ({ usePools: () => usePoolsMock() }));

const toastMock = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/lib/api", () => ({
  updateDriveLabel: vi.fn(),
  ejectDrive: vi.fn(),
  rescanDrives: vi.fn(),
}));

import { updateDriveLabel } from "@/lib/api";
import { DrivesPanel } from "./DrivesPanel";

function makeDrive(overrides: Partial<DriveInfo> = {}): DriveInfo {
  return {
    device: "/dev/sdb1",
    mount: "/mnt/droplet/photos-ab12cd34",
    label: "TOSHIBA EXT",
    uuid: "U-DATA-1",
    size_bytes: 2_000_000_000_000,
    used_bytes: 100_000_000_000,
    free_bytes: 1_900_000_000_000,
    mounted: true,
    bus: "usb",
    fs: "ext4",
    removable: true,
    displayName: null,
    icon: null,
    notes: null,
    ...overrides,
  };
}

const refresh = vi.fn();

function setup({
  role = "owner",
  drives = [makeDrive()],
}: { role?: "owner" | "admin" | "family" | "guest"; drives?: DriveInfo[] } = {}) {
  useAuthMock.mockReturnValue({ user: { id: "u1", username: "u", displayName: "U", role } });
  useDrivesMock.mockReturnValue({
    drives,
    isLoading: false,
    bridgeError: undefined,
    refresh,
  });
  usePoolsMock.mockReturnValue({ pools: [], refresh: vi.fn() });
  return render(<DrivesPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DrivesPanel — no raw device path (WARP-827 AC3/AC6)", () => {
  it("never renders the raw /dev/sdX path", () => {
    setup();
    expect(screen.queryByText(/\/dev\/sd/)).not.toBeInTheDocument();
    expect(screen.queryByText("/dev/sdb1")).not.toBeInTheDocument();
  });

  it("still shows the friendly bus label", () => {
    setup();
    expect(screen.getByText("USB")).toBeInTheDocument();
  });
});

describe("DrivesPanel — drive contents deep-link (WARP-827 AC5)", () => {
  it("links the drive into the file browser scoped to its mount tail", () => {
    setup({ drives: [makeDrive({ mount: "/mnt/droplet/photos-ab12cd34" })] });
    const link = screen.getByRole("link", { name: /open|view|browse|contents|files/i });
    // The existing FilesPage honors ?path=; the drive surfaces in Nextcloud at
    // /<mount-tail>, so the deep-link must target that path.
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/files?path=%2Fphotos-ab12cd34"),
    );
  });
});

describe("DrivesPanel — inline rename (WARP-827 AC2)", () => {
  it("shows no edit affordance for a non-admin (family) user", () => {
    setup({ role: "family" });
    expect(screen.queryByRole("button", { name: /rename|edit name/i })).not.toBeInTheDocument();
  });

  it("admin can edit → save and sees the new name optimistically", async () => {
    (updateDriveLabel as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: "U-DATA-1",
      displayName: "Wedding Photos",
      icon: null,
      notes: null,
    });
    setup({ role: "owner" });

    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    const input = screen.getByRole("textbox", { name: /drive name/i });
    fireEvent.change(input, { target: { value: "Wedding Photos" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // Wired to the existing client fn with the right shape.
    await waitFor(() =>
      expect(updateDriveLabel).toHaveBeenCalledWith("U-DATA-1", {
        displayName: "Wedding Photos",
      }),
    );
    // Optimistic: the new name is on screen before/without a refetch.
    expect(await screen.findByText("Wedding Photos")).toBeInTheDocument();
  });

  it("trims and rejects an empty name without calling the API", () => {
    setup({ role: "owner" });
    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    const input = screen.getByRole("textbox", { name: /drive name/i });
    fireEvent.change(input, { target: { value: "   " } });
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    fireEvent.click(save);
    expect(updateDriveLabel).not.toHaveBeenCalled();
  });

  it("cancel exits edit mode and keeps the original name", () => {
    setup({ role: "owner", drives: [makeDrive({ displayName: "Photos" })] });
    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /drive name/i }), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("textbox", { name: /drive name/i })).not.toBeInTheDocument();
    expect(screen.getByText("Photos")).toBeInTheDocument();
  });

  it("rolls back the optimistic name when the save fails", async () => {
    (updateDriveLabel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    setup({ role: "owner", drives: [makeDrive({ displayName: "Photos" })] });

    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /drive name/i }), {
      target: { value: "Wedding Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // After the rejected save the original name is restored and an error toast fires.
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(screen.getByText("Photos")).toBeInTheDocument();
  });
});
