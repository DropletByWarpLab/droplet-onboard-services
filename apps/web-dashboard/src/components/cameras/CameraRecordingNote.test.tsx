/**
 * WARP-3515 — what the per-camera settings page says about where THIS camera
 * records.
 *
 * The retention sliders and the storage budget on /cameras/[name]/settings set
 * how long footage is kept; the recording drive and its size are Droplet's to
 * allocate (ADR-070). The note puts the two side by side — which drive, how much
 * this camera writes a day, what it needs for the retention window — and points
 * at the Recording storage card, where the owner's choices live. It must also
 * say nothing at all (never an error, never a placeholder) on an orchestrator
 * that does not have the endpoint yet.
 *
 * `OverAllocationNote` renders the budget route's long-standing `overAllocation`
 * advisory — the sum of the per-camera budgets against the volume that must hold
 * them — which the type never carried and nothing rendered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RecordingStorage } from "@/lib/types";
import type { UseRecordingStorage } from "@/lib/hooks/useRecordingStorage";

const hook = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("@/lib/hooks/useRecordingStorage", () => ({
  useRecordingStorage: () => hook.value,
}));

import { CameraRecordingNote, OverAllocationNote } from "./CameraRecordingNote";

const GIB = 1024 ** 3;

function makeRecording(overrides: Partial<RecordingStorage> = {}): RecordingStorage {
  return {
    status: "active",
    mode: "auto_reserved",
    drive: { fsUuid: "fs-1", label: "Bay 2", model: "", sizeBytes: 4000 * GIB, encrypted: true, mountPath: "" },
    reservedBytes: 120 * GIB,
    usedBytes: 40 * GIB,
    freeBytes: 80 * GIB,
    needBytes: 96 * GIB,
    retentionDays: 7,
    daysStored: 3,
    cameras: [
      { name: "front_door", displayName: "Front door", mbPerHour: 1500, gbPerDay: 36, needBytes: 75 * GIB, usedBytes: 20 * GIB },
      { name: "garage", displayName: "Garage", mbPerHour: 500, gbPerDay: 12, needBytes: 25 * GIB, usedBytes: 20 * GIB },
    ],
    migration: { state: "idle", progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null },
    oldFootage: { present: false, bytes: 0, location: "system_disk" },
    warnings: [],
    eligibleDrives: [],
    ...overrides,
  };
}

function setup(
  recording: RecordingStorage | null,
  state: UseRecordingStorage["state"] = recording ? "ready" : "loading",
  camera = "front_door",
  stale = false,
) {
  hook.value = { state, recording, stale, refresh: vi.fn() } satisfies UseRecordingStorage;
  return render(<CameraRecordingNote camera={camera} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CameraRecordingNote — the drive and this camera's numbers", () => {
  it("names the recording drive and the mode", () => {
    setup(makeRecording());
    const note = screen.getByRole("group", { name: /where this camera records/i });
    expect(note).toHaveTextContent("Recording drive: Bay 2");
    expect(note).toHaveTextContent(/auto-sized/i);
  });

  it("says Whole drive when recordings may use all of it", () => {
    setup(makeRecording({ mode: "full" }));
    expect(screen.getByRole("group")).toHaveTextContent(/whole drive/i);
  });

  it("shows THIS camera's GB a day and its need for the retention window", () => {
    setup(makeRecording());
    const note = screen.getByRole("group");
    expect(note).toHaveTextContent(/about 36 GB a day/i);
    expect(note).toHaveTextContent(/needs about 75\.0 GiB for 7 days/i);
  });

  it("uses the camera's own row, not another's", () => {
    setup(makeRecording(), "ready", "garage");
    const note = screen.getByRole("group");
    expect(note).toHaveTextContent(/about 12 GB a day/i);
    expect(note).not.toHaveTextContent(/36 GB/);
  });

  it("states the retention window it is sized for", () => {
    setup(makeRecording({ retentionDays: 14 }));
    expect(screen.getByRole("group")).toHaveTextContent(/for 14 days/i);
  });

  it("says it has not measured this camera yet — without inventing a number", () => {
    setup(makeRecording({ cameras: [] }));
    const note = screen.getByRole("group");
    expect(note).toHaveTextContent(/hasn't been measured yet/i);
    expect(note).toHaveTextContent("Recording drive: Bay 2");
    expect(document.body.textContent).not.toMatch(/NaN|undefined|0 GB a day/);
  });

  it("does not present cached storage facts as current after a failed refresh", () => {
    setup(makeRecording(), "ready", "front_door", true);
    expect(screen.queryByRole("group", { name: /where this camera records/i })).not.toBeInTheDocument();
  });

  it("links to the Recording storage card", () => {
    setup(makeRecording());
    const link = screen.getByRole("link", { name: /recording storage/i });
    expect(link).toHaveAttribute("href", "/cameras/system#recording-storage");
  });
});

describe("CameraRecordingNote — when there is no recording drive to name", () => {
  it("no eligible drive: says none is set up yet", () => {
    setup(makeRecording({ status: "no_eligible_drive", mode: null, drive: null, cameras: [] }));
    expect(screen.getByRole("group")).toHaveTextContent(/no recording drive is set up yet/i);
    expect(screen.getByRole("link", { name: /recording storage/i })).toBeInTheDocument();
  });

  it("on the system drive: says so", () => {
    setup(makeRecording({ status: "on_system_disk", mode: null, drive: null }));
    expect(screen.getByRole("group")).toHaveTextContent(/system drive/i);
  });

  it("missing: says the recording drive is not connected", () => {
    setup(makeRecording({ status: "missing" }));
    expect(screen.getByRole("group")).toHaveTextContent(/isn't connected/i);
  });

  it("migrating: says recordings are moving to the drive", () => {
    setup(
      makeRecording({
        status: "migrating",
        migration: { state: "running", progressPct: 30, bytesCopied: 1, bytesTotal: 3, startedAt: null, error: null },
      }),
    );
    expect(screen.getByRole("group")).toHaveTextContent(/being moved to this drive/i);
  });
});

describe("CameraRecordingNote — absence is silent", () => {
  it.each(["loading", "error", "not_supported", "forbidden"] as const)(
    "renders nothing while the state is %s",
    (state) => {
      const { container } = setup(null, state);
      expect(container).toBeEmptyDOMElement();
    },
  );
});

describe("OverAllocationNote — the budgets against the volume (WARP-1851)", () => {
  it("warns, in plain words, when the budgets add up to more than the drive holds", () => {
    render(
      <OverAllocationNote
        overAllocation={{ allocatedBytes: 3000 * GIB, capacityBytes: 2000 * GIB, overAllocated: true }}
      />,
    );
    const note = screen.getByTestId("over-allocation-warning");
    expect(note).toHaveTextContent(/add up to 2\.93 TiB/i);
    expect(note).toHaveTextContent(/drive holds 1\.95 TiB/i);
    expect(note).toHaveTextContent(/oldest footage is deleted first/i);
  });

  it.each([
    ["not over", { allocatedBytes: 500 * GIB, capacityBytes: 2000 * GIB, overAllocated: false }],
    ["unknown (null)", null],
    ["absent", undefined],
  ])("is silent when the budgets are %s", (_label, value) => {
    const { container } = render(<OverAllocationNote overAllocation={value} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("never prints NaN for a malformed advisory", () => {
    render(
      <OverAllocationNote
        overAllocation={{ allocatedBytes: Number.NaN, capacityBytes: 0, overAllocated: true }}
      />,
    );
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
  });
});
