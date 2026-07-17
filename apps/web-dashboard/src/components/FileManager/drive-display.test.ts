/**
 * WARP-1337 — shared customer-facing display-name chain for storage volumes.
 *
 * The Files screen's VolumesPanel used to name tiles from "label || mount-tail"
 * and never consulted displayName, so a pool mounted at
 * /mnt/droplet/<full-fs-uuid> rendered its raw GUID to the customer. ONE
 * helper now owns the chain (displayName → label → humanized mount tail) and
 * guards the fallback: a machine-generated tail (fs UUID, vfat serial,
 * "drive-<hex>"/"pool-<hex>") is NEVER rendered — the tile says "Drive" (or
 * "Storage pool" when the caller knows the volume is pool-backed) instead.
 *
 * Casing semantics deliberately mirror DrivesPanel's pre-existing driveName()
 * exactly ([-_]+ → space, then title-case each lowercase word start) —
 * WARP-832 owns any casing change, not this ticket.
 */
import { describe, it, expect } from "vitest";
import {
  driveDisplayName,
  isMachineTail,
  isPoolBackedDevice,
  sanitizeFsLabel,
} from "./drive-display";

const GUID_MOUNT = "/mnt/droplet/a0f10a84-7116-46a7-a3e3-5e00ea1c7d08";

function vol(overrides: { mount?: string; label?: string; displayName?: string | null } = {}) {
  return {
    mount: overrides.mount ?? "/mnt/droplet/photos",
    label: overrides.label ?? "",
    displayName: overrides.displayName ?? null,
  };
}

describe("driveDisplayName — chain order (WARP-1337 AC1)", () => {
  it("prefers the customer's displayName over label and mount tail", () => {
    expect(
      driveDisplayName(vol({ displayName: "Family Photos", label: "TOSHIBA EXT", mount: GUID_MOUNT })),
    ).toBe("Family Photos");
  });

  it("falls back to the FS label when no displayName exists", () => {
    expect(driveDisplayName(vol({ label: "TOSHIBA EXT", mount: GUID_MOUNT }))).toBe("TOSHIBA EXT");
  });

  it("falls back to the humanized mount tail when neither name exists", () => {
    expect(driveDisplayName(vol({ mount: "/mnt/droplet/wedding-photos" }))).toBe("Wedding Photos");
  });

  it("lets an optimistic override win over everything (DrivesPanel rename)", () => {
    expect(
      driveDisplayName(vol({ displayName: "Old Name" }), { override: "New Name" }),
    ).toBe("New Name");
  });

  it("preserves DrivesPanel's existing casing behavior exactly (WARP-832 is separate)", () => {
    // [-_]+ → space, then title-case each lowercase word start; already-upper
    // text is left alone.
    expect(driveDisplayName(vol({ displayName: "family_photos" }))).toBe("Family Photos");
    expect(driveDisplayName(vol({ displayName: "NVR archive" }))).toBe("NVR Archive");
    expect(driveDisplayName(vol({ label: "VAULT" }))).toBe("VAULT");
  });
});

describe("driveDisplayName — GUID tails are never rendered (WARP-1337 AC1)", () => {
  it("renders 'Drive' for a full fs-UUID mount tail", () => {
    const name = driveDisplayName(vol({ mount: GUID_MOUNT }));
    expect(name).toBe("Drive");
    expect(name).not.toMatch(/a0f10a84/i);
  });

  it("renders 'Storage pool' for a UUID tail when the caller says pool-backed", () => {
    expect(driveDisplayName(vol({ mount: GUID_MOUNT }), { poolBacked: true })).toBe("Storage pool");
  });

  it("renders the generic for drive-<hex> / pool-<hex> tails", () => {
    expect(driveDisplayName(vol({ mount: "/mnt/droplet/drive-ab12cd34" }))).toBe("Drive");
    expect(
      driveDisplayName(vol({ mount: "/mnt/droplet/pool-1a2b3c4d" }), { poolBacked: true }),
    ).toBe("Storage pool");
  });

  it("renders the generic for a vfat-style hex serial tail (B0C1-D2E3)", () => {
    expect(driveDisplayName(vol({ mount: "/mnt/droplet/B0C1-D2E3" }))).toBe("Drive");
  });

  it("still renders 'Drive' when everything is empty", () => {
    expect(driveDisplayName(vol({ mount: "/" }))).toBe("Drive");
  });

  it("keeps a human tail that merely CONTAINS hex (no over-matching)", () => {
    // "photos-ab12cd34" is not a pure machine id — the pre-existing humanize
    // behavior stays.
    expect(driveDisplayName(vol({ mount: "/mnt/droplet/photos-ab12cd34" }))).toBe(
      "Photos Ab12cd34",
    );
  });
});

describe("isMachineTail", () => {
  it("flags fs UUIDs, vfat serials and drive-/pool-<hex> tails", () => {
    expect(isMachineTail("a0f10a84-7116-46a7-a3e3-5e00ea1c7d08")).toBe(true);
    expect(isMachineTail("B0C1-D2E3")).toBe(true);
    expect(isMachineTail("drive-ab12cd34")).toBe(true);
    expect(isMachineTail("pool-1a2b")).toBe(true);
  });

  it("does not flag human names", () => {
    expect(isMachineTail("wedding-photos")).toBe(false);
    expect(isMachineTail("Cameras")).toBe(false);
    expect(isMachineTail("nvr")).toBe(false);
  });
});

describe("isPoolBackedDevice", () => {
  it("recognizes md devices and their partitions", () => {
    expect(isPoolBackedDevice("/dev/md127")).toBe(true);
    expect(isPoolBackedDevice("/dev/md0p1")).toBe(true);
  });

  it("rejects plain disks and junk", () => {
    expect(isPoolBackedDevice("/dev/sda1")).toBe(false);
    expect(isPoolBackedDevice("/dev/nvme0n1p1")).toBe(false);
    expect(isPoolBackedDevice(undefined)).toBe(false);
    expect(isPoolBackedDevice("")).toBe(false);
  });
});

describe("sanitizeFsLabel (WARP-1337 AC4)", () => {
  it("always yields a label matching ^[A-Za-z0-9_-]{1,16}$ (or nothing)", () => {
    for (const input of ["Family Photos", "  Wedding Photos  ", "Média & Films!", "a".repeat(40)]) {
      const out = sanitizeFsLabel(input);
      expect(out).toBeTruthy();
      expect(out!).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
    }
  });

  it("keeps word boundaries readable (whitespace → underscore)", () => {
    expect(sanitizeFsLabel("Family Photos")).toBe("Family_Photos");
    expect(sanitizeFsLabel("Samsung T7")).toBe("Samsung_T7");
  });

  it("strips invalid characters and trims", () => {
    expect(sanitizeFsLabel("  Média & Films!  ")).toBe("Mdia_Films");
    expect(sanitizeFsLabel("VAULT")).toBe("VAULT");
  });

  it("caps at 16 characters", () => {
    expect(sanitizeFsLabel("A Very Long Drive Name Indeed")!.length).toBeLessThanOrEqual(16);
  });

  it("returns undefined when nothing usable remains (caller omits the label)", () => {
    expect(sanitizeFsLabel("")).toBeUndefined();
    expect(sanitizeFsLabel("   ")).toBeUndefined();
    expect(sanitizeFsLabel("!!!")).toBeUndefined();
    expect(sanitizeFsLabel(null)).toBeUndefined();
    expect(sanitizeFsLabel(undefined)).toBeUndefined();
  });
});
