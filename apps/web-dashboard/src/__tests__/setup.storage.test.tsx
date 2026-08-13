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
  useAuth: () => ({ completeSetup: vi.fn(), setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false } }),
}));

const fetchDrivesMock = vi.fn();
const updateDriveLabelMock = vi.fn();
// BUG-3 / ADR-019: the wizard must NEVER create or format a pool. We mock the
// pool-create/destroy/confirm APIs purely to assert they are never called from
// the setup flow — the owner's hard "optional, never auto" constraint.
const requestCreatePoolMock = vi.fn();
const requestDestroyPoolMock = vi.fn();
const confirmPoolCommandMock = vi.fn();
// WARP-662 — adopt (wipe + reformat + mount) a previously-used drive.
const requestAdoptDriveMock = vi.fn();
// WARP-1048 — reclaim a pool-member drive (detach from md, then adopt).
const reclaimDriveMock = vi.fn();
// WARP-936 — the step now queries pools so an existing array isn't silently
// ignored during setup. Default: none (the historic shape).
const fetchPoolsMock = vi.fn(
  async (..._a: unknown[]): Promise<{ pools: unknown[]; count: number }> => ({
    pools: [],
    count: 0,
  }),
);

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "Front-panel display", online: true },
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
  // WARP-979 — the reworked AddressStep imports these (skipped here).
  checkBoxName: vi.fn(async () => ({
    available: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
    authoritative: false,
  })),
  setBoxName: vi.fn(async () => ({
    ok: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
  })),
  // WARP-1039 — AddressStep rehydrates from (and the VpnStep blocked precheck
  // reads) the saved name; null = the pre-existing no-name baseline.
  fetchBoxName: vi.fn(async () => ({ name: null, fqdn: null })),
  // WARP-817 — WifiStep reads the host topology on mount to decide its
  // default disclosure state; null (best-effort) leaves the collapsed default.
  getNetworkTopology: vi.fn(async () => null),
  fetchDrives: () => fetchDrivesMock(),
  updateDriveLabel: (uuid: string, patch: unknown) =>
    updateDriveLabelMock(uuid, patch),
  // Pool APIs — present so the test can assert the wizard never touches them.
  fetchPools: (...a: unknown[]) => fetchPoolsMock(...a),
  requestCreatePool: (...a: unknown[]) => requestCreatePoolMock(...a),
  requestDestroyPool: (...a: unknown[]) => requestDestroyPoolMock(...a),
  confirmPoolCommand: (...a: unknown[]) => confirmPoolCommandMock(...a),
  requestAdoptDrive: (...a: unknown[]) => requestAdoptDriveMock(...a),
  reclaimDrive: (...a: unknown[]) => reclaimDriveMock(...a),
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
import {
  buildConfirmPhrase,
  wholeDiskName,
  friendlyAdoptError,
  groupPhysicalDisks,
} from "@/components/setup/steps/StorageStep";
import type { DriveInfo } from "@/lib/types";
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
  // PR #375 — TwoFactor step → skip (org → twofactor → wifi).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Onboarding-Flow redesign — the single Internet step is now two: Wi-Fi
  // then Address. Skip both to reach Storage. Wi-Fi has no async mount load.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  // WARP-979 — the address step (Secured / name your box) → skip.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
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
      // A SEPARATE physical disk (sdb), not a second partition of sda — two
      // real disks are what makes this a valid 2-disk pool candidate. (A disk
      // split into two partitions is one pool/reclaim target; see the
      // groupPhysicalDisks tests.)
      device: "/dev/sdb1",
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

  it("renders a visible empty state (no silent auto-skip) when 0 drives (WARP-933)", async () => {
    fetchDrivesMock.mockResolvedValue({ drives: [], count: 0 });
    render(<SetupPage />);
    await advanceToStorage();
    // WARP-933 — the Storage step is VISIBLE, not silently jumped to Discovery.
    expect(screen.getByText(/no extra drives to set up/i)).toBeInTheDocument();
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

    // #5: 2 drives default to pooling ON. Toggle it OFF to take the
    // name-the-drives-separately path (primary becomes "Save and continue").
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /storage pool/i }));
    });

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

  it("Skip for now advances without calling updateDriveLabel (single disk)", async () => {
    // #5: only a single disk (can't be pooled) keeps the Skip affordance; with
    // 2+ drives the step is non-skippable.
    fetchDrivesMock.mockResolvedValue({
      drives: [FIXTURE_DRIVES.drives[0]],
      count: 1,
    });
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    expect(updateDriveLabelMock).not.toHaveBeenCalled();
    expect(screen.getByText(/discovering your devices/i)).toBeInTheDocument();
  });

  // ── BUG-3 / ADR-019: the owner's hard constraint, pinned at the wizard ──

  it("OPTIONAL: skipping a single-disk storage step creates no pool and formats nothing", async () => {
    // #5: a single disk can't be pooled, so it stays skippable; skipping it
    // creates/formats nothing. (2+ drives are non-skippable — covered below.)
    fetchDrivesMock.mockResolvedValue({
      drives: [FIXTURE_DRIVES.drives[0]],
      count: 1,
    });
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

    // #5: toggle pooling OFF to take the name-the-drives path.
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /storage pool/i }));
    });

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

  it("OPTIONAL: a no-drive box shows the empty state and still creates no pool (WARP-933)", async () => {
    fetchDrivesMock.mockResolvedValue({ drives: [], count: 0 });
    render(<SetupPage />);
    await advanceToStorage();
    // Visible empty state — and zero storage writes of any kind.
    expect(screen.getByText(/no extra drives to set up/i)).toBeInTheDocument();
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(updateDriveLabelMock).not.toHaveBeenCalled();
  });

  it("blocks save when two drives share a name", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    // #5: toggle pooling OFF to reach the name-the-drives path.
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: /storage pool/i }));
    });

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

  it("#5: defaults the RAID toggle ON for 2+ drives — chooser shown, primary is Create pool, no Skip", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    const toggle = raidSwitch();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // The RAID-level chooser is visible by default, with a level pre-selected.
    expect(
      screen.getByRole("radiogroup", { name: /raid level/i }),
    ).toBeInTheDocument();
    // The primary action is the (gated) Create pool, and 2+ drives have NO Skip.
    expect(
      screen.getByRole("button", { name: /create pool/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /skip for now/i })).toBeNull();
  });

  it("#5: toggling the pool OFF switches to naming (Save and continue) and creates no pool", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

    // Default-on for 2 drives → toggle OFF to keep the drives separate.
    await act(async () => {
      fireEvent.click(raidSwitch());
    });
    expect(raidSwitch()).toHaveAttribute("aria-checked", "false");
    // Primary flips to the naming step; 2+ drives remain non-skippable.
    expect(
      screen.getByRole("button", { name: /save and continue/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /skip for now/i })).toBeNull();
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(confirmPoolCommandMock).not.toHaveBeenCalled();
  });

  it("#5: shows the RAID-level chooser by default for 2+ drives", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();

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
    // #5: pooling is ON by default for 2+ drives, so the chooser is already
    // shown — no toggle needed.
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
    // #5: pooling ON by default → calculator shown without a toggle.
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
    // #5: pooling ON by default. Pick RAID 1 (mirror).
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /RAID 1 —/i }));
    });
    // Kick off creation — this evaluates (step 1) and opens the confirm.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create pool/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // requestCreatePool got the chosen level + the WHOLE physical disks as
    // members. WARP-848 QA must-fix: a partition member (/dev/sda1) made the
    // host script erase only that partition while the dialog promised — and
    // the capacity options priced — the whole disk (a sibling /dev/sda2
    // survived, un-erased, re-automounting every boot). The member is the
    // backing DISK node; its teardown covers every child partition.
    expect(requestCreatePoolMock).toHaveBeenCalledTimes(1);
    const arg = requestCreatePoolMock.mock.calls[0][0];
    expect(arg.level).toBe("raid1");
    // One member per POOLABLE physical disk — the disk node itself, never a
    // partition of it (and never two partitions of the SAME disk).
    expect(arg.members).toEqual(
      expect.arrayContaining(["/dev/sda", "/dev/sdb"]),
    );
    expect(arg.members).toHaveLength(2);
    expect(arg.members).not.toContain("/dev/sda1");
    expect(arg.members).not.toContain("/dev/sdb1");
    expect(arg.device).toMatch(/^md\d+$/);
    // The confirm phrase MUST name every member's short DISK name as a whole
    // token — the host script's "never run blind" gate (ADR-019 D4.3) is an
    // exact-token match, so this pins the end-to-end phrase format.
    expect(arg.confirmPhrase).toBe("ERASE sda sdb");

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

  it("sends ONE whole-disk member per physical disk when a disk holds two filesystems", async () => {
    // The live box's exact shape (WARP-848 QA must-fix): sda carries an `nvr`
    // AND a `data` filesystem, sdb carries one. The confirm dialog lists all
    // THREE filesystems and the capacity options price the whole disks — so
    // the create request must send the two DISK nodes, not first partitions.
    fetchDrivesMock.mockResolvedValue({
      drives: [
        { ...FIXTURE_DRIVES.drives[0], device: "/dev/sda1", uuid: "A", label: "nvr" },
        { ...FIXTURE_DRIVES.drives[0], device: "/dev/sda2", uuid: "B", label: "data" },
        { ...FIXTURE_DRIVES.drives[1], device: "/dev/sdb1", uuid: "C", label: "backup" },
      ],
      count: 3,
    });
    requestCreatePoolMock.mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-848",
      service: "pool_create",
      resourceId: "md0",
      expiresIn: 60,
    });
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /RAID 1 —/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create pool/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const arg = requestCreatePoolMock.mock.calls[0][0];
    expect(arg.members).toEqual(["/dev/sda", "/dev/sdb"]);
    expect(arg.confirmPhrase).toBe("ERASE sda sdb");
    // The dialog still names EVERY filesystem the erase takes — including
    // sda's second partition, which the old partition-member request silently
    // left mounted and un-erased.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/nvr/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/data/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/backup/i)).toBeInTheDocument();
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
    // #5: pooling ON by default — pick RAID 1, then create.
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
    // #5: pooling ON by default + a level pre-selected. Re-picking a level
    // must never auto-create — only the explicit Create pool does.
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /RAID 1 —/i }));
    });
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(confirmPoolCommandMock).not.toHaveBeenCalled();
  });
});

describe("buildConfirmPhrase (ADR-019 D4.3 — host-script never-run-blind gate)", () => {
  it("names every member's short device so confirm_names() passes", () => {
    const phrase = buildConfirmPhrase(["/dev/sda1", "/dev/sda2"]);
    // The host script requires each short name as a whole TOKEN (split on
    // non-alphanumerics, case-sensitive) — WARP-848 hardening; a substring
    // match used to let `sda1` ride on a phrase naming `sda10`.
    expect(phrase).toContain("sda1");
    expect(phrase).toContain("sda2");
  });

  it("emits space-separated whole tokens the script's exact-token gate accepts", () => {
    // End-to-end phrase format pin: wizard → orchestrator (pass-through) →
    // script confirm_names(). Each member's basename must be its own token.
    expect(buildConfirmPhrase(["/dev/sda", "/dev/sdb"])).toBe("ERASE sda sdb");
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

describe("wholeDiskName helper (WARP-662)", () => {
  it("strips partition suffixes down to the whole disk", () => {
    expect(wholeDiskName("/dev/sda1")).toBe("sda");
    expect(wholeDiskName("/dev/sdb")).toBe("sdb");
    expect(wholeDiskName("/dev/nvme0n1p2")).toBe("nvme0n1");
    expect(wholeDiskName("/dev/nvme0n1")).toBe("nvme0n1");
    expect(wholeDiskName("/dev/mmcblk0p1")).toBe("mmcblk0");
  });
});

// WARP-662 — opt-in "reclaim existing drives": wipe + reformat + mount a
// previously-used disk, through the SAME owner-gated confirm-token flow as the
// pool ops. Default-OFF; the OS disk is never listed + refused server-side.
describe("setup Storage step — adopt existing drives (WARP-662)", () => {
  beforeEach(() => {
    fetchDrivesMock.mockReset();
    requestAdoptDriveMock.mockReset();
    confirmPoolCommandMock.mockReset();
    requestCreatePoolMock.mockReset();
    updateDriveLabelMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  function adoptSwitch() {
    return screen.getByRole("switch", { name: /reclaim existing drives/i });
  }

  it("defaults the adopt toggle OFF — no drive list, no adopt action", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    render(<SetupPage />);
    await advanceToStorage();
    expect(adoptSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("adopt-list")).toBeNull();
    expect(requestAdoptDriveMock).not.toHaveBeenCalled();
  });

  it("ON reveals a per-drive Erase & adopt list; confirming wipes the WHOLE disk via the gated flow", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    requestAdoptDriveMock.mockResolvedValue({
      confirmationToken: "tok-adopt",
      service: "drive_adopt",
      resourceId: "sda",
    });
    confirmPoolCommandMock.mockResolvedValue({ ok: true });
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    expect(adoptSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("adopt-list")).toBeInTheDocument();

    // Click the first drive's "Erase & adopt" → mints a token for the WHOLE
    // disk (sda, derived from /dev/sda1) — never a partition.
    const rowButtons = screen.getAllByRole("button", { name: /erase & adopt/i });
    await act(async () => {
      fireEvent.click(rowButtons[0]);
    });
    expect(requestAdoptDriveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        device: "sda",
        wipeMethod: "quick",
        confirmPhrase: "ERASE sda",
      }),
    );

    // Confirm inside the destructive dialog → executes via the shared gated confirm.
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /erase & adopt/i }));
    });
    expect(confirmPoolCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationToken: "tok-adopt",
        service: "drive_adopt",
        resourceId: "sda",
      }),
    );
  });

  it("honors the per-drive secure-erase choice", async () => {
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    requestAdoptDriveMock.mockResolvedValue({
      confirmationToken: "t",
      service: "drive_adopt",
      resourceId: "sda",
    });
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    const selects = screen.getAllByRole("combobox", { name: /wipe method/i });
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "secure" } });
    });
    const rowButtons = screen.getAllByRole("button", { name: /erase & adopt/i });
    await act(async () => {
      fireEvent.click(rowButtons[0]);
    });
    expect(requestAdoptDriveMock).toHaveBeenCalledWith(
      expect.objectContaining({ device: "sda", wipeMethod: "secure" }),
    );
  });

  it("groups two partitions of one disk into ONE reclaim row that names both folders", async () => {
    // nvr + data on the SAME physical disk (sda) — the screenshot's footgun:
    // two cards reading "sda" that, if either is adopted, wipe each other.
    fetchDrivesMock.mockResolvedValue({
      drives: [
        { ...FIXTURE_DRIVES.drives[0], device: "/dev/sda1", uuid: "A", label: "Nvr", removable: true },
        { ...FIXTURE_DRIVES.drives[0], device: "/dev/sda2", uuid: "B", label: "Data", removable: true },
      ],
      count: 2,
    });
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    // One physical disk → exactly ONE Erase & adopt button (not two), and the
    // row names every folder the wipe destroys.
    const buttons = screen.getAllByRole("button", { name: /erase & adopt/i });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText(/Nvr, Data/)).toBeInTheDocument();
  });

  it("disables reclaim on the box's installed storage and says it's in use", async () => {
    // The single-box's own data drives (bridge removable:false) — must not be
    // offered as wipe-able "foreign" drives.
    fetchDrivesMock.mockResolvedValue({
      drives: [
        { ...FIXTURE_DRIVES.drives[0], device: "/dev/sda1", uuid: "A", removable: false },
        { ...FIXTURE_DRIVES.drives[1], device: "/dev/sdb1", uuid: "B", removable: false },
      ],
      count: 2,
    });
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    // No destructive buttons for in-use disks; an honest "In use" marker shown.
    expect(screen.queryByRole("button", { name: /erase & adopt/i })).toBeNull();
    expect(screen.getAllByText(/in use/i).length).toBeGreaterThan(0);
    expect(requestAdoptDriveMock).not.toHaveBeenCalled();
  });

  it("renders a busy refusal as 'in use' — never the wrong 'system disk' message", async () => {
    // The exact bug from the screenshot: the host script's mounted-but-busy
    // refusal ("…close open files…") used to render as "system disk" because
    // the bare /os/ test matched the "os" in "close".
    fetchDrivesMock.mockResolvedValue(FIXTURE_DRIVES);
    requestAdoptDriveMock.mockResolvedValue({
      confirmationToken: "tok",
      service: "drive_adopt",
      resourceId: "sda",
    });
    confirmPoolCommandMock.mockRejectedValue(
      // WARP-848 message shape: the managed teardown names the busy
      // mountpoint. (The pre-848 "unmount of /dev/sda1 failed (busy?)"
      // wording mapped identically.)
      new Error(
        "droplet-storage-pool: refusing to adopt /dev/sda: /dev/sda1 is busy at /mnt/droplet/data-1a2b3c4d (unmount failed) — close open files and retry",
      ),
    );
    render(<SetupPage />);
    await advanceToStorage();
    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    const rowButtons = screen.getAllByRole("button", { name: /erase & adopt/i });
    await act(async () => {
      fireEvent.click(rowButtons[0]);
    });
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /erase & adopt/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByText(/in use right now/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/system disk/i)).toBeNull();
  });
});

// =====================================================================
// WARP-936 — the reclaim list now comes from the orchestrator's whole-disk
// inventory (disks field), so a present-but-UNMOUNTED disk is finally
// offered — the exact gap that made the live box's two RAID-member drives
// unreachable ("No extra drives to set up"). An existing pool is queried
// and surfaced instead of silently ignored.
// =====================================================================
describe("setup Storage step — unmounted disks + existing pool (WARP-936)", () => {
  const MD127 = {
    device: "md127",
    level: "raid1" as const,
    status: "resyncing" as const,
    members: ["sda", "sdb"],
    displayName: null,
    notes: null,
  };

  beforeEach(() => {
    fetchDrivesMock.mockReset();
    requestAdoptDriveMock.mockReset();
    reclaimDriveMock.mockReset();
    confirmPoolCommandMock.mockReset();
    requestCreatePoolMock.mockReset();
    updateDriveLabelMock.mockReset();
    fetchPoolsMock.mockReset();
    fetchPoolsMock.mockResolvedValue({ pools: [], count: 0 });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  function adoptSwitch() {
    return screen.getByRole("switch", { name: /reclaim existing drives/i });
  }

  it("offers reclaim for an unmounted foreign disk from the disks inventory", async () => {
    fetchDrivesMock.mockResolvedValue({
      drives: [],
      count: 0,
      disks: [
        { name: "sdc", size_bytes: 2_000_000_000_000, state: "foreign", fstype: "ntfs", bus: "usb", model: "Samsung T7" },
      ],
    });
    requestAdoptDriveMock.mockResolvedValue({
      confirmationToken: "tok-936",
      service: "drive_adopt",
      resourceId: "sdc",
    });
    render(<SetupPage />);
    await advanceToStorage();

    // NOT the dead-end empty state — there is a disk to act on.
    expect(screen.queryByText(/no extra drives to set up/i)).toBeNull();

    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    const btn = screen.getByRole("button", { name: /erase & adopt/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(requestAdoptDriveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        device: "sdc",
        wipeMethod: "quick",
        confirmPhrase: "ERASE sdc",
      }),
    );
  });

  it("never offers a plain adopt on a pool member (adopt would EBUSY)", async () => {
    fetchDrivesMock.mockResolvedValue({
      drives: [],
      count: 0,
      disks: [
        { name: "sda", size_bytes: 1_800_000_000_000, state: "pool_member", md: "md127", fstype: "linux_raid_member" },
        { name: "sdb", size_bytes: 1_800_000_000_000, state: "pool_member", md: "md127", fstype: "linux_raid_member" },
      ],
    });
    fetchPoolsMock.mockResolvedValue({ pools: [MD127], count: 1 });
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    // A member is reclaimed (detach-then-adopt), never adopted directly —
    // wipefs on an md-held member EBUSYs. So no "Erase & adopt", and adopt is
    // never wired for it.
    expect(screen.queryByRole("button", { name: /erase & adopt/i })).toBeNull();
    expect(requestAdoptDriveMock).not.toHaveBeenCalled();
  });

  // WARP-1048 — a pool member is no longer a dead-end: it gets a Reclaim
  // action that detaches it from the array first, then adopts it. The request
  // carries the owning md so the host script can break it out.
  it("offers Reclaim on a pool-member disk and wires the md through the gated flow", async () => {
    fetchDrivesMock.mockResolvedValue({
      drives: [],
      count: 0,
      disks: [
        { name: "sda", size_bytes: 1_800_000_000_000, state: "pool_member", md: "md127", fstype: "linux_raid_member" },
        { name: "sdb", size_bytes: 1_800_000_000_000, state: "pool_member", md: "md127", fstype: "linux_raid_member" },
      ],
    });
    fetchPoolsMock.mockResolvedValue({ pools: [MD127], count: 1 });
    reclaimDriveMock.mockResolvedValue({
      confirmationToken: "tok-reclaim",
      service: "drive_reclaim",
      resourceId: "sda",
    });
    confirmPoolCommandMock.mockResolvedValue({ ok: true });
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    // WARP-1945: the row CTA names both halves of the destructive action —
    // "Reclaim & erase", never a bare "Reclaim" (parity with the Drives page).
    const reclaimButtons = screen.getAllByRole("button", { name: /^reclaim & erase$/i });
    expect(reclaimButtons.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(reclaimButtons[0]);
    });
    expect(reclaimDriveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        device: "sda",
        md: "md127",
        confirmPhrase: "ERASE sda",
      }),
    );

    // Confirm inside the destructive dialog → executes via the shared gated confirm.
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: /reclaim/i }),
      );
    });
    expect(confirmPoolCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationToken: "tok-reclaim",
        service: "drive_reclaim",
        resourceId: "sda",
      }),
    );
    // A member is reclaimed, never plain-adopted.
    expect(requestAdoptDriveMock).not.toHaveBeenCalled();
  });

  // WARP-1945 — label/copy parity with the Drives page (WARP-1915). The row
  // CTA names BOTH halves of the destructive action — never a bare "Reclaim" —
  // and the supporting copy says up front that reclaiming erases the drive.
  it("labels the pool-member row 'Reclaim & erase' and says it erases everything (WARP-1945)", async () => {
    fetchDrivesMock.mockResolvedValue({
      drives: [],
      count: 0,
      disks: [
        { name: "sda", size_bytes: 1_800_000_000_000, state: "pool_member", md: "md127", fstype: "linux_raid_member" },
      ],
    });
    fetchPoolsMock.mockResolvedValue({ pools: [MD127], count: 1 });
    render(<SetupPage />);
    await advanceToStorage();

    await act(async () => {
      fireEvent.click(adoptSwitch());
    });
    // Both halves of the action in the label — mirrors the Drives card family.
    expect(
      screen.getByRole("button", { name: /^reclaim & erase$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reclaim$/i })).toBeNull();
    // And the supporting copy says the data goes away, before any click.
    expect(
      screen.getByText(/removes it from the pool and erases everything on it/i),
    ).toBeInTheDocument();
  });

  it("shows an existing pool during setup instead of ignoring it", async () => {
    fetchDrivesMock.mockResolvedValue({ drives: [], count: 0, disks: [] });
    fetchPoolsMock.mockResolvedValue({ pools: [MD127], count: 1 });
    render(<SetupPage />);
    await advanceToStorage();

    expect(screen.queryByText(/no extra drives to set up/i)).toBeNull();
    expect(screen.getByText(/already has a storage pool/i)).toBeInTheDocument();
    // Surfacing the pool never auto-creates or formats anything.
    expect(requestCreatePoolMock).not.toHaveBeenCalled();
    expect(confirmPoolCommandMock).not.toHaveBeenCalled();
  });

  it("keeps the honest empty state on an older stack with no disks field and no pool", async () => {
    fetchDrivesMock.mockResolvedValue({ drives: [], count: 0 });
    render(<SetupPage />);
    await advanceToStorage();
    expect(screen.getByText(/no extra drives to set up/i)).toBeInTheDocument();
  });
});

describe("groupPhysicalDisks (setup — whole-disk grouping)", () => {
  const mk = (over: Partial<DriveInfo>): DriveInfo => ({
    device: "/dev/sda1",
    mount: "/mnt/droplet/x",
    label: "",
    uuid: "u",
    size_bytes: 1_000_000_000_000,
    used_bytes: 0,
    free_bytes: 1_000_000_000_000,
    mounted: true,
    ...over,
  });

  it("collapses two partitions of one disk into a single target, summing size", () => {
    const disks = groupPhysicalDisks([
      mk({ device: "/dev/sda1", uuid: "a", size_bytes: 400_000_000_000 }),
      mk({ device: "/dev/sda2", uuid: "b", size_bytes: 1_400_000_000_000 }),
      mk({ device: "/dev/sdb1", uuid: "c", size_bytes: 1_800_000_000_000 }),
    ]);
    expect(disks.map((d) => d.disk)).toEqual(["sda", "sdb"]);
    expect(disks[0].members).toHaveLength(2);
    expect(disks[0].sizeBytes).toBe(400_000_000_000 + 1_400_000_000_000);
    expect(disks[1].members).toHaveLength(1);
  });

  it("prefers the bridge's parent_disk over deriving from the device path", () => {
    const disks = groupPhysicalDisks([
      mk({ device: "/dev/mapper/vg-root", parent_disk: "nvme0n1", uuid: "a" }),
    ]);
    expect(disks[0].disk).toBe("nvme0n1");
  });

  it("marks a disk in use when any member is installed storage (removable:false)", () => {
    const [installed] = groupPhysicalDisks([mk({ removable: false })]);
    expect(installed.inUse).toBe(true);
    const [hotplug] = groupPhysicalDisks([mk({ removable: true })]);
    expect(hotplug.inUse).toBe(false);
    // An older bridge that omits `removable` stays eligible (host script gates).
    const [unknown] = groupPhysicalDisks([mk({})]);
    expect(unknown.inUse).toBe(false);
  });
});

describe("friendlyAdoptError (WARP-662 — honest reclaim copy)", () => {
  it("renders a busy/in-use refusal as 'in use', NOT 'system disk'", () => {
    const msg = friendlyAdoptError(
      // WARP-848 message shape: the managed teardown names the busy mountpoint.
      new Error(
        "droplet-storage-pool: refusing to adopt /dev/sdb: /dev/sdb1 is busy at /mnt/droplet/data-1a2b3c4d (unmount failed) — close open files and retry",
      ),
    );
    expect(msg).toMatch(/in use/i);
    expect(msg).not.toMatch(/system disk/i);
  });

  it("renders the real OS-disk refusal as 'system disk'", () => {
    const msg = friendlyAdoptError(
      new Error(
        "droplet-storage-pool: refusing: /dev/sda is (or backs) the OS/boot/system disk — never adoptable",
      ),
    );
    expect(msg).toMatch(/system disk/i);
  });

  it("falls back to a calm generic message for anything else", () => {
    const msg = friendlyAdoptError(new Error("totally unexpected wibble"));
    expect(msg).toMatch(/couldn't reclaim/i);
    expect(msg).not.toMatch(/system disk/i);
  });
});
