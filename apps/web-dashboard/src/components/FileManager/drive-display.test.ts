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
  drivePoolName,
  formatBytes,
  isMachineTail,
  isPoolBackedDevice,
  poolBackingDrive,
  sanitizeFsLabel,
  takenVolumeNames,
  uniqueFsLabel,
  volumeCrumbLabel,
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

  // Code review (WARP-1337): droplet-automount.sh names an unlabeled volume
  // `drive-<first-8-UUID-chars>`. A vfat UUID is XXXX-XXXX, so the tail comes
  // out with an EMBEDDED dash — e.g. "drive-B0C1-D2E" — which the original
  // guard missed and would have rendered as "Drive B0C1 D2E".
  it("renders the generic for the automount's dashed unlabeled-vfat shape", () => {
    expect(driveDisplayName(vol({ mount: "/mnt/droplet/drive-B0C1-D2E" }))).toBe("Drive");
    expect(
      driveDisplayName(vol({ mount: "/mnt/droplet/pool-b0c1-d2e" }), { poolBacked: true }),
    ).toBe("Storage pool");
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

  // Code review (WARP-1337): the automount's unlabeled-vfat tail embeds a
  // dash (drive-<first-8-of-XXXX-XXXX> → "drive-B0C1-D2E").
  it("flags the automount's dashed hex tails too", () => {
    expect(isMachineTail("drive-B0C1-D2E")).toBe(true);
    expect(isMachineTail("drive-b0c1-d2e3")).toBe(true);
    expect(isMachineTail("pool-1a2b-3c")).toBe(true);
  });

  it("does not flag human names", () => {
    expect(isMachineTail("wedding-photos")).toBe(false);
    expect(isMachineTail("Cameras")).toBe(false);
    expect(isMachineTail("nvr")).toBe(false);
    // drive-/pool- prefixed HUMAN names keep rendering: a non-hex segment
    // breaks the machine-id shape.
    expect(isMachineTail("drive-backup")).toBe(false);
    expect(isMachineTail("pool-media-two")).toBe(false);
  });
});

// =====================================================================
// WARP-1339 — the pool↔drive join. Pools and drives were two UNJOINED
// lists at every layer, so a mounted pool rendered twice (PoolCard +
// anonymous GUID drive tile). These helpers own the normalized join key:
// the pools payload names arrays BARE ("md127") while drives carry
// "/dev/md127".
// =====================================================================
describe("drivePoolName (WARP-1339)", () => {
  it("prefers the orchestrator's explicit pool annotation", () => {
    expect(drivePoolName({ device: "/dev/md127", pool: "md127" })).toBe("md127");
    // The annotation is authoritative even when the device shape is exotic
    // (e.g. a dm-mapped node the regex can't see through).
    expect(drivePoolName({ device: "/dev/dm-0", pool: "md127" })).toBe("md127");
  });

  it("falls back to the anchored md-device matcher for an older orchestrator", () => {
    expect(drivePoolName({ device: "/dev/md127" })).toBe("md127");
    expect(drivePoolName({ device: "/dev/md127p1" })).toBe("md127");
  });

  it("returns null for standalone drives (explicit null and absent field alike)", () => {
    expect(drivePoolName({ device: "/dev/sda1", pool: null })).toBeNull();
    expect(drivePoolName({ device: "/dev/sda1" })).toBeNull();
    expect(drivePoolName({ device: "/dev/nvme0n1p2" })).toBeNull();
  });
});

describe("poolBackingDrive (WARP-1339)", () => {
  const mdDrive = { device: "/dev/md127", pool: "md127", mount: "/mnt/droplet/pool" };
  const mdPart = { device: "/dev/md127p1", pool: "md127", mount: "/mnt/droplet/pool-p1" };
  const plain = { device: "/dev/sda1", pool: null, mount: "/mnt/droplet/data" };

  it("joins the bare pool name against the /dev/-prefixed drive device", () => {
    expect(poolBackingDrive("md127", [plain, mdDrive])).toBe(mdDrive);
  });

  it("prefers the md node itself over a partition of it", () => {
    expect(poolBackingDrive("md127", [mdPart, mdDrive])).toBe(mdDrive);
    // A partitioned-only pool still resolves to its partition's filesystem.
    expect(poolBackingDrive("md127", [plain, mdPart])).toBe(mdPart);
  });

  it("returns undefined when the pool backs no mounted filesystem", () => {
    expect(poolBackingDrive("md127", [plain])).toBeUndefined();
    expect(poolBackingDrive("md127", [])).toBeUndefined();
  });

  it("never lets md12 grab md127's drives (anchored, not prefix, matching)", () => {
    expect(poolBackingDrive("md12", [mdDrive, mdPart])).toBeUndefined();
  });

  it("joins via the regex fallback when the orchestrator predates the annotation", () => {
    const legacy = { device: "/dev/md127", mount: "/mnt/droplet/pool" };
    expect(poolBackingDrive("md127", [legacy])).toBe(legacy);
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
    expect(sanitizeFsLabel("VAULT")).toBe("VAULT");
    expect(sanitizeFsLabel("Photos (2026)!")).toBe("Photos_2026");
  });

  // Code-review follow-up: the server contract is ASCII-only, but an accented
  // letter should transliterate ("Média" → "Media"), not vanish ("Mdia").
  it("transliterates accented letters instead of dropping them", () => {
    expect(sanitizeFsLabel("  Média & Films!  ")).toBe("Media_Films");
    expect(sanitizeFsLabel("Café Décor")).toBe("Cafe_Decor");
    expect(sanitizeFsLabel("Übung")).toBe("Ubung");
  });

  it("caps at 16 characters", () => {
    expect(sanitizeFsLabel("A Very Long Drive Name Indeed")!.length).toBeLessThanOrEqual(16);
  });

  // Code review (WARP-1337): the 16-char cap used to run AFTER the
  // trailing-separator strip, so a truncation could re-introduce one
  // ("Samsung SSD 870 EVO" → "Samsung_SSD_870_"). Contract-legal but ugly.
  it("never leaves a trailing separator after the 16-char truncation", () => {
    expect(sanitizeFsLabel("Samsung SSD 870 EVO")).toBe("Samsung_SSD_870");
    expect(sanitizeFsLabel("Samsung-SSD-870-EVO")).toBe("Samsung-SSD-870");
  });

  it("returns undefined when nothing usable remains (caller omits the label)", () => {
    expect(sanitizeFsLabel("")).toBeUndefined();
    expect(sanitizeFsLabel("   ")).toBeUndefined();
    expect(sanitizeFsLabel("!!!")).toBeUndefined();
    expect(sanitizeFsLabel(null)).toBeUndefined();
    expect(sanitizeFsLabel(undefined)).toBeUndefined();
  });
});

// =====================================================================
// Code review (WARP-1337) — label-collision shadow-mount guard.
//
// droplet-storage-pool.sh mounts an adopted/reclaimed drive at
// /mnt/droplet/<LABEL> via a raw host_mount with NO busy-target guard: seeding
// a label another volume already carries STACKS the new mount over the old
// one, shadowing it until reboot — writes meant for drive A silently land on
// drive B. Two identical-model drives adopted in one session (2× Samsung T7 →
// both "Samsung_T7") is the realistic home-NAS trigger. The fix is
// caller-side (the ticket forbids touching the host script): before seeding,
// check the current volume snapshot and suffix (short serial / numeric bump)
// or omit the label when it's already carried.
// =====================================================================

describe("takenVolumeNames — the collision snapshot", () => {
  it("collects both FS labels and mount tails", () => {
    expect(
      takenVolumeNames([
        { mount: "/mnt/droplet/Samsung_T7", label: "Samsung_T7" },
        { mount: "/mnt/droplet/a0f10a84-7116-46a7-a3e3-5e00ea1c7d08", label: "" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        "Samsung_T7",
        "a0f10a84-7116-46a7-a3e3-5e00ea1c7d08",
      ]),
    );
  });

  it("skips empty mounts and labels", () => {
    expect(takenVolumeNames([{ mount: "", label: "" }, { mount: "/" }])).toEqual([]);
  });
});

describe("uniqueFsLabel — never seed a label another volume carries", () => {
  const TAKEN = ["Samsung_T7", "wedding", "TOSHIBA"];

  it("returns the candidate unchanged when nothing collides", () => {
    expect(uniqueFsLabel("Family_Photos", TAKEN)).toBe("Family_Photos");
  });

  it("passes undefined through (nothing to uniquify)", () => {
    expect(uniqueFsLabel(undefined, TAKEN)).toBeUndefined();
  });

  it("suffixes a colliding label with the short serial tail", () => {
    expect(uniqueFsLabel("Samsung_T7", TAKEN, "S6XNNS0T123456B")).toBe(
      "Samsung_T7_456B",
    );
  });

  it("compares case-insensitively (vfat uppercases labels; paths are the hazard)", () => {
    expect(uniqueFsLabel("SAMSUNG_T7", TAKEN, "S6XNNS0T123456B")).toBe(
      "SAMSUNG_T7_456B",
    );
    expect(uniqueFsLabel("Wedding", TAKEN, "AB12")).toBe("Wedding_AB12");
  });

  it("falls back to a numeric bump when there is no serial hint", () => {
    expect(uniqueFsLabel("Samsung_T7", TAKEN)).toBe("Samsung_T7_2");
    expect(uniqueFsLabel("Samsung_T7", [...TAKEN, "Samsung_T7_2"])).toBe(
      "Samsung_T7_3",
    );
  });

  it("keeps every suffixed result inside the ^[A-Za-z0-9_-]{1,16}$ contract", () => {
    const out = uniqueFsLabel("Sixteen_Chars_AB", ["Sixteen_Chars_AB"], "S123456789");
    expect(out).toBeTruthy();
    expect(out!).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
    // The base is truncated to make room — never a >16-char label.
    expect(out).toBe("Sixteen_Cha_6789");
  });

  it("skips a serial-suffixed name that is ALSO taken", () => {
    expect(
      uniqueFsLabel("Samsung_T7", [...TAKEN, "Samsung_T7_456B"], "S6XNNS0T123456B"),
    ).toBe("Samsung_T7_2");
  });

  it("returns undefined when nothing collision-free fits (caller omits; fs-UUID mount stays unique)", () => {
    const exhausted = [
      "Samsung_T7",
      "Samsung_T7_456B",
      ...Array.from({ length: 8 }, (_, i) => `Samsung_T7_${i + 2}`),
    ];
    expect(uniqueFsLabel("Samsung_T7", exhausted, "S6XNNS0T123456B")).toBeUndefined();
  });
});

// =====================================================================
// WARP-1338 (UX review) — breadcrumb first-segment label. A volume deep-link
// lands on /files?path=/<mount-tail>; for the live box's legacy pool that
// tail is the FULL fs UUID, and BreadcrumbNav rendered it raw as the
// current-folder crumb — re-introducing the exact GUID-as-primary-label the
// WARP-1337 chain exists to prevent, one click after the GUID-guarded tile.
// =====================================================================
describe("volumeCrumbLabel — GUID never the location label (WARP-1338 UX review)", () => {
  const GUID = "a0f10a84-7116-46a7-a3e3-5e00ea1c7d08";
  const poolDrive = {
    device: "/dev/md127",
    mount: `/mnt/droplet/${GUID}`,
    label: "",
    displayName: null,
  };

  it("maps a legacy GUID pool tail through the pool's display chain", () => {
    expect(
      volumeCrumbLabel(GUID, [poolDrive], [{ device: "md127", displayName: "Family Vault" }]),
    ).toBe("Family Vault");
  });

  it("says 'Storage pool' for a nameless pool — never the GUID", () => {
    expect(volumeCrumbLabel(GUID, [poolDrive], [{ device: "md127", displayName: null }])).toBe(
      "Storage pool",
    );
  });

  it("still says 'Storage pool' for a pool-backed drive missing from the pools payload", () => {
    expect(volumeCrumbLabel(GUID, [poolDrive], [])).toBe("Storage pool");
  });

  it("maps a standalone drive tail through the shared display chain", () => {
    expect(
      volumeCrumbLabel(
        "photos-ab12cd34",
        [
          {
            device: "/dev/sdb1",
            mount: "/mnt/droplet/photos-ab12cd34",
            label: "TOSHIBA EXT",
            displayName: "Family Photos",
          },
        ],
        [],
      ),
    ).toBe("Family Photos");
  });

  it("humanizes an UNMATCHED machine tail (drives payload still loading / dead link)", () => {
    expect(volumeCrumbLabel(GUID, [], [])).toBe("Drive");
    expect(volumeCrumbLabel("pool-cafef00d", [], [])).toBe("Storage pool");
    expect(volumeCrumbLabel("drive-ab12cd34", [], [])).toBe("Drive");
  });

  it("returns undefined for a human folder segment — real folder names render raw", () => {
    expect(volumeCrumbLabel("Documents", [], [])).toBeUndefined();
    expect(volumeCrumbLabel("Documents", [poolDrive], [])).toBeUndefined();
  });
});

describe("formatBytes (WARP-2098 — one formatter for the Storage and Files screens)", () => {
  // DrivesPanel's fmtBytes and VolumesPanel's formatBytes were two private
  // copies; the second drifted (no unit clamp) and rendered "1.0 undefined" at
  // a pebibyte. One export, tested once.
  it("renders binary units, one decimal under 10", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(512 * 1024 ** 3)).toBe("512 GB");
  });

  it("clamps the unit at TB so a petabyte pool never renders 'undefined'", () => {
    expect(formatBytes(2 ** 50)).toBe("1024 TB");
    expect(formatBytes(2 ** 51)).toBe("2048 TB");
  });
});
