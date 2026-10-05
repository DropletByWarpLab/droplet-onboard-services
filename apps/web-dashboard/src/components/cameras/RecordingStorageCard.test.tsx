/**
 * WARP-3515 — the "Recording storage" card on /cameras/system.
 *
 * Droplet measures, sizes and allocates the camera-recordings slice itself
 * (ADR-070, WARP-3512). This card is where an owner SEES that and makes the two
 * choices that are theirs: auto-sized vs whole drive, and which eligible drive.
 * It has a state for every status the contract defines, a plain-language fix for
 * every warning code, and — because the three backend branches land separately —
 * a neutral state for an orchestrator that does not have the endpoint yet.
 *
 * The data hook, auth, toasts and the API writes are mocked so the suite drives
 * the render/interaction layer directly (the same shape DrivesPanel.test uses).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RecordingStorage } from "@/lib/types";
import type { UseRecordingStorage } from "@/lib/hooks/useRecordingStorage";
import { normalizeRecordingStorage } from "@/lib/recording-storage";

const hook = vi.hoisted(() => ({ value: undefined as unknown, args: [] as unknown[] }));
vi.mock("@/lib/hooks/useRecordingStorage", () => ({
  useRecordingStorage: (...args: unknown[]) => {
    hook.args = args;
    return hook.value;
  },
}));

const auth = vi.hoisted(() => ({ role: "owner" as string }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "u", displayName: "U", role: auth.role } }),
}));

const toastMock = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/lib/api", () => ({
  updateRecordingStorage: vi.fn(),
  deleteOldRecordings: vi.fn(),
}));

import { updateRecordingStorage, deleteOldRecordings } from "@/lib/api";
import { RecordingStorageCard } from "./RecordingStorageCard";

const updateMock = vi.mocked(updateRecordingStorage);
const deleteMock = vi.mocked(deleteOldRecordings);

const GIB = 1024 ** 3;
const refresh = vi.fn().mockResolvedValue(undefined);

function makeRecording(overrides: Partial<RecordingStorage> = {}): RecordingStorage {
  return {
    status: "active",
    mode: "auto_reserved",
    drive: {
      fsUuid: "fs-1",
      label: "Bay 2",
      model: "WD Red",
      sizeBytes: 4000 * GIB,
      encrypted: true,
      mountPath: "/mnt/droplet/bay2-1a2b3c4d",
    },
    reservedBytes: 120 * GIB,
    usedBytes: 40 * GIB,
    freeBytes: 80 * GIB,
    needBytes: 96 * GIB,
    retentionDays: 7,
    daysStored: 3.4,
    cameras: [
      {
        name: "front_door",
        displayName: "Front door",
        mbPerHour: 1500,
        gbPerDay: 36,
        needBytes: 75 * GIB,
        usedBytes: 20 * GIB,
      },
      {
        name: "garage",
        displayName: "Garage",
        mbPerHour: 500,
        gbPerDay: 12,
        needBytes: 25 * GIB,
        usedBytes: 20 * GIB,
      },
    ],
    migration: {
      state: "idle",
      progressPct: 0,
      bytesCopied: 0,
      bytesTotal: 0,
      startedAt: null,
      error: null,
    },
    oldFootage: { present: false, bytes: 0, location: "system_disk" },
    warnings: [],
    eligibleDrives: [],
    ...overrides,
  };
}

function setup(
  recording: RecordingStorage | null,
  {
    role = "owner",
    state = recording ? "ready" : "loading",
    stale = false,
  }: { role?: string; state?: UseRecordingStorage["state"]; stale?: boolean } = {},
) {
  auth.role = role;
  hook.value = { state, recording, stale, refresh } satisfies UseRecordingStorage;
  return render(<RecordingStorageCard />);
}

beforeEach(() => {
  vi.clearAllMocks();
  refresh.mockResolvedValue(undefined);
});

describe("RecordingStorageCard — not-there-yet and not-ready states", () => {
  it("shows a busy skeleton while the first fetch is in flight, and keeps its anchor", () => {
    setup(null, { state: "loading" });
    const card = screen.getByTestId("recording-storage-card");
    expect(card).toHaveAttribute("id", "recording-storage");
    expect(card).toHaveAttribute("aria-busy", "true");
  });

  it("says 'couldn't load' with a retry — never 'not available' — when the fetch fails", () => {
    setup(null, { state: "error" });
    expect(screen.getByText(/couldn't load recording storage/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn't available on this droplet yet/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows a neutral 'not available on this Droplet yet' state when the endpoint is absent", () => {
    setup(null, { state: "not_supported" });
    expect(screen.getByRole("heading", { name: /recording storage/i })).toBeInTheDocument();
    expect(screen.getByText(/isn't available on this droplet yet/i)).toBeInTheDocument();
    // Nothing interactive: no switch, no picker, no table.
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("an unrecognised status renders neutrally instead of crashing", () => {
    setup(makeRecording({ status: "unknown" }));
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /recording storage/i })).toBeInTheDocument();
  });

  it("renders nothing at all for a role that may not read it", () => {
    setup(null, { state: "forbidden" });
    expect(screen.queryByTestId("recording-storage-card")).not.toBeInTheDocument();
  });
});

describe("RecordingStorageCard — cached data after a failed refresh", () => {
  it("labels cached facts, pauses writes, and re-enables them after a successful retry", async () => {
    const recording = makeRecording({
      oldFootage: { present: true, bytes: 12 * GIB, location: "system_disk" },
      eligibleDrives: [
        { fsUuid: "fs-2", label: "Bay 3", sizeBytes: 2000 * GIB, freeBytes: 1900 * GIB, encrypted: true },
      ],
    });
    const { rerender } = setup(recording, { stale: true });

    expect(screen.getByTestId("recording-storage-stale")).toHaveTextContent(/last known storage details/i);
    expect(screen.getByRole("heading", { name: /recording storage/i })).toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.queryByRole("combobox", { name: /move recordings to/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete old recordings from system drive/i })).not.toBeInTheDocument();

    refresh.mockImplementationOnce(async () => {
      hook.value = { state: "ready", recording, stale: false, refresh } satisfies UseRecordingStorage;
    });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => {
      rerender(<RecordingStorageCard />);
      expect(screen.queryByTestId("recording-storage-stale")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: /move recordings to/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete old recordings from system drive/i })).toBeInTheDocument();
  });
});

describe("RecordingStorageCard — no eligible drive", () => {
  const noDrive = () =>
    makeRecording({
      status: "no_eligible_drive",
      mode: null,
      drive: null,
      reservedBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      cameras: [],
    });
  const noDriveWithUnknownRetention = () =>
    makeRecording({ ...noDrive(), retentionKnown: false, retentionDays: 0, needBytes: 0 });

  it("explains it and links to Settings → Storage", () => {
    setup(noDrive());
    expect(screen.getByText(/no drive is ready for camera recordings/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open storage/i });
    expect(link).toHaveAttribute("href", "/settings/storage");
    expect(screen.getByText("No drive yet")).toBeInTheDocument();
  });

  it("does not print a fallback retention estimate while recording retention is unavailable", () => {
    setup(noDriveWithUnknownRetention());
    expect(screen.getByText(/recording space estimate unavailable while waiting for recording retention/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/7 days|0 days|need/i);
  });

  it("keeps AUTO_RESERVED moves disabled for unknown retention while allowing FULL moves", () => {
    const candidate = { fsUuid: "fs-2", label: "Bay 3", sizeBytes: 200 * GIB, freeBytes: 180 * GIB, encrypted: true };
    setup(makeRecording({ retentionKnown: false, retentionDays: 0, mode: "auto_reserved", eligibleDrives: [candidate] }));
    expect(screen.getByRole("radio", { name: /auto-sized/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: /move recordings to/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /use this drive/i })).toBeDisabled();

    cleanup();
    setup(makeRecording({ retentionKnown: false, retentionDays: 0, mode: null, eligibleDrives: [candidate] }));
    expect(screen.getByRole("combobox", { name: /move recordings to/i })).toBeDisabled();

    cleanup();
    setup(makeRecording({ retentionKnown: false, retentionDays: 0, mode: "full", eligibleDrives: [candidate] }));
    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeChecked();
    expect(screen.getByRole("combobox", { name: /move recordings to/i })).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: /move recordings to/i }), { target: { value: "fs-2" } });
    expect(screen.getByRole("button", { name: /use this drive/i })).toBeEnabled();
  });

  it("closes an AUTO_RESERVED confirmation if retention becomes unknown before confirmation", async () => {
    const view = setup(makeRecording({ mode: "full" }));
    fireEvent.click(screen.getByRole("radio", { name: /auto-sized/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/up to 7 days/i);

    hook.value = {
      state: "ready",
      recording: makeRecording({ mode: "full", retentionKnown: false, retentionDays: 0, needBytes: 0 }),
      stale: false,
      refresh,
    } satisfies UseRecordingStorage;
    view.rerender(<RecordingStorageCard />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeEnabled();
  });

  it("shows no mode switch, bar or table (there is nothing to size yet)", () => {
    setup(noDrive());
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("RecordingStorageCard — pending and migrating", () => {
  it("a missing-drive headline never unlocks a move that is still running", () => {
    setup(makeRecording({
      status: "missing",
      warnings: [{ code: "drive_missing", message: "" }, { code: "near_full", message: "" }],
      migration: { state: "running", progressPct: 50, bytesCopied: 6 * GIB, bytesTotal: 12 * GIB, startedAt: null, error: null },
      oldFootage: { present: true, bytes: 12 * GIB, location: "system_disk" },
      eligibleDrives: [
        { fsUuid: "fs-2", label: "Bay 3", sizeBytes: 2000 * GIB, freeBytes: 1900 * GIB, encrypted: true },
      ],
    }));
    expect(screen.getByText("Drive missing")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /moving recordings/i })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.queryByRole("combobox", { name: /move recordings to/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete old recordings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use the whole drive/i })).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it.each(["pending", "migrating"] as const)("a near-full warning cannot bypass locked %s controls", (status) => {
    setup(makeRecording({ status, warnings: [{ code: "near_full", message: "" }] }));
    expect(screen.getByTestId("recording-warning-near_full")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use the whole drive/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("pending: says it is being set up on the named drive", () => {
    setup(makeRecording({ status: "pending", mode: "auto_reserved" }));
    expect(screen.getByText("Setting up")).toBeInTheDocument();
    expect(screen.getByText(/setting up recording storage on bay 2/i)).toBeInTheDocument();
  });

  it("migrating: shows an accessible progress bar with the percentage and the bytes copied", () => {
    setup(
      makeRecording({
        status: "migrating",
        migration: {
          state: "running",
          progressPct: 42,
          bytesCopied: 21 * GIB,
          bytesTotal: 50 * GIB,
          startedAt: "2026-10-03T10:00:00Z",
          error: null,
        },
      }),
    );
    const bar = screen.getByRole("progressbar", { name: /moving recordings/i });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    const block = screen.getByTestId("recording-migration");
    expect(block).toHaveTextContent("42%");
    expect(block).toHaveTextContent(/21\.0 GiB of 50\.0 GiB/);
    expect(block).toHaveTextContent(/cameras keep recording/i);
  });

  it("migrating: locks the mode switch and the drive picker until the move ends", () => {
    setup(
      makeRecording({
        status: "migrating",
        migration: { state: "running", progressPct: 10, bytesCopied: 1, bytesTotal: 10, startedAt: null, error: null },
        eligibleDrives: [
          { fsUuid: "fs-2", label: "Bay 3", sizeBytes: 2000 * GIB, freeBytes: 1900 * GIB, encrypted: true },
        ],
      }),
    );
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.queryByRole("button", { name: /use this drive/i })).not.toBeInTheDocument();
  });

  it("a failed move says so calmly and that nothing was lost — without the raw error", () => {
    setup(
      makeRecording({
        migration: {
          state: "failed",
          progressPct: 12,
          bytesCopied: 1,
          bytesTotal: 10,
          startedAt: null,
          error: "rsync exited 23 at /dev/sdb1",
        },
      }),
    );
    const block = screen.getByTestId("recording-migration");
    expect(block).toHaveTextContent(/didn't finish/i);
    expect(block).toHaveTextContent(/nothing was lost/i);
    expect(document.body.textContent).not.toMatch(/rsync|sdb1/);
  });
});

describe("RecordingStorageCard — active, auto-sized", () => {
  it("names the drive, says it is encrypted, and shows the status", () => {
    setup(makeRecording());
    expect(screen.getByRole("heading", { name: /recording storage/i })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    const row = screen.getByTestId("recording-drive");
    expect(row).toHaveTextContent("Bay 2");
    expect(row).toHaveTextContent(/encrypted/i);
    // Never the mount path or an fs UUID (home-user persona).
    expect(document.body.textContent).not.toMatch(/\/mnt\/droplet|fs-1/);
  });

  it("flags a recording drive that is NOT encrypted", () => {
    setup(
      makeRecording({
        drive: {
          fsUuid: "fs-1",
          label: "Bay 2",
          model: "",
          sizeBytes: 100 * GIB,
          encrypted: false,
          mountPath: "",
        },
      }),
    );
    expect(screen.getByTestId("recording-drive")).toHaveTextContent(/not encrypted/i);
  });

  it("falls back to the model, then a generic, when the drive has no label", () => {
    setup(
      makeRecording({
        drive: { fsUuid: "fs-1", label: "", model: "WD Red", sizeBytes: 1, encrypted: true, mountPath: "" },
      }),
    );
    expect(screen.getByTestId("recording-drive")).toHaveTextContent("WD Red");
  });

  it("marks Auto-sized as the current mode in a labelled radio group", () => {
    setup(makeRecording());
    const group = screen.getByRole("radiogroup", { name: /recording space/i });
    expect(within(group).getByRole("radio", { name: /auto-sized/i })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /whole drive/i })).not.toBeChecked();
  });

  it("shows reserved / used / free as an accessible meter", () => {
    setup(makeRecording());
    const meter = screen.getByRole("meter", { name: /recording space used/i });
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", String(120 * GIB));
    expect(meter).toHaveAttribute("aria-valuenow", String(40 * GIB));
    expect(meter.getAttribute("aria-valuetext")).toMatch(/40\.0 GiB used of 120 GiB/);
    const legend = screen.getByTestId("recording-space-legend");
    expect(legend).toHaveTextContent("40.0 GiB used");
    expect(legend).toHaveTextContent("80.0 GiB free");
    expect(legend).toHaveTextContent("120 GiB set aside");
  });

  it("states retention, days stored and the computed need", () => {
    setup(makeRecording());
    const facts = screen.getByTestId("recording-facts");
    expect(facts).toHaveTextContent(/storage sized for up to 7 days/i);
    expect(facts).toHaveTextContent(/3\.4 days stored so far/i);
    expect(facts).toHaveTextContent(/needs about 96\.0 GiB/i);
  });

  it("labels unknown retention estimates unavailable and keeps measured storage facts", () => {
    const normalized = normalizeRecordingStorage({ ...makeRecording(), retentionKnown: false });
    expect(normalized).not.toBeNull();
    setup(normalized!);
    const facts = screen.getByTestId("recording-facts");
    expect(facts).toHaveTextContent("Recording space estimate unavailable");
    expect(facts).toHaveTextContent(/waiting for recording retention settings/i);
    expect(facts).toHaveTextContent(/3\.4 days stored so far/i);
    expect(facts).not.toHaveTextContent(/keeping 0 days|needs about/i);
    const table = screen.getByRole("table", { name: /recording needs by camera/i });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toContain("Need unavailable");
    expect(screen.getByTestId("recording-camera-front_door")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("recording-camera-front_door")).not.toHaveTextContent("0 B");
    expect(screen.getByTestId("recording-camera-front_door")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("recording-camera-front_door")).not.toHaveTextContent("0%");
    expect(screen.getByTestId("recording-space-legend")).toHaveTextContent("40.0 GiB used");
  });

  it("says 'under a day' rather than '0.0 days' for fresh footage", () => {
    setup(makeRecording({ daysStored: 0.2 }));
    expect(screen.getByTestId("recording-facts")).toHaveTextContent(/under a day stored so far/i);
  });

  it("renders the per-camera table: MB/h, GB/day, N-day need and share", () => {
    setup(makeRecording());
    const table = screen.getByRole("table", { name: /recording needs by camera/i });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Camera", "MB/h", "GB/day", "Recording space needed", "Share"]);

    const front = screen.getByTestId("recording-camera-front_door");
    expect(front).toHaveTextContent("Front door");
    expect(front).toHaveTextContent("1500");
    expect(front).toHaveTextContent("36");
    expect(front).toHaveTextContent("75.0 GiB");
    expect(front).toHaveTextContent("75%");
    const garage = screen.getByTestId("recording-camera-garage");
    expect(garage).toHaveTextContent("25%");
  });

  it("does not label every camera need with the global longest retention", () => {
    setup(makeRecording({ retentionDays: 14 }));
    expect(screen.getByRole("columnheader", { name: "Recording space needed" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "14-day need" })).not.toBeInTheDocument();
  });

  it("says so when no camera has been measured yet", () => {
    setup(makeRecording({ cameras: [] }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/once a camera is recording/i)).toBeInTheDocument();
  });

  it("never prints NaN or Infinity, whatever the payload carries", () => {
    setup(makeRecording({ reservedBytes: 0, usedBytes: 0, freeBytes: 0, needBytes: 0, cameras: [] }));
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe("RecordingStorageCard — active, whole drive", () => {
  const full = () =>
    makeRecording({
      mode: "full",
      reservedBytes: 4000 * GIB,
      usedBytes: 1000 * GIB,
      freeBytes: 3000 * GIB,
    });

  it("marks Whole drive as current", () => {
    setup(full());
    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /auto-sized/i })).not.toBeChecked();
  });

  it("labels the bar as the whole drive, not as a reservation", () => {
    setup(full());
    expect(screen.getByTestId("recording-space-legend")).toHaveTextContent(/whole drive/i);
  });
});

describe("RecordingStorageCard — switching mode is a tier-2 confirm", () => {
  it("opens a confirm that names the consequence and carries the Write chip — and applies nothing yet", () => {
    setup(makeRecording());
    fireEvent.click(screen.getByRole("radio", { name: /whole drive/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /use the whole drive for recordings/i })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/no longer show up in files/i);
    expect(dialog).toHaveTextContent(/write · confirm to apply/i);
    expect(updateMock).not.toHaveBeenCalled();
    // The radios are controlled by the server's mode, so nothing flipped.
    expect(screen.getByRole("radio", { name: /auto-sized/i })).toBeChecked();
  });

  it("Cancel leaves everything as it was", async () => {
    setup(makeRecording());
    fireEvent.click(screen.getByRole("radio", { name: /whole drive/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /auto-sized/i })).toBeChecked();
  });

  it("Confirm applies it once, refreshes, and tells the owner", async () => {
    updateMock.mockResolvedValueOnce(undefined);
    setup(makeRecording());
    fireEvent.click(screen.getByRole("radio", { name: /whole drive/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /use whole drive/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith({ mode: "full" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/whole drive/i), "success");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("going back to auto-sized asks first too", async () => {
    updateMock.mockResolvedValueOnce(undefined);
    setup(makeRecording({ mode: "full", reservedBytes: 4000 * GIB }));
    fireEvent.click(screen.getByRole("radio", { name: /auto-sized/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /go back to auto-sized/i })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/never deleted early/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /switch to auto-sized/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ mode: "auto_reserved" }));
  });

  it("a refusal keeps the confirm open and speaks calmly — never the raw server text", async () => {
    updateMock.mockRejectedValueOnce(Object.assign(new Error("EBUSY /dev/sdb1"), { status: 409 }));
    setup(makeRecording());
    fireEvent.click(screen.getByRole("radio", { name: /whole drive/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /use whole drive/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/right now|already|moving/i), "error");
    expect(toastMock.mock.calls[0]![0]).not.toMatch(/sdb1|EBUSY/);
    // Still open, so the owner can retry or back out.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("RecordingStorageCard — roles", () => {
  it("an admin can change mode", () => {
    setup(makeRecording(), { role: "admin" });
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeEnabled();
  });
});

describe("RecordingStorageCard — warnings, each with its fix", () => {
  const withWarning = (code: string, extra: Partial<RecordingStorage> = {}) =>
    makeRecording({ warnings: [{ code, message: "" }], ...extra });

  it("near_full (auto-sized): offers the whole drive, and the fix opens the same confirm", () => {
    setup(withWarning("near_full", { status: "degraded" }));
    const warning = screen.getByTestId("recording-warning-near_full");
    expect(warning).toHaveTextContent(/nearly full/i);
    fireEvent.click(within(warning).getByRole("button", { name: /use the whole drive/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/use the whole drive for recordings/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("near_full (already whole drive): points at Storage instead — there is no bigger share", () => {
    setup(withWarning("near_full", { status: "degraded", mode: "full", reservedBytes: 4000 * GIB }));
    const warning = screen.getByTestId("recording-warning-near_full");
    expect(within(warning).queryByRole("button", { name: /use the whole drive/i })).not.toBeInTheDocument();
    expect(within(warning).getByRole("link", { name: /open storage/i })).toHaveAttribute(
      "href",
      "/settings/storage",
    );
  });

  it("a read-only drive disables mode changes and sends the near-full fix to Storage", () => {
    setup(
      makeRecording({
        status: "degraded",
        warnings: [
          { code: "read_only", message: "" },
          { code: "near_full", message: "" },
        ],
      }),
    );
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByText(/mode changes are unavailable while the recording drive is read-only/i)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("recording-warning-near_full")).getByRole("link", { name: /open storage/i }),
    ).toHaveAttribute("href", "/settings/storage");
    expect(
      within(screen.getByTestId("recording-warning-near_full")).queryByRole("button", { name: /use the whole drive/i }),
    ).not.toBeInTheDocument();
  });

  it("cannot_grow: says the reservation cannot grow, fix = Storage", () => {
    setup(withWarning("cannot_grow", { status: "degraded" }));
    const warning = screen.getByTestId("recording-warning-cannot_grow");
    expect(warning).toHaveTextContent(/can't grow/i);
    expect(within(warning).getByRole("link", { name: /open storage/i })).toBeInTheDocument();
  });

  it.each([
    ["drive_missing", /recording drive not found/i],
    ["read_only", /read-only/i],
    ["smart_failed", /health problems/i],
    ["not_encrypted", /isn't encrypted/i],
  ])("%s: names the problem and links to Storage", (code, title) => {
    setup(withWarning(code, { status: "degraded" }));
    const warning = screen.getByTestId(`recording-warning-${code}`);
    expect(warning).toHaveTextContent(title);
    expect(within(warning).getByRole("link", { name: /open storage/i })).toHaveAttribute(
      "href",
      "/settings/storage",
    );
  });

  it("on_system_disk: says recordings are on the system drive; with an eligible drive the fix focuses the picker", () => {
    setup(
      makeRecording({
        status: "on_system_disk",
        mode: null,
        drive: null,
        reservedBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        warnings: [{ code: "on_system_disk", message: "" }],
        eligibleDrives: [
          { fsUuid: "fs-2", label: "Bay 3", sizeBytes: 2000 * GIB, freeBytes: 1900 * GIB, encrypted: true },
        ],
      }),
    );
    expect(screen.getByText("On the system drive")).toBeInTheDocument();
    const warning = screen.getByTestId("recording-warning-on_system_disk");
    expect(warning).toHaveTextContent(/system drive/i);
    fireEvent.click(within(warning).getByRole("button", { name: /choose a recording drive/i }));
    expect(screen.getByRole("combobox", { name: /move recordings to/i })).toHaveFocus();
  });

  it("on_system_disk with nothing eligible: the fix is Storage", () => {
    setup(
      makeRecording({
        status: "on_system_disk",
        mode: null,
        drive: null,
        warnings: [{ code: "on_system_disk", message: "" }],
      }),
    );
    const warning = screen.getByTestId("recording-warning-on_system_disk");
    expect(within(warning).getByRole("link", { name: /open storage/i })).toBeInTheDocument();
  });

  it("an unknown warning code still renders, with the server's own sentence and no fix", () => {
    setup(makeRecording({ warnings: [{ code: "fan_failed", message: "Fan 2 stopped." }] }));
    const warning = screen.getByTestId("recording-warning-fan_failed");
    expect(warning).toHaveTextContent("Fan 2 stopped.");
    expect(within(warning).queryByRole("link")).not.toBeInTheDocument();
    expect(within(warning).queryByRole("button")).not.toBeInTheDocument();
  });

  it("danger warnings are announced (role=alert); mild ones are not", () => {
    setup(
      makeRecording({
        warnings: [
          { code: "drive_missing", message: "" },
          { code: "near_full", message: "" },
        ],
      }),
    );
    expect(within(screen.getByTestId("recording-warning-drive_missing")).getByRole("alert")).toBeInTheDocument();
    expect(within(screen.getByTestId("recording-warning-near_full")).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("RecordingStorageCard — missing drive", () => {
  it("says the drive is missing and shows the warning, without stale controls", () => {
    setup(
      makeRecording({
        status: "missing",
        warnings: [{ code: "drive_missing", message: "" }],
      }),
    );
    expect(screen.getByText("Drive missing")).toBeInTheDocument();
    expect(screen.getByTestId("recording-warning-drive_missing")).toBeInTheDocument();
    // Stale numbers about a drive that is not there are not shown as if current.
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});

describe("RecordingStorageCard — choosing a different drive (tier 2)", () => {
  const withEligible = (extra: Partial<RecordingStorage> = {}) =>
    makeRecording({
      eligibleDrives: [
        { fsUuid: "fs-1", label: "Bay 2", sizeBytes: 4000 * GIB, freeBytes: 3000 * GIB, encrypted: true },
        { fsUuid: "fs-2", label: "Bay 3", sizeBytes: 2000 * GIB, freeBytes: 1900 * GIB, encrypted: true },
      ],
      ...extra,
    });

  it("offers only the OTHER eligible drives", () => {
    setup(withEligible());
    const select = screen.getByRole("combobox", { name: /move recordings to/i });
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options.some((o) => /bay 3/i.test(o ?? ""))).toBe(true);
    expect(options.some((o) => /bay 2/i.test(o ?? ""))).toBe(false);
  });

  it("is not offered when there is nothing else to choose", () => {
    setup(makeRecording());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("does not offer an unencrypted or too-small drive", () => {
    setup(
      makeRecording({
        eligibleDrives: [
          { fsUuid: "plain-1", label: "Plain disk", sizeBytes: 2000 * GIB, freeBytes: 1900 * GIB, encrypted: false },
          { fsUuid: "small-1", label: "Small disk", sizeBytes: 10 * GIB, freeBytes: 10 * GIB, encrypted: true },
        ],
      }),
    );
    expect(screen.queryByRole("combobox", { name: /move recordings to/i })).not.toBeInTheDocument();
  });

  it("'Use this drive' stays disabled until one is chosen", () => {
    setup(withEligible());
    expect(screen.getByRole("button", { name: /use this drive/i })).toBeDisabled();
  });

  it("confirms the move, then PUTs the chosen fsUuid", async () => {
    updateMock.mockResolvedValueOnce(undefined);
    setup(withEligible());
    fireEvent.change(screen.getByRole("combobox", { name: /move recordings to/i }), {
      target: { value: "fs-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /use this drive/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /move recordings to bay 3/i })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/write · confirm to apply/i);
    expect(updateMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /^move recordings$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith({ fsUuid: "fs-2" }));
  });

  it("is not offered to a family member", () => {
    setup(withEligible(), { role: "family" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("RecordingStorageCard — old footage on the system drive (tier 3)", () => {
  const withOld = (extra: Partial<RecordingStorage> = {}) =>
    makeRecording({
      oldFootage: { present: true, bytes: 12 * GIB, location: "system_disk" },
      migration: { state: "done", progressPct: 100, bytesCopied: 12 * GIB, bytesTotal: 12 * GIB, startedAt: null, error: null },
      ...extra,
    });

  it("says how much is left behind and offers the delete to the owner", () => {
    setup(withOld());
    const block = screen.getByTestId("recording-old-footage");
    expect(block).toHaveTextContent(/12\.0 GiB/);
    expect(block).toHaveTextContent(/still on the system drive/i);
    expect(within(block).getByRole("button", { name: /delete old recordings from system drive/i })).toBeInTheDocument();
  });

  it("is absent when there is nothing old", () => {
    setup(makeRecording());
    expect(screen.queryByTestId("recording-old-footage")).not.toBeInTheDocument();
  });

  it("an admin is told to ask the owner (the delete is owner-only)", () => {
    setup(withOld(), { role: "admin" });
    const block = screen.getByTestId("recording-old-footage");
    expect(within(block).queryByRole("button")).not.toBeInTheDocument();
    expect(block).toHaveTextContent(/ask the owner/i);
  });

  it("while the move is still running it says to wait, with no button", () => {
    setup(
      withOld({
        status: "migrating",
        migration: { state: "running", progressPct: 50, bytesCopied: 6 * GIB, bytesTotal: 12 * GIB, startedAt: null, error: null },
      }),
    );
    const block = screen.getByTestId("recording-old-footage");
    expect(within(block).queryByRole("button")).not.toBeInTheDocument();
    expect(block).toHaveTextContent(/once the move finishes/i);
  });

  it("needs the phrase typed before the destructive button unlocks, and deletes nothing until then", async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    setup(withOld());
    fireEvent.click(screen.getByRole("button", { name: /delete old recordings from system drive/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /delete the old recordings/i })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/can't be undone/i);
    // The new drive's recordings are explicitly safe.
    expect(dialog).toHaveTextContent(/bay 2/i);

    const confirm = within(dialog).getByRole("button", { name: /^delete old recordings$/i });
    expect(confirm).toBeDisabled();
    expect(deleteMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "delete old recordings" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/old recordings deleted/i), "success");
  });

  it("a refusal keeps the dialog open with calm copy (no raw error)", async () => {
    deleteMock.mockRejectedValueOnce(Object.assign(new Error("EBUSY /var/lib/docker"), { status: 409 }));
    setup(withOld());
    fireEvent.click(screen.getByRole("button", { name: /delete old recordings from system drive/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "delete old recordings" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete old recordings$/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/move to the new drive has finished/i);
    expect(document.body.textContent).not.toMatch(/EBUSY|\/var\/lib/);
  });
});

describe("RecordingStorageCard — accessibility", () => {
  it("is a labelled region whose heading is the card's name", () => {
    setup(makeRecording());
    const card = screen.getByTestId("recording-storage-card");
    const labelledBy = card.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelledBy)).toHaveTextContent(/recording storage/i);
  });

  it("every control carries an accessible name", () => {
    setup(
      makeRecording({
        eligibleDrives: [
          { fsUuid: "fs-3", label: "Bay 3", sizeBytes: 2000 * GIB, freeBytes: 1900 * GIB, encrypted: true },
        ],
        warnings: [{ code: "near_full", message: "" }],
        oldFootage: { present: true, bytes: 1, location: "system_disk" },
      }),
    );
    for (const control of screen.getAllByRole("button")) {
      expect(control).toHaveAccessibleName();
    }
    for (const control of screen.getAllByRole("combobox")) {
      expect(control).toHaveAccessibleName();
    }
  });
});

describe("RecordingStorageCard — a family account never sees it (403 on the route)", () => {
  it("renders nothing for a family account, even if data were somehow supplied", () => {
    setup(makeRecording(), { role: "family" });
    expect(screen.queryByTestId("recording-storage-card")).not.toBeInTheDocument();
  });

  it("does not even ask: the hook is disabled for roles that would get a 403", () => {
    setup(makeRecording(), { role: "family" });
    expect(hook.args[0]).toEqual({ enabled: false });
    cleanup();
    setup(makeRecording(), { role: "guest" });
    expect(hook.args[0]).toEqual({ enabled: false });
    cleanup();
    setup(makeRecording(), { role: "owner" });
    expect(hook.args[0]).toEqual({ enabled: true });
    cleanup();
    setup(makeRecording(), { role: "admin" });
    expect(hook.args[0]).toEqual({ enabled: true });
  });
});

describe("RecordingStorageCard — status precedence: missing > migrating > degraded > on_system_disk > pending > active > no_eligible_drive", () => {
  const running = {
    state: "running" as const,
    progressPct: 40,
    bytesCopied: 4 * GIB,
    bytesTotal: 10 * GIB,
    startedAt: null,
    error: null,
  };

  it("a drive_missing warning beats an 'active' status: the headline is Drive missing and stale numbers are not shown", () => {
    setup(makeRecording({ status: "active", warnings: [{ code: "drive_missing", message: "" }] }));
    expect(screen.getByText("Drive missing")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("a running move beats 'pending' and 'degraded'", () => {
    setup(makeRecording({ status: "pending", migration: running }));
    expect(screen.getByText("Moving recordings")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /moving recordings/i })).toBeInTheDocument();
    cleanup();
    setup(makeRecording({ status: "degraded", migration: running }));
    expect(screen.getByText("Moving recordings")).toBeInTheDocument();
  });

  it("a failing drive beats 'active': Needs attention", () => {
    setup(makeRecording({ status: "active", warnings: [{ code: "smart_failed", message: "" }] }));
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("recordings on the system drive beat 'pending'", () => {
    setup(
      makeRecording({
        status: "pending",
        mode: null,
        drive: null,
        warnings: [{ code: "on_system_disk", message: "" }],
      }),
    );
    expect(screen.getByText("On the system drive")).toBeInTheDocument();
  });

  it("near-full alone does not change the headline", () => {
    setup(makeRecording({ status: "active", warnings: [{ code: "near_full", message: "" }] }));
    expect(screen.getByText("Active")).toBeInTheDocument();
  });
});

describe("RecordingStorageCard — a move that did not finish", () => {
  const failed = () =>
    makeRecording({
      migration: {
        state: "failed",
        progressPct: 12,
        bytesCopied: 1,
        bytesTotal: 10,
        startedAt: null,
        error: "rsync exited 23 at /dev/sdb1",
      },
    });

  it("says nothing was lost and cameras are still recording where they were", () => {
    setup(failed());
    const block = screen.getByTestId("recording-migration");
    expect(block).toHaveTextContent(/still recording (to|where)/i);
    expect(block).toHaveTextContent(/nothing was lost/i);
  });

  it("names the automatic retry schedule — 1 hour, then 6, then 24 — and that you will be told", () => {
    setup(failed());
    const block = screen.getByTestId("recording-migration");
    expect(block).toHaveTextContent(/1 hour/i);
    expect(block).toHaveTextContent(/6 hours/i);
    expect(block).toHaveTextContent(/24 hours/i);
    expect(block).toHaveTextContent(/tells you if it still can't finish/i);
  });

  it("is announced to assistive tech", () => {
    setup(failed());
    expect(screen.getByTestId("recording-migration")).toHaveAttribute("role", "alert");
  });
});

describe("RecordingStorageCard — Whole drive removes the drive from Files, and is refused while files/ is not empty", () => {
  const filesRefusal = () =>
    Object.assign(new Error("files/ is not empty"), { status: 409, code: "files_not_empty" });

  async function tryWholeDrive() {
    fireEvent.click(screen.getByRole("radio", { name: /whole drive/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /use whole drive/i }));
  }

  it("says in the option itself that the drive is removed from Files", () => {
    setup(makeRecording());
    expect(screen.getByRole("radio", { name: /whole drive/i })).toHaveAccessibleName(/removed from files/i);
  });

  it("says it again in the confirm, before anything is applied", () => {
    setup(makeRecording());
    fireEvent.click(screen.getByRole("radio", { name: /whole drive/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/no longer show up in Files/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("when the box refuses because the drive still holds files: says why, closes the confirm, and locks the option with the reason", async () => {
    updateMock.mockRejectedValueOnce(filesRefusal());
    setup(makeRecording());
    await tryWholeDrive();

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/holds no files/i), "error"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /auto-sized/i })).toBeChecked();
    expect(screen.getByTestId("whole-drive-blocked")).toHaveTextContent(/no files on it/i);
    expect(screen.getByTestId("whole-drive-blocked")).toHaveTextContent(/move your files off/i);
  });

  it("'Check again' lifts the lock so the owner can retry once the files are gone", async () => {
    updateMock.mockRejectedValueOnce(filesRefusal());
    setup(makeRecording());
    await tryWholeDrive();
    await screen.findByTestId("whole-drive-blocked");

    fireEvent.click(screen.getByRole("button", { name: /check again/i }));

    expect(screen.queryByTestId("whole-drive-blocked")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeEnabled();
  });

  it("any OTHER 409 (a move already running) is not mistaken for the files refusal", async () => {
    updateMock.mockRejectedValueOnce(Object.assign(new Error("migration running"), { status: 409 }));
    setup(makeRecording());
    await tryWholeDrive();
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0]![0]).toMatch(/right now|already|moving/i);
    expect(screen.queryByTestId("whole-drive-blocked")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /whole drive/i })).toBeEnabled();
  });

  it("the lock belongs to the drive it was learned on", () => {
    // A different recording drive starts unlocked (state is keyed by fsUuid, not
    // remembered for the page).
    updateMock.mockRejectedValueOnce(filesRefusal());
    const { rerender } = setup(makeRecording());
    fireEvent.click(screen.getByRole("radio", { name: /whole drive/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /use whole drive/i }));
    return waitFor(() => expect(screen.getByRole("radio", { name: /whole drive/i })).toBeDisabled()).then(() => {
      hook.value = {
        state: "ready",
        refresh,
        stale: false,
        recording: makeRecording({
          drive: { fsUuid: "fs-OTHER", label: "Bay 3", model: "", sizeBytes: 1000 * GIB, encrypted: true, mountPath: "" },
        }),
      } satisfies UseRecordingStorage;
      rerender(<RecordingStorageCard />);
      expect(screen.getByRole("radio", { name: /whole drive/i })).toBeEnabled();
    });
  });
});

describe("RecordingStorageCard — old recordings left on a bay drive", () => {
  const onBayDrive = () =>
    makeRecording({
      oldFootage: { present: true, bytes: 12 * GIB, location: "fs-uuid-of-the-previous-drive" },
      migration: { state: "done", progressPct: 100, bytesCopied: 12 * GIB, bytesTotal: 12 * GIB, startedAt: null, error: null },
    });

  it("says the previous recording drive, not the system drive", () => {
    setup(onBayDrive());
    const block = screen.getByTestId("recording-old-footage");
    expect(block).toHaveTextContent(/still on the previous recording drive/i);
    expect(block).not.toHaveTextContent(/system drive/i);
    expect(within(block).getByRole("button", { name: /delete old recordings from previous drive/i })).toBeInTheDocument();
  });

  it("the tier-3 confirm names that place too", async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    setup(onBayDrive());
    fireEvent.click(screen.getByRole("button", { name: /delete old recordings from previous drive/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/previous recording drive/i);
    expect(dialog).toHaveTextContent(/previous drive/i);
    expect(dialog).not.toHaveTextContent(/system drive/i);
  });
});

/**
 * jsdom never loads the stylesheet, so the colour contract is pinned the way the
 * shell's other CSS contracts are (cameras.page-rhythm.test.tsx): read the file.
 */
describe("recording-storage.css — tokens only", () => {
  const css = readFileSync(resolve(__dirname, "recording-storage.css"), "utf8");

  it("paints error text with --danger-ink — never the --danger fill token", () => {
    expect(css).toMatch(/color:\s*var\(--danger-ink\)/);
    expect(css).not.toMatch(/var\(--danger\)/);
  });

  it("carries no raw colour literals", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it("has a phone layer at the shell's 720px breakpoint that stacks the table and mode switch", () => {
    expect(css).toMatch(/@media \(max-width: 720px\)/);
    expect(css).toMatch(/\.rs-seg \{ grid-template-columns: 1fr; \}/);
    expect(css).toMatch(/\.rs-table tr \{[^}]*display: grid/);
  });

  it("keeps the table header in the accessibility tree on phones (clipped, never display:none)", () => {
    expect(css).not.toMatch(/\.rs-table thead \{[^}]*display:\s*none/);
    expect(css).toMatch(/\.rs-table thead \{[^}]*clip: rect\(0 0 0 0\)/);
  });

  it("gives phone form controls the 44px target and 16px font the shell phone layer requires", () => {
    expect(css).toMatch(/\.rs-select \{ height: 44px; font-size: 16px; \}/);
  });
});
