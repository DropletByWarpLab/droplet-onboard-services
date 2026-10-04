/**
 * WARP-3515 — the wizard's storage step tells the owner what Droplet will do
 * with the drives they prepare here, without doing any of it.
 *
 * ADR-070: Droplet measures what the cameras write and, once a prepared
 * (encrypted) drive exists, allocates a slice of it for camera recordings on its
 * own. The wizard is where drives get prepared, so it carries a note saying so —
 * and ONLY a note: no switch, no button, no write. The recording allocation is
 * shown and changed later, on Camera system > Recording storage.
 *
 * The note is a claim about this Droplet, so it appears only when the
 * orchestrator actually has the recordings endpoint; on one that does not (the
 * backend lands separately from the dashboard) the step is exactly what it was.
 *
 * The step's shared error mappers also learn the TPM refusal: a Droplet with no
 * security chip cannot encrypt a drive, and says so in the same words as the
 * Settings panel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const FIXTURE = {
  drives: [
    {
      device: "/dev/sdb1",
      mount: "/mnt/droplet/photos",
      label: "PHOTOS",
      uuid: "UUID-B",
      parent_disk: "sdb",
      size_bytes: 2_000_000_000_000,
      used_bytes: 0,
      free_bytes: 2_000_000_000_000,
      mounted: true,
      removable: true,
      displayName: null,
    },
  ],
  count: 1,
};

const fetchRecordingStorage = vi.fn();
const updateRecordingStorage = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDrives: vi.fn(async () => FIXTURE),
    fetchPools: vi.fn(async () => ({ pools: [] })),
    fetchRecordingStorage: (...a: unknown[]) => fetchRecordingStorage(...a),
    updateRecordingStorage: (...a: unknown[]) => updateRecordingStorage(...a),
  };
});

import { StorageStep, friendlyAdoptError, friendlyCreateError } from "./StorageStep";

const TPM = "This Droplet has no security chip (TPM); drives can't be encrypted.";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StorageStep — the recordings note", () => {
  it("tells the owner Droplet will automatically use an encrypted drive for camera recordings", async () => {
    fetchRecordingStorage.mockResolvedValue({ available: true, data: { status: "no_eligible_drive" } });
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);

    const note = await screen.findByTestId("recordings-auto-note");
    expect(note).toHaveTextContent(/automatically use an encrypted drive for camera recordings/i);
    expect(note).toHaveTextContent(/never go on the system drive/i);
    expect(note).toHaveTextContent(/camera system/i);
  });

  it("is information only: it contains no control, and the step performs no recording write", async () => {
    fetchRecordingStorage.mockResolvedValue({ available: true, data: { status: "active" } });
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);

    const note = await screen.findByTestId("recordings-auto-note");
    expect(within(note).queryByRole("button")).not.toBeInTheDocument();
    expect(within(note).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(note).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(updateRecordingStorage).not.toHaveBeenCalled();
  });

  it("sits beside the drive-naming UI — it does not replace it", async () => {
    fetchRecordingStorage.mockResolvedValue({ available: true, data: { status: "active" } });
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);
    await screen.findByTestId("recordings-auto-note");
    expect(screen.getByRole("button", { name: /save and continue/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/wedding photos/i)).toBeInTheDocument();
  });

  it("is absent on an orchestrator without the recordings endpoint (the step is exactly what it was)", async () => {
    fetchRecordingStorage.mockResolvedValue({ available: false, reason: "not_supported" });
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);
    await screen.findByRole("button", { name: /save and continue/i });
    await waitFor(() => expect(fetchRecordingStorage).toHaveBeenCalled());
    expect(screen.queryByTestId("recordings-auto-note")).not.toBeInTheDocument();
  });

  it("is absent when the check itself fails — an outage is not a promise", async () => {
    fetchRecordingStorage.mockRejectedValue(new Error("502"));
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);
    await screen.findByRole("button", { name: /save and continue/i });
    await waitFor(() => expect(fetchRecordingStorage).toHaveBeenCalled());
    expect(screen.queryByTestId("recordings-auto-note")).not.toBeInTheDocument();
  });

  it("a failing check never blocks the step from loading its drives", async () => {
    fetchRecordingStorage.mockRejectedValue(new Error("boom"));
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);
    expect(await screen.findByPlaceholderText(/wedding photos/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load your drives/i)).not.toBeInTheDocument();
  });
});

describe("StorageStep — a Droplet with no TPM cannot encrypt a drive", () => {
  const tpm = () => Object.assign(new Error("tpm_required"), { status: 409, code: "tpm_required" });

  it("friendlyAdoptError says so in the shared sentence", () => {
    expect(friendlyAdoptError(tpm())).toBe(TPM);
  });

  it("friendlyCreateError (a pool must be encrypted too) says so as well", () => {
    expect(friendlyCreateError(tpm())).toBe(TPM);
  });

  it("neither changes its existing copy for other failures", () => {
    expect(friendlyAdoptError(new Error("device busy"))).toMatch(/in use right now/i);
    expect(friendlyAdoptError(new Error("backs the OS"))).toMatch(/system disk/i);
    expect(friendlyCreateError(new Error("partition is mounted"))).toMatch(/have data on them/i);
  });
});
