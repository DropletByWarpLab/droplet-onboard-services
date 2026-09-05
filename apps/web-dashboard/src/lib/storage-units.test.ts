/**
 * WARP-1561 — the canonical storage bytes ⇄ {value, unit} contract.
 *
 * Three implementations of this conversion shipped in the dashboard
 * (`lib/access.ts`, `app/users/page.tsx`, `components/Departments/DepartmentsPanel.tsx`)
 * and they disagreed. The disagreement was not cosmetic: `bytesToStorageInput`
 * rounded the GB view to one decimal, so re-saving an UNTOUCHED quota drifted
 * the stored byte count (~20 MB on a ~1.1 TB value) and any quota under
 * 0.05 GB collapsed to "0" — which the input→bytes direction reads as
 * `null` = **no limit**. Silently removing a customer's storage cap is the
 * worst possible failure mode for this control.
 *
 * The round-trip property below is the fix's contract: bytes → editor pair →
 * bytes is the identity for every representable quota, including the
 * small-value and no-limit edges. Everything else in this file pins the
 * single rounding policy the three call sites now share.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STORAGE_UNIT_BYTES,
  bytesToStorageInput,
  formatStorageBytes,
  storageInputToBytes,
} from "./storage-units";

const GB = 1024 ** 3;
const TB = 1024 ** 4;
const MB = 1024 ** 2;

describe("WARP-1561 — bytes ⇄ editor round trip is the identity", () => {
  /** Every value an admin can type, plus the byte counts that broke T8. */
  const cases: ReadonlyArray<[string, string]> = [
    ["whole GB (the common case)", String(25 * GB)],
    ["whole TB", String(TB)],
    ["1 GB (unit boundary)", String(GB)],
    ["1200 GB — divides evenly in GB but not TB", String(1200 * GB)],
    ["1.2 TB — an admin-typed fraction of a TB", String(Math.round(1.2 * TB))],
    ["1.5 GB — an admin-typed fraction of a GB", String(Math.round(1.5 * GB))],
    // The two byte counts named in the ticket.
    ["a byte count that is a whole number of neither (T8 ~20 MB drift)", "1234567890123"],
    ["10 MB — under the old 0.05 GB nulling floor", String(10 * MB)],
    ["1 MB — deep under that floor", String(MB)],
    ["1 byte — the smallest positive quota", "1"],
  ];

  for (const [label, bytes] of cases) {
    it(`round-trips ${label}`, () => {
      const { value, unit } = bytesToStorageInput(bytes);
      expect(storageInputToBytes(value, unit)).toBe(bytes);
    });
  }

  it("round-trips the no-limit edge (null ⇄ empty field)", () => {
    const { value, unit } = bytesToStorageInput(null);
    expect(value).toBe("");
    expect(storageInputToBytes(value, unit)).toBeNull();
  });

  it("never collapses a small quota to the empty (= no limit) field", () => {
    // The T8 bug: 10 MB rounded to "0" GB, and "0" parses back to null.
    for (const bytes of [String(10 * MB), String(MB), "1024", "1"]) {
      const { value, unit } = bytesToStorageInput(bytes);
      expect(value).not.toBe("");
      expect(value).not.toBe("0");
      expect(storageInputToBytes(value, unit)).toBe(bytes);
    }
  });
});

describe("WARP-1561 — bytesToStorageInput picks the shortest exact form", () => {
  it("prefers the unit that needs the fewest characters, larger unit on a tie", () => {
    expect(bytesToStorageInput(String(25 * GB))).toEqual({ value: "25", unit: "GB" });
    expect(bytesToStorageInput(String(TB))).toEqual({ value: "1", unit: "TB" });
    expect(bytesToStorageInput(String(2 * TB))).toEqual({ value: "2", unit: "TB" });
    // 1200 GB is 1.171875 TB — GB reads better and is just as exact.
    expect(bytesToStorageInput(String(1200 * GB))).toEqual({ value: "1200", unit: "GB" });
    // 1.2 TB is 1228.8 GB — same character count, so the larger unit wins.
    expect(bytesToStorageInput(String(Math.round(1.2 * TB)))).toEqual({
      value: "1.2",
      unit: "TB",
    });
  });

  it("falls back to full precision rather than lie about the byte count", () => {
    // 10 MB has no pretty GB form; an exact ugly one beats a lossy pretty one.
    const small = bytesToStorageInput(String(10 * MB));
    expect(small.unit).toBe("GB");
    expect(Number(small.value)).toBeCloseTo(10 / 1024, 12);
    expect(storageInputToBytes(small.value, small.unit)).toBe(String(10 * MB));
  });

  it("treats absent / unparseable / non-positive byte counts as no limit", () => {
    for (const bad of [null, undefined, "", "not-a-number", "0", "-1"]) {
      expect(bytesToStorageInput(bad)).toEqual({ value: "", unit: "GB" });
    }
  });
});

describe("WARP-1561 — storageInputToBytes", () => {
  it("encodes the admin-typed pair as a decimal byte string", () => {
    expect(storageInputToBytes("25", "GB")).toBe("26843545600");
    expect(storageInputToBytes("1", "TB")).toBe("1099511627776");
    expect(storageInputToBytes(" 2 ", "GB")).toBe(String(2 * GB));
  });

  it("returns null (= no limit) for empty and non-positive input", () => {
    expect(storageInputToBytes("", "GB")).toBeNull();
    expect(storageInputToBytes("   ", "GB")).toBeNull();
    expect(storageInputToBytes("0", "GB")).toBeNull();
    expect(storageInputToBytes("-3", "GB")).toBeNull();
    expect(storageInputToBytes("abc", "GB")).toBeNull();
  });

  it("exposes the unit table the selects render", () => {
    expect(STORAGE_UNIT_BYTES).toEqual({ GB: 1024 ** 3, TB: 1024 ** 4 });
  });
});

describe("WARP-1561 — formatStorageBytes is one display policy", () => {
  it("scales to the largest unit that leaves a value of at least 1", () => {
    expect(formatStorageBytes("512")).toBe("512 B");
    expect(formatStorageBytes(String(1024))).toBe("1 KB");
    expect(formatStorageBytes(String(500 * MB))).toBe("500 MB");
    expect(formatStorageBytes(String(25 * GB))).toBe("25 GB");
    expect(formatStorageBytes(String(TB))).toBe("1 TB");
    expect(formatStorageBytes(String(1024 * TB))).toBe("1 PB");
  });

  it("renders one decimal for fractions and none for whole numbers", () => {
    expect(formatStorageBytes(String(1536))).toBe("1.5 KB");
    expect(formatStorageBytes(String(4404019200))).toBe("4.1 GB");
    // The old per-page formatter rounded anything ≥ 10 to a whole number,
    // so a 12.5 GB quota read as "13 GB" on one surface and "12.5 GB" on
    // another. One decimal everywhere.
    expect(formatStorageBytes(String(Math.round(12.5 * GB)))).toBe("12.5 GB");
    expect(formatStorageBytes(String(Math.round(17.3 * GB)))).toBe("17.3 GB");
  });

  it("never rounds a sub-MB value away to '0 MB'", () => {
    // lib/access.ts floored at MB, so a 1 KB value displayed as "0 MB".
    expect(formatStorageBytes("1024")).toBe("1 KB");
    expect(formatStorageBytes("1")).toBe("1 B");
  });

  it("renders an em dash for unknown, never a fabricated zero", () => {
    expect(formatStorageBytes(null)).toBe("—");
    expect(formatStorageBytes(undefined)).toBe("—");
    expect(formatStorageBytes("")).toBe("—");
    expect(formatStorageBytes("not-a-number")).toBe("—");
    expect(formatStorageBytes("-5")).toBe("—");
  });

  it("defaults zero to the em dash but renders it exactly where zero is knowledge", () => {
    // A quota of 0 bytes is not a thing — that reads as "unknown".
    expect(formatStorageBytes("0")).toBe("—");
    // Usage of 0 bytes IS a fact, and the usage surfaces say so.
    expect(formatStorageBytes("0", { zero: "0 B" })).toBe("0 B");
    expect(formatStorageBytes(null, { zero: "0 B" })).toBe("—");
  });

  it("accepts the numeric form the non-quota surfaces already hold", () => {
    expect(formatStorageBytes(25 * GB)).toBe("25 GB");
    expect(formatStorageBytes(0, { zero: "0 B" })).toBe("0 B");
  });
});

/**
 * Source-level guard, same shape as the other drift gates in this suite
 * (design-tokens.lock, remote-access.orange-contrast): the whole point of
 * WARP-1561 is that the quota surfaces stop carrying their own copy. A
 * re-forked unit table is how the three drifted apart the first time.
 *
 * Path resolution uses `__dirname`, the one anchoring idiom this package
 * uses (WARP-2654) — see `src/__tests__/helpers/test-paths.ts` for why it is
 * spelled this way here. It is NOT that `import.meta.url` is unsafe on
 * Windows: `fileURLToPath` converts it correctly, and only
 * `new URL(...).pathname` yields the `/C:/...` that `path.resolve` doubles.
 */
describe("WARP-1561 — the quota surfaces share this module", () => {
  const SRC = resolve(__dirname, "..");
  const callSites = [
    ["lib/access.ts", "lib/access.ts"],
    ["app/users/page.tsx", "app/users/page.tsx"],
    ["components/Departments/DepartmentsPanel.tsx", "components/Departments/DepartmentsPanel.tsx"],
  ] as const;

  for (const [label, relPath] of callSites) {
    it(`${label} imports the shared helpers instead of redefining them`, () => {
      const source = readFileSync(resolve(SRC, ...relPath.split("/")), "utf8");
      expect(source).toMatch(/from "(\.|@\/lib)\/storage-units"/);
      // A local `{ GB: 1024 ** 3, ... }` table is the tell-tale of a re-fork.
      expect(source).not.toMatch(/GB:\s*1024\s*\*\*\s*3/);
    });
  }
});
