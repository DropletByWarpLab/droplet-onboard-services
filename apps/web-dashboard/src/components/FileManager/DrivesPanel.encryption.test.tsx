/**
 * WARP-3515 — Settings → Storage under ADR-070 / WARP-3512.
 *
 * Every data drive is encrypted at rest (LUKS2 + TPM2 auto-unlock + a recovery
 * key), camera recordings get a size-capped slice of one of them, and the drive
 * they are written to must not be ejected or erased from under them. The panel
 * therefore:
 *
 *   - says whether each drive is encrypted, and that a plain one "needs
 *     preparing — will be encrypted";
 *   - says which drive recordings live on, and what is reserved for them;
 *   - offers "Prepare drive" (erase + set up encrypted) on a plain drive behind
 *     the same confirm-token + typed-name friction as Reclaim;
 *   - hands the owner the one-time recovery key right after, via a dialog that
 *     can never be dismissed by accident (and offers a new one if it was missed);
 *   - says plainly when the box has no TPM and so cannot encrypt;
 *   - disables Eject on the recordings drive, WITH an explanation;
 *   - and degrades silently on an orchestrator that predates all of it
 *     (WARP-3513 lands separately): no field → no claim, no crash.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { DiskInfo, DriveInfo, PoolInfo } from "@/lib/types";

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

const useDrivesMock = vi.fn();
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: () => useDrivesMock() }));

const usePoolsMock = vi.fn();
vi.mock("@/lib/hooks/usePools", () => ({ usePools: () => usePoolsMock() }));

const toastMock = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    updateDriveLabel: vi.fn(),
    updatePoolLabel: vi.fn(),
    ejectDrive: vi.fn(),
    rescanDrives: vi.fn(),
    adoptDrive: vi.fn(),
    reclaimDrive: vi.fn(),
    confirmStorageCommand: vi.fn(),
    requestFormatPool: vi.fn(),
    revealRecoveryKey: vi.fn(),
    regenerateRecoveryKey: vi.fn(),
  };
});

vi.mock("@/lib/print-recovery-key", () => ({ printRecoveryKey: vi.fn() }));

import {
  adoptDrive,
  confirmStorageCommand,
  ejectDrive,
  RecoveryKeyUnavailableError,
  regenerateRecoveryKey,
  requestFormatPool,
  revealRecoveryKey,
} from "@/lib/api";
import { DrivesPanel } from "./DrivesPanel";

const GIB = 1024 ** 3;
const KEY = "cccccccc-dddddddd-eeeeeeee-ffffffff-gggggggg-hhhhhhhh";

function makeDrive(overrides: Partial<DriveInfo> = {}): DriveInfo {
  return {
    device: "/dev/sdb1",
    parent_disk: "sdb",
    mount: "/mnt/droplet/photos-ab12cd34",
    label: "Photos",
    uuid: "U-PLAIN",
    size_bytes: 2_000_000_000_000,
    used_bytes: 100_000_000_000,
    free_bytes: 1_900_000_000_000,
    mounted: true,
    bus: "usb",
    fs: "ext4",
    removable: true,
    displayName: "Wedding Photos",
    icon: null,
    notes: null,
    ...overrides,
  };
}

const plain = (o: Partial<DriveInfo> = {}) =>
  makeDrive({ encryption: "none", preparation: "needs_preparing", usage: { role: null, reservedBytes: null }, ...o });

const encrypted = (o: Partial<DriveInfo> = {}) =>
  makeDrive({
    uuid: "U-ENC",
    device: "/dev/mapper/droplet-bay-1a2b3c4d",
    parent_disk: "sdc",
    mount: "/mnt/droplet/bay2-1a2b3c4d",
    label: "Bay2",
    displayName: "Bay 2",
    encryption: "luks2",
    preparation: "prepared",
    usage: { role: null, reservedBytes: null },
    ...o,
  });

const recordingsDrive = (o: Partial<DriveInfo> = {}) =>
  encrypted({ usage: { role: "recordings", reservedBytes: 120 * GIB }, ...o });

function makeDisk(overrides: Partial<DiskInfo> = {}): DiskInfo {
  return {
    name: "sdd",
    size_bytes: 1_000_000_000_000,
    state: "foreign",
    fstype: "ntfs",
    bus: "usb",
    model: "Samsung T7",
    serial: "S5SXNJ0W123456",
    ...overrides,
  };
}

const refresh = vi.fn();

function setup({
  role = "owner",
  drives = [plain()],
  disks = [],
  pools = [],
}: {
  role?: "owner" | "admin" | "family" | "guest";
  drives?: DriveInfo[];
  disks?: DiskInfo[];
  pools?: PoolInfo[];
} = {}) {
  useAuthMock.mockReturnValue({ user: { id: "u1", username: "u", displayName: "U", role } });
  useDrivesMock.mockReturnValue({
    drives,
    disks,
    isLoading: false,
    bridgeError: undefined,
    refresh,
  });
  usePoolsMock.mockReturnValue({ pools, refresh: vi.fn() });
  return render(<DrivesPanel />);
}

function cardOf(name: RegExp | string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  return heading.closest('[role="listitem"]') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  refresh.mockResolvedValue(undefined);
});

describe("DrivesPanel — encryption badge", () => {
  it("an encrypted drive says Encrypted", () => {
    setup({ drives: [encrypted()] });
    expect(within(cardOf("Bay 2")).getByText("Encrypted")).toBeInTheDocument();
  });

  it("a plain drive says it needs preparing and will be encrypted", () => {
    setup({ drives: [plain()] });
    expect(
      within(cardOf("Wedding Photos")).getByText("Needs preparing — will be encrypted"),
    ).toBeInTheDocument();
  });

  it("a drive whose encryption could not be determined says so, plainly", () => {
    setup({ drives: [makeDrive({ encryption: "unknown" })] });
    expect(within(cardOf("Wedding Photos")).getByText("Encryption unknown")).toBeInTheDocument();
  });

  it("says NOTHING about encryption when the orchestrator did not report it (older backend)", () => {
    setup({ drives: [makeDrive()] });
    const card = cardOf("Wedding Photos");
    expect(within(card).queryByText(/encrypt/i)).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /prepare drive/i })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /recovery key/i })).not.toBeInTheDocument();
    // …and the card still works exactly as before.
    expect(within(card).getByRole("button", { name: /eject/i })).toBeEnabled();
  });

  it("never claims a drive is encrypted on contradictory data", () => {
    setup({ drives: [makeDrive({ encryption: "none", preparation: "prepared" })] });
    expect(within(cardOf("Wedding Photos")).queryByText("Encrypted")).not.toBeInTheDocument();
  });
});

describe("DrivesPanel — what a drive is used for", () => {
  it("names the recordings assignment and allocated capacity", () => {
    setup({ drives: [recordingsDrive()] });
    expect(
      within(cardOf("Bay 2")).getByText("Assigned to: Camera recordings · 120 GB allocated"),
    ).toBeInTheDocument();
  });

  it("omits the reservation when there is none", () => {
    setup({ drives: [recordingsDrive({ usage: { role: "recordings", reservedBytes: null } })] });
    expect(within(cardOf("Bay 2")).getByText("Assigned to: Camera recordings")).toBeInTheDocument();
  });

  it("says nothing for a drive that only holds files", () => {
    setup({ drives: [encrypted({ usage: { role: "files", reservedBytes: null } })] });
    expect(within(cardOf("Bay 2")).queryByText(/used for/i)).not.toBeInTheDocument();
  });

  it("tolerates usage: null and a missing usage", () => {
    setup({ drives: [encrypted({ usage: null }), plain({ usage: undefined, uuid: "U-2", displayName: "Other" })] });
    expect(screen.queryByText(/used for/i)).not.toBeInTheDocument();
  });
});

describe("DrivesPanel — the recordings drive cannot be ejected or erased", () => {
  it("disables Eject, keeps it focusable, and explains why", () => {
    setup({ drives: [recordingsDrive()] });
    const card = cardOf("Bay 2");
    const eject = within(card).getByRole("button", { name: /eject/i });
    expect(eject).toHaveAttribute("aria-disabled", "true");
    // The explanation is the button's accessible description, not just nearby text.
    const describedBy = eject.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)).toHaveTextContent(
      /this drive is assigned to camera recordings/i,
    );
    // (typographic apostrophe in the copy, so `.` rather than a literal ')
    expect(document.getElementById(describedBy)).toHaveTextContent(/can.t be ejected or erased/i);
  });

  it("a click on the disabled Eject does nothing", () => {
    setup({ drives: [recordingsDrive()] });
    fireEvent.click(within(cardOf("Bay 2")).getByRole("button", { name: /eject/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(ejectDrive).not.toHaveBeenCalled();
  });

  it("links to where the recordings drive is changed", () => {
    setup({ drives: [recordingsDrive()] });
    const link = within(cardOf("Bay 2")).getByRole("link", { name: /recording storage/i });
    expect(link).toHaveAttribute("href", "/cameras/system#recording-storage");
    // It sits in a card with a stretched title link: it must be lifted above it.
    expect(link.className).toMatch(/(?:^|\s)relative(?:\s|$)/);
  });

  it("never offers Prepare drive on it", () => {
    setup({ drives: [recordingsDrive({ encryption: "none", preparation: "needs_preparing" })] });
    expect(screen.queryByRole("button", { name: /prepare drive/i })).not.toBeInTheDocument();
  });

  it("leaves Eject working on every OTHER drive", () => {
    setup({ drives: [recordingsDrive(), encrypted({ uuid: "U-2", displayName: "Bay 3", usage: { role: null, reservedBytes: null } })] });
    expect(within(cardOf("Bay 3")).getByRole("button", { name: /eject/i })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("DrivesPanel — the system disk is never acted on", () => {
  it("shows no Eject, Prepare or Recovery key on a drive flagged isSystemDisk", () => {
    setup({ drives: [plain({ isSystemDisk: true })] });
    const card = cardOf("Wedding Photos");
    expect(within(card).getByText("System drive")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /eject|prepare drive|recovery key/i })).not.toBeInTheDocument();
  });
});

describe("DrivesPanel — Prepare drive on a plain drive (tier 3)", () => {
  const token = {
    status: "confirmation_required",
    confirmationToken: "tok-prep",
    service: "drive_adopt",
    resourceId: "sdb",
  };

  it("is offered to an admin with an honest explanation, and not to a family member", () => {
    const { unmount } = setup({ role: "admin" });
    const card = cardOf("Wedding Photos");
    expect(within(card).getByText(/erases everything on it and sets it up encrypted/i)).toBeInTheDocument();
    const button = within(card).getByRole("button", { name: /prepare drive/i });
    // Lifted above the stretched title link, like every control in this card.
    expect(button.className).toMatch(/(?:^|\s)relative(?:\s|$)/);
    unmount();
    setup({ role: "family" });
    expect(screen.queryByRole("button", { name: /prepare drive/i })).not.toBeInTheDocument();
  });

  it("is not offered on an already-encrypted drive", () => {
    setup({ drives: [encrypted()] });
    expect(screen.queryByRole("button", { name: /prepare drive/i })).not.toBeInTheDocument();
  });

  it("mints the confirm token with the host-script phrase, then needs the drive's name typed", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue(token);
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    setup();

    fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));

    await waitFor(() =>
      expect(adoptDrive).toHaveBeenCalledWith(
        expect.objectContaining({
          device: "sdb",
          wipeMethod: "quick",
          confirmPhrase: "ERASE sdb",
          // The customer's own name seeds the post-wipe label (WARP-1337).
          label: "Wedding_Photos",
        }),
      ),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /prepare this drive/i })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/permanently erases everything on Wedding Photos/i);
    expect(dialog).toHaveTextContent(/sets it up encrypted/i);
    expect(dialog).toHaveTextContent(/can't be undone/i);
    expect(dialog).toHaveTextContent(/recovery key/i);

    const confirm = within(dialog).getByRole("button", { name: /^prepare drive$/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(confirmStorageCommand).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "not the name" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Wedding Photos" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(confirmStorageCommand).toHaveBeenCalledWith({
        confirmationToken: "tok-prep",
        service: "drive_adopt",
        resourceId: "sdb",
      }),
    );
  });

  it("cancelling executes nothing", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue(token);
    setup();
    fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    expect(confirmStorageCommand).not.toHaveBeenCalled();
  });

  it("an admin's success says the owner can view the recovery key — and opens no key dialog", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue(token);
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    setup({ role: "admin" });
    fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Wedding Photos" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^prepare drive$/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.stringMatching(/the owner can view its recovery key/i),
        "success",
      ),
    );
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a failure toasts calm copy and closes — a used confirm token is not retryable", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue(token);
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("mkfs failed: device busy /dev/sdb1"),
    );
    setup();
    fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Wedding Photos" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^prepare drive$/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(toastMock.mock.calls[0]![0]).not.toMatch(/mkfs|sdb1/);
  });
});

describe("DrivesPanel — the one-time recovery key, right after preparing", () => {
  const token = {
    status: "confirmation_required",
    confirmationToken: "tok-prep",
    service: "drive_adopt",
    resourceId: "sdb",
  };

  async function prepareAsOwner() {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue(token);
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    // After the wipe the drive comes back as a NEW encrypted filesystem.
    refresh.mockResolvedValue({
      drives: [
        encrypted({
          uuid: "U-NEW-LUKS",
          parent_disk: "sdb",
          device: "/dev/mapper/droplet-bay-9f8e7d6c",
          displayName: "Wedding Photos",
        }),
      ],
    });
    setup();
    fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));
    const dialog = await screen.findByRole("dialog", { name: /prepare this drive/i });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Wedding Photos" } });
    const confirm = within(dialog).getByRole("button", { name: /^prepare drive$/i });
    await waitFor(() => expect(confirm).toBeEnabled());
    // Flush the async confirmation and its state updates before observing the
    // second dialog; the Prepare dialog can still be animating out.
    await act(async () => { fireEvent.click(confirm); });
    expect(confirmStorageCommand).toHaveBeenCalledOnce();
    // The Prepare dialog is still fading out when the key dialog opens, so two
    // dialogs can be in the DOM for a beat: hand back the KEY dialog itself.
    const heading = await screen.findByRole("heading", { name: /save your recovery key/i });
    return heading.closest('[role="dialog"]') as HTMLElement;
  }

  it("offers the owner the key in a dialog naming the drive — and has consumed nothing yet", async () => {
    const keyDialog = await prepareAsOwner();
    expect(keyDialog).toHaveTextContent(/Wedding Photos/);
    expect(revealRecoveryKey).not.toHaveBeenCalled();
  });

  it("looks up the NEW filesystem's id only when the owner asks, and shows the key", async () => {
    (revealRecoveryKey as ReturnType<typeof vi.fn>).mockResolvedValue(KEY);
    await prepareAsOwner();

    fireEvent.click(screen.getByRole("button", { name: /show recovery key/i }));

    expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent(KEY);
    expect(revealRecoveryKey).toHaveBeenCalledTimes(1);
    expect(revealRecoveryKey).toHaveBeenCalledWith("U-NEW-LUKS");
  });

  it("an encrypted drive carries a Recovery key button for the owner — for a key never viewed", async () => {
    (revealRecoveryKey as ReturnType<typeof vi.fn>).mockResolvedValue(KEY);
    setup({ drives: [encrypted()] });
    const button = within(cardOf("Bay 2")).getByRole("button", { name: /recovery key/i });
    expect(button.className).toMatch(/(?:^|\s)relative(?:\s|$)/);

    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: /show recovery key/i }));
    await screen.findByTestId("recovery-key-value");
    expect(revealRecoveryKey).toHaveBeenCalledWith("U-ENC");
  });

  it("an admin and a family member are not offered the recovery key", () => {
    const { unmount } = setup({ role: "admin", drives: [encrypted()] });
    expect(screen.queryByRole("button", { name: /recovery key/i })).not.toBeInTheDocument();
    unmount();
    setup({ role: "family", drives: [encrypted()] });
    expect(screen.queryByRole("button", { name: /recovery key/i })).not.toBeInTheDocument();
  });

  it("offers no Recovery key for a drive the bridge reports without an id", () => {
    setup({ drives: [encrypted({ uuid: "" })] });
    expect(screen.queryByRole("button", { name: /recovery key/i })).not.toBeInTheDocument();
  });
});

describe("DrivesPanel — Prepare drive on an unmounted disk", () => {
  it("is worded Prepare drive (not Erase & adopt) once the orchestrator reports encryption", () => {
    setup({ drives: [encrypted()], disks: [makeDisk()] });
    expect(screen.getByRole("button", { name: /prepare drive/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /erase & adopt/i })).not.toBeInTheDocument();
    expect(screen.getByText(/set it up encrypted/i)).toBeInTheDocument();
  });

  it("keeps the legacy Erase & adopt wording on an orchestrator that reports nothing", () => {
    setup({ drives: [makeDrive()], disks: [makeDisk()] });
    expect(screen.getByRole("button", { name: /erase & adopt/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /prepare drive/i })).not.toBeInTheDocument();
  });

  it("uses the typed-name friction, naming the disk, before anything executes", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-disk",
      service: "drive_adopt",
      resourceId: "sdd",
    });
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    setup({ drives: [encrypted()], disks: [makeDisk()] });

    fireEvent.click(screen.getByRole("button", { name: /prepare drive/i }));
    await waitFor(() =>
      expect(adoptDrive).toHaveBeenCalledWith(
        expect.objectContaining({ device: "sdd", confirmPhrase: "ERASE sdd", label: "Samsung_T7" }),
      ),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Samsung T7/);
    expect(confirmStorageCommand).not.toHaveBeenCalled();

    const confirm = within(dialog).getByRole("button", { name: /^prepare drive$/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Samsung T7" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(confirmStorageCommand).toHaveBeenCalledWith({
        confirmationToken: "tok-disk",
        service: "drive_adopt",
        resourceId: "sdd",
      }),
    );
  });
});

describe("DrivesPanel — pools", () => {
  const pool: PoolInfo = {
    device: "md127",
    level: "raid1",
    status: "active",
    members: ["sda", "sdb"],
    displayName: "Family pool",
  };

  it("shows the pool's assignment and explicit SMART availability without one member's verdict", () => {
    setup({
      pools: [pool],
      drives: [
        encrypted({
          device: "/dev/md127",
          pool: "md127",
          uuid: "U-POOL",
          usage: { role: "recordings", reservedBytes: 50 * GIB },
          smart_status: "unavailable",
          smart: "PASSED",
        }),
      ],
    });
    const card = screen.getByRole("heading", { name: /family pool/i }).closest('[role="listitem"]') as HTMLElement;
    expect(within(card).getByText("Encrypted")).toBeInTheDocument();
    expect(within(card).getByText("Assigned to: Camera recordings · 50 GB allocated")).toBeInTheDocument();
    expect(within(card).getByText("SMART data unavailable")).toBeInTheDocument();
    expect(within(card).queryByText("SMART PASSED")).not.toBeInTheDocument();
  });

  it("a never-formatted pool says Format will encrypt it, and the owner gets the key after", async () => {
    (requestFormatPool as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-fmt",
      service: "pool_format",
      resourceId: "md127",
    });
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    refresh.mockResolvedValue({
      drives: [encrypted({ device: "/dev/md127", pool: "md127", uuid: "U-POOL-NEW" })],
    });
    // Another drive reports encryption, so the orchestrator is encryption-aware.
    setup({ pools: [pool], drives: [encrypted({ uuid: "U-OTHER", displayName: "Bay 3" })] });

    fireEvent.click(screen.getByRole("button", { name: /format & mount/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/encrypted/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /format & mount/i }));

    expect(await screen.findByRole("heading", { name: /save your recovery key/i })).toBeInTheDocument();
  });
});

describe("DrivesPanel — never crashes on a half-adopted payload", () => {
  it("renders a drive with only some of the new fields", () => {
    setup({ drives: [makeDrive({ preparation: "needs_preparing" }), makeDrive({ uuid: "U-2", displayName: "Other", usage: { role: "recordings", reservedBytes: null } })] });
    expect(screen.getByText("Needs preparing — will be encrypted")).toBeInTheDocument();
    expect(screen.getByText("Assigned to: Camera recordings")).toBeInTheDocument();
  });
});

describe("DrivesPanel — a Droplet with no TPM cannot encrypt a drive", () => {
  const TPM = "This Droplet has no security chip (TPM); drives can't be encrypted.";
  const tpmError = () =>
    Object.assign(new Error("tpm_required"), { status: 409, code: "tpm_required" });
  const mintToken = {
    status: "confirmation_required",
    confirmationToken: "tok",
    service: "drive_adopt",
    resourceId: "sdb",
  };

  it("Prepare: a refusal when the token is minted says so, and no dialog opens", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockRejectedValue(tpmError());
    setup();
    fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(TPM, "error"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Prepare: a refusal on the confirm says so too — and still closes (a used token is not retryable)", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue(mintToken);
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockRejectedValue(tpmError());
    setup();
    // Finish token minting and the dialog's open-state reset before typing.
    await act(async () => {
      fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));
    });
    const dialog = await screen.findByRole("dialog", { name: /prepare this drive/i });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Wedding Photos" } });
    const confirm = within(dialog).getByRole("button", { name: /^prepare drive$/i });
    await waitFor(() => expect(confirm).toBeEnabled());
    await act(async () => { fireEvent.click(confirm); });
    expect(confirmStorageCommand).toHaveBeenCalledOnce();
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(TPM, "error"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Erase & adopt on an older orchestrator says it as well", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockRejectedValue(tpmError());
    setup({ drives: [makeDrive()], disks: [makeDisk()] });
    fireEvent.click(screen.getByRole("button", { name: /erase & adopt/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(TPM, "error"));
  });

  it("Format & mount says it too", async () => {
    (requestFormatPool as ReturnType<typeof vi.fn>).mockRejectedValue(tpmError());
    setup({
      pools: [{ device: "md127", level: "raid1", status: "active", members: ["sda", "sdb"], displayName: "Pool" }],
      drives: [],
    });
    fireEvent.click(screen.getByRole("button", { name: /format & mount/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(TPM, "error"));
  });

  it("any other failure still gets the calm 'couldn't prepare' copy — not the TPM sentence", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    setup();
    fireEvent.click(within(cardOf("Wedding Photos")).getByRole("button", { name: /prepare drive/i }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't prepare that drive/i), "error"),
    );
    expect(toastMock).not.toHaveBeenCalledWith(TPM, "error");
  });
});

describe("DrivesPanel — replacing a missed or expired recovery key (tier 3)", () => {
  it("gone → generate a new key → type the drive's name → regenerate for THAT drive → reveal the new one", async () => {
    (revealRecoveryKey as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new RecoveryKeyUnavailableError("gone"))
      .mockResolvedValueOnce(KEY);
    (regenerateRecoveryKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    setup({ drives: [encrypted()] });

    fireEvent.click(within(cardOf("Bay 2")).getByRole("button", { name: /recovery key/i }));
    fireEvent.click(await screen.findByRole("button", { name: /show recovery key/i }));
    fireEvent.click(await screen.findByRole("button", { name: /generate a new recovery key/i }));

    const heading = await screen.findByRole("heading", { name: /generate a new recovery key\?/i });
    const confirm = heading.closest('[role="dialog"]') as HTMLElement;
    expect(regenerateRecoveryKey).not.toHaveBeenCalled();
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "Bay 2" } });
    fireEvent.click(within(confirm).getByRole("button", { name: /^generate new key$/i }));

    await waitFor(() => expect(regenerateRecoveryKey).toHaveBeenCalledWith("U-ENC"));
    fireEvent.click(await screen.findByRole("button", { name: /show recovery key/i }));
    expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent(KEY);
  });
});

describe("DrivesPanel — the recordings explanation, for whoever reads it", () => {
  it("an owner or admin is pointed at where the recordings drive is changed", () => {
    setup({ role: "admin", drives: [recordingsDrive()] });
    expect(within(cardOf("Bay 2")).getByRole("link", { name: /recording storage/i })).toBeInTheDocument();
  });

  it("a family member gets the reason but not a link into a card they cannot see", () => {
    setup({ role: "family", drives: [recordingsDrive()] });
    const card = cardOf("Bay 2");
    expect(card).toHaveTextContent(/this drive is assigned to camera recordings/i);
    expect(within(card).queryByRole("link", { name: /recording storage/i })).not.toBeInTheDocument();
  });
});
