/**
 * WARP-174 — Storage step.
 *
 * Validates:
 *   1. Auto-skip when the bridge returns 0 drives — the customer never
 *      sees an empty form.
 *   2. Renders one card per detected drive with the FS label as a
 *      secondary hint, pre-filling existing displayName values.
 *   3. Save → PATCH /api/storage/drives/:uuid per named drive →
 *      advance to discovery.
 *   4. Skip advances without PATCHing anything.
 *   5. Duplicate names → inline error, no save.
 *
 * Same Vitest + JSDOM + assert-on-DOM-strings pattern the rest of the
 * setup tests use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeSetup: vi.fn() }),
}));

const fetchDrivesMock = vi.fn();
const updateDriveLabelMock = vi.fn();
// BUG-3 / ADR-019: the wizard must NEVER create or format a pool. We mock the
// pool-create/destroy/confirm APIs purely to assert they are never called from
// the setup flow — the owner's hard "optional, never auto" constraint.
const requestCreatePoolMock = vi.fn();
const requestDestroyPoolMock = vi.fn();
const confirmPoolCommandMock = vi.fn();

vi.mock("@/lib/api", () => ({
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "PyPortal lid display", online: true },
    supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "Verified" },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  // PR #380 — org slots after account; the Org step calls postOrg.
  postOrg: vi.fn(async () => ({
    ok: true,
    slug: "acme",
    reserved_host: "droplet.local/acme",
    next_step: "internet",
  })),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: () => fetchDrivesMock(),
  updateDriveLabel: (uuid: string, patch: unknown) =>
    updateDriveLabelMock(uuid, patch),
  // Pool APIs — present so the test can assert the wizard never touches them.
  fetchPools: vi.fn(async () => ({ pools: [], count: 0 })),
  requestCreatePool: (...a: unknown[]) => requestCreatePoolMock(...a),
  requestDestroyPool: (...a: unknown[]) => requestDestroyPoolMock(...a),
  confirmPoolCommand: (...a: unknown[]) => confirmPoolCommandMock(...a),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  fetchModels: vi.fn(async () => ({ models: [] })),
  sendChat: vi.fn(),
  fetchMatterDevices: vi.fn(async () => ({
    lights: [],
    switches: [],
    climate: [],
    sensors: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
  })),
}));

import SetupPage from "@/app/setup/page";
import { buildConfirmPhrase } from "@/components/setup/steps/StorageStep";
import { passClaimStep } from "./helpers/claim-step";
import { passOrgStep } from "./helpers/org-step";

async function advanceToStorage() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await passClaimStep();
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
    target: { value: "owner@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: "Abcdefghijk1" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "Abcdefghijk1" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // PR #380 — pass through the org step (account → org → …).
  await passOrgStep();
  // PR #375 — TwoFactor step → skip (org → twofactor → internet).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Internet step → skip to Storage.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Let StorageStep's fetchDrives effect resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const FIXTURE_DRIVES = {
  drives: [
    {
      device: "/dev/sda1",
      mount: "/mnt/droplet/data",
      label: "TOSHIBA EXT",
      uuid: "UUID-MAIN",
      size_bytes: 2_000_000_000_000,
      used_bytes: 100_000_000_000,
      free_bytes: 1_900_000_000_000,
      mounted: true,
      displayName: null,
      icon: null,
      notes: null,
    },
    {
      device: "/dev/sda2",
      mount: "/mnt/droplet/nvr",
      label: "WD ELEMENTS",
      uuid: "UUID-NVR",
      size_bytes: 1_000_000_000_000,
      used_bytes: 0,
      free_bytes: 1_000_000_000_000,
      mounted: true,
      displayName: null,
      icon: null,
      notes: null,
    },
  ],
  count: 2,
};

describe("setup Storage step (WARP-174)", () => {
  beforeEach(() => {
    fetchDrivesMock.mockReset();
    updateDriveLabelMock.mockReset();
    requestCreatePoolMock.mockReset();
    requestDestroyPoolMock.mockReset();
    confirmPoolCommandMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("auto-skips when bridge returns 0 drives", async () => {
    fetchDrivesMock.mockResolvedValue({ drives: [], count: 0 });
    render(<SetupPage />);
    await advanceToStorage();
    // Landed on Discovery — no Storage UI ever rendered.
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
    expect(updateDriveLabelMock).not.toHaveBeenCalled();
  });

  it("renders one card per detected drive with the FS label as a hint", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    expect(screen.getByText(/name your storage/i)).toBeInTheDocument();
    expect(screen.getByText(/TOSHIBA EXT/)).toBeInTheDocument();
    expect(screen.getByText(/WD ELEMENTS/)).toBeInTheDocument();
    // Two name inputs (one per drive).
    const inputs = screen.getAllByPlaceholderText(/e\.g\. wedding photos/i);
    expect(inputs).toHaveLength(2);
  });

  it("pre-fills existing displayName values", async () => {
    fetchDrivesMock.mockResolvedValue({
      drives: [
        {
          ...FIXTURE_DRIVES.drives[0],
          displayName: "Wedding Photos",
        },
      ],
      count: 1,
    });
    render(<SetupPage />);
    await advanceToStorage();

    const input = screen.getByPlaceholderText(
      /e\.g\. wedding photos/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("Wedding Photos");
  });

  it("Save and continue PATCHes each named drive then advances", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    updateDriveLabelMock.mockResolvedValue({
      uuid: "UUID-MAIN",
      displayName: "Wedding Photos",
      icon: null,
      notes: null,
      createdAt: "now",
      updatedAt: "now",
    });
    render(<SetupPage />);
    await advanceToStorage();

    const inputs = screen.getAllByPlaceholderText(/e\.g\. wedding photos/i);
    fireEvent.change(inputs[0], { target: { value: "Wedding Photos" } });
    fireEvent.change(inputs[1], { target: { value: "Camera Footage" } });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateDriveLabelMock).toHaveBeenCalledWith("UUID-MAIN", {
      displayName: "Wedding Photos",
    });
    expect(updateDriveLabelMock).toHaveBeenCalledWith("UUID-NVR", {
      displayName: "Camera Footage",
    });
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  it("Skip for now advances without calling updateDriveLabel", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    expect(updateDriveLabelMock).not.toHaveBeenCalled();
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  // ── BUG-3 / ADR-019: the owner's hard constraint, pinned at the wizard ──

  it("OPTIONAL: skipping the storage step creates no pool and formats nothing", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    // The box completed past Storage with NO pool created/formatted, and the
    // step is presented as optional (a Skip affordance exists and works).
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(confirmPoolCommandMock).not.toHaveBeenCalled();
    expect(requestDestroyPoolMock).not.toHaveBeenCalled();
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  it("OPTIONAL: even Save-and-continue (naming drives) never creates a pool", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    updateDriveLabelMock.mockResolvedValue({
      uuid: "UUID-MAIN",
      displayName: "Wedding Photos",
      icon: null,
      notes: null,
      createdAt: "now",
      updatedAt: "now",
    });
    render(<SetupPage />);
    await advanceToStorage();

    const inputs = screen.getAllByPlaceholderText(/e\.g\. wedding photos/i);
    fireEvent.change(inputs[0], { target: { value: "Wedding Photos" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Naming a drive is the ONLY storage write the wizard does — it never
    // reaches a pool-create/format path.
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(confirmPoolCommandMock).not.toHaveBeenCalled();
  });

  it("OPTIONAL: a no-drive box auto-skips storage and still creates no pool", async () => {
    fetchDrivesMock.mockResolvedValue({ drives: [], count: 0 });
    render(<SetupPage />);
    await advanceToStorage();
    // Auto-skipped to Discovery with zero storage writes of any kind.
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(updateDriveLabelMock).not.toHaveBeenCalled();
  });

  it("blocks save when two drives share a name", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    const inputs = screen.getAllByPlaceholderText(/e\.g\. wedding photos/i);
    fireEvent.change(inputs[0], { target: { value: "Drive" } });
    fireEvent.change(inputs[1], { target: { value: "Drive" } });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save and continue/i }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText(/can't share the name/i)).toBeInTheDocument();
    expect(updateDriveLabelMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// BUG-3 / ADR-019 — RAID on/off toggle + live calculator + gated create
//
// RAID is OPTIONAL and default-OFF. OFF leaves the step exactly as the
// WARP-174 naming step (covered above). These tests cover the new ON
// path: the calculator, the level chooser, and wiring a chosen level
// through #489's requestCreatePool → confirm → confirmPoolCommand flow,
// including the calm data-present refusal.
// =====================================================================
describe("setup Storage step — RAID toggle + calculator (BUG-3 / ADR-019)", () => {
  beforeEach(() => {
    fetchDrivesMock.mockReset();
    updateDriveLabelMock.mockReset();
    requestCreatePoolMock.mockReset();
    requestDestroyPoolMock.mockReset();
    confirmPoolCommandMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Find the RAID on/off switch by its accessible role. */
  function raidSwitch() {
    return screen.getByRole("switch", { name: /storage pool/i });
  }

  /** Click "Create pool" INSIDE the confirm dialog (the step footer has a
   *  same-named button, so scope to the modal). */
  function clickConfirmInDialog() {
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /^create pool$/i }),
    );
  }

  it("defaults the RAID toggle OFF — no level chooser, no create action visible", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    const toggle = raidSwitch();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    // The RAID-level chooser is hidden while OFF.
    expect(screen.queryByRole("radiogroup", { name: /raid level/i })).toBeNull();
    // The default primary is still the naming step's "Save and continue".
    expect(
      screen.getByRole("button", { name: /save and continue/i }),
    ).toBeInTheDocument();
  });

  it("OFF keeps the step skippable and creates no pool", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    // Toggle stays OFF; Skip advances to discovery with zero pool calls.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(confirmPoolCommandMock).not.toHaveBeenCalled();
  });

  it("turning the toggle ON reveals the RAID-level chooser", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(raidSwitch());
    });

    expect(raidSwitch()).toHaveAttribute("aria-checked", "true");
    const group = screen.getByRole("radiogroup", { name: /raid level/i });
    expect(group).toBeInTheDocument();
    // FIXTURE_DRIVES is 2 drives → JBOD / RAID 0 / RAID 1 selectable.
    expect(screen.getByRole("radio", { name: /JBOD/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /RAID 0/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /RAID 1 —/i })).toBeEnabled();
  });

  it("greys out RAID 5/6/10 at 2 drives with a needs-N-drives reason", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(raidSwitch());
    });

    for (const name of [/RAID 5/i, /RAID 6/i, /RAID 10/i]) {
      const radio = screen.getByRole("radio", { name });
      expect(radio).toBeDisabled();
    }
    // The plain-language "needs N+ drives" copy is shown for the unavailable
    // levels (3 for RAID 5, 4 for RAID 6/10).
    expect(screen.getByText(/needs 3\+ drives/i)).toBeInTheDocument();
    expect(screen.getAllByText(/needs 4\+ drives/i).length).toBeGreaterThan(0);
  });

  it("shows the usable capacity for the box's real 2×1.8TB shape", async () => {
    fetchDrivesMock.mockResolvedValue({
      drives: [
        {
          ...FIXTURE_DRIVES.drives[0],
          uuid: "UUID-A",
          device: "/dev/sda",
          size_bytes: 1_800_000_000_000,
        },
        {
          ...FIXTURE_DRIVES.drives[1],
          uuid: "UUID-B",
          device: "/dev/sdb",
          size_bytes: 1_800_000_000_000,
        },
      ],
      count: 2,
    });
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(raidSwitch());
    });

    // JBOD/RAID0 = 3.6 TB, RAID1 = 1.8 TB. Sizes render in the mono font.
    expect(screen.getAllByText(/3\.6 TB/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1\.8 TB/).length).toBeGreaterThan(0);
  });

  it("ON + a chosen level + confirm wires through requestCreatePool then confirmPoolCommand", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    requestCreatePoolMock.mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-123",
      service: "pool_create",
      resourceId: "md0",
      expiresIn: 60,
    });
    confirmPoolCommandMock.mockResolvedValue({ ok: true });

    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(raidSwitch());
    });
    // Pick RAID 1 (mirror).
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /RAID 1 —/i }));
    });
    // Kick off creation — this evaluates (step 1) and opens the confirm.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create pool/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // requestCreatePool got the chosen level + the real drive devices as members.
    expect(requestCreatePoolMock).toHaveBeenCalledTimes(1);
    const arg = requestCreatePoolMock.mock.calls[0][0];
    expect(arg.level).toBe("raid1");
    expect(arg.members).toEqual(
      expect.arrayContaining(["/dev/sda1", "/dev/sda2"]),
    );
    expect(arg.device).toMatch(/^md\d+$/);
    // The confirm phrase MUST name every member's short device — the host
    // script's "never run blind" gate (ADR-019 D4.3) refuses otherwise, even
    // on empty drives.
    expect(arg.confirmPhrase).toContain("sda1");
    expect(arg.confirmPhrase).toContain("sda2");

    // The confirm dialog states plainly that the drives get erased, and names
    // them with their sizes. (The blast-radius wording also appears inline in
    // the step, which is intentional — honest in both places.)
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/erase|erased|permanently/i),
    ).toBeInTheDocument();
    // The drive names + sizes appear in the dialog's verification block.
    expect(within(dialog).getByText(/TOSHIBA EXT/i)).toBeInTheDocument();

    // Confirm executes step 2.
    await act(async () => {
      clickConfirmInDialog();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(confirmPoolCommandMock).toHaveBeenCalledWith({
        confirmationToken: "tok-123",
        service: "pool_create",
        resourceId: "md0",
      }),
    );
    // On success the wizard advances to discovery.
    await waitFor(() =>
      expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a calm back-up message (not a raw error) when the drives hold data", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    requestCreatePoolMock.mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-xyz",
      service: "pool_create",
      resourceId: "md0",
      expiresIn: 60,
    });
    // #489 host pre-flight refuses a populated disk → confirmPoolCommand throws
    // with the bridge's raw 422 message. We must NOT show that raw string.
    confirmPoolCommandMock.mockRejectedValue(
      new Error("mdadm: /dev/sda1 appears to contain an ext4 filesystem"),
    );

    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(raidSwitch());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /RAID 1 —/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create pool/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      clickConfirmInDialog();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Calm, honest copy — back it up first; Droplet won't erase a drive in use.
    await waitFor(() =>
      expect(screen.getByText(/back (it|them) up/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/in use|have data|won't erase/i)).toBeInTheDocument();
    // The raw mdadm/ext4 string never reaches the screen.
    expect(screen.queryByText(/ext4 filesystem/i)).toBeNull();
    expect(screen.queryByText(/mdadm/i)).toBeNull();
    // The wizard did NOT advance — the owner stays on the storage step.
    expect(screen.queryByText(/discovering your devices/i)).toBeNull();
  });

  it("does not call requestCreatePool until the owner explicitly creates", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(raidSwitch());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /RAID 1 —/i }));
    });
    // Merely turning the toggle on and picking a level must never auto-create.
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(confirmPoolCommandMock).not.toHaveBeenCalled();
  });
});

describe("buildConfirmPhrase (ADR-019 D4.3 — host-script never-run-blind gate)", () => {
  it("names every member's short device so confirm_names() passes", () => {
    const phrase = buildConfirmPhrase(["/dev/sda1", "/dev/sda2"]);
    // The host script does a case-sensitive substring match per member.
    expect(phrase).toContain("sda1");
    expect(phrase).toContain("sda2");
  });

  it("uses the basename, not the full /dev path", () => {
    const phrase = buildConfirmPhrase(["/dev/nvme0n1", "/dev/nvme1n1"]);
    expect(phrase).toContain("nvme0n1");
    expect(phrase).toContain("nvme1n1");
  });

  it("tolerates an empty member list without throwing", () => {
    expect(buildConfirmPhrase([])).toBe("ERASE");
  });
});
