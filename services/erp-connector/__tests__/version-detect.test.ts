/**
 * WARP-1094 — engine-version detection tests (brief §3, §9.1; review C-5).
 *
 * Unit tests only; no database is touched. These pin the catalog-dialect
 * decision (SA10+ → modern SYS.SYSTAB*; ASA7 → legacy SYSTABLE/SYSCOLUMN) and
 * the corrected Eaglesoft ↔ engine band map.
 */
import { describe, it, expect } from "vitest";
import {
  parseEngineVersion,
  eaglesoftBandForEngine,
  EngineVersionError,
} from "../src/version-detect.js";

describe("parseEngineVersion", () => {
  it("maps SQL Anywhere 17 to the modern catalog dialect", () => {
    const v = parseEngineVersion("17.0.11.6889");
    expect(v.major).toBe(17);
    expect(v.dialect).toBe("modern");
  });

  it("maps SQL Anywhere 16 and 10 to the modern catalog dialect", () => {
    expect(parseEngineVersion("16.0.0.2727").dialect).toBe("modern");
    expect(parseEngineVersion("10.0.1.4239").dialect).toBe("modern");
  });

  it("maps ASA 7 to the legacy catalog dialect", () => {
    const v = parseEngineVersion("7.0.4.3605");
    expect(v.major).toBe(7);
    expect(v.dialect).toBe("legacy");
  });

  it("preserves the raw version string", () => {
    expect(parseEngineVersion("  17.0.11.6889 ").raw).toBe("17.0.11.6889");
  });

  it("throws on an unparseable version (never guess the catalog family)", () => {
    expect(() => parseEngineVersion("")).toThrow(EngineVersionError);
    expect(() => parseEngineVersion("not-a-version")).toThrow(EngineVersionError);
  });
});

describe("eaglesoftBandForEngine (corrected map, research §2)", () => {
  it("SA17+ → Eaglesoft 20 and above", () => {
    expect(eaglesoftBandForEngine(17)).toContain("20 and above");
  });

  it("SA16 → Eaglesoft 18.10–19.10", () => {
    expect(eaglesoftBandForEngine(16)).toContain("18.10");
  });

  it("SA10 → Eaglesoft 16–18 (NOT v16 — the prior belief was wrong)", () => {
    expect(eaglesoftBandForEngine(10)).toContain("16–18");
  });

  it("ASA7 → Eaglesoft 15 and below", () => {
    expect(eaglesoftBandForEngine(7)).toContain("15 and below");
  });
});
