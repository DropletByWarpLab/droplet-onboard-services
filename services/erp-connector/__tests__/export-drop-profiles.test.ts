/**
 * WARP-1964 — export profiles: header-signature matching, the two refusals
 * (unrecognized / ambiguous), profile validation, and operator-supplied JSON.
 *
 * The load-bearing claim these tests defend is that **a wrong profile cannot
 * produce wrong data**. Matching is on headers, never on filename or column
 * position; a profile that does not match declines the file rather than
 * guessing at it; and two profiles matching one file is refused rather than
 * resolved by declaration order.
 */
import { describe, it, expect } from "vitest";
import {
  assertValidProfile,
  BUILT_IN_PROFILES,
  CANONICAL_COLUMNS,
  GENERIC_VENDOR,
  knownVendors,
  matchDataset,
  normalizeHeader,
  parseProfileJson,
  profilesForVendor,
  ProfileError,
  REQUIRED_CANONICAL,
  type ExportProfile,
} from "../src/export-drop/profiles.js";
import { READ_QUERIES } from "../src/read-queries.js";

const patientProfile: ExportProfile = {
  vendor: "acme",
  label: "Acme PM",
  verified: true,
  datasets: [
    {
      dataset: "patient",
      required: ["Patient ID", "Last Name"],
      columns: { patient_id: "Patient ID", first_name: "First Name", last_name: "Last Name" },
    },
  ],
};

describe("normalizeHeader", () => {
  it("absorbs case and spacing differences between report versions", () => {
    expect(normalizeHeader("  PATIENT   ID ")).toBe("patient id");
    expect(normalizeHeader("Patient ID")).toBe("patient id");
  });
});

describe("matchDataset", () => {
  it("claims a file when every required header is present", () => {
    const result = matchDataset(["Patient ID", "First Name", "Last Name"], [patientProfile]);
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.candidate.dataset.dataset).toBe("patient");
  });

  it("matches case-insensitively and tolerates extra columns", () => {
    const result = matchDataset(
      ["patient  id", "LAST NAME", "First Name", "Preferred Name", "Cell Phone"],
      [patientProfile],
    );
    expect(result.kind).toBe("matched");
  });

  it("declines a file that is missing a required header", () => {
    // Missing "Last Name". The profile must NOT fall back to position or to a
    // partial match — declining is what makes a wrong guess harmless.
    expect(matchDataset(["Patient ID", "First Name"], [patientProfile]).kind).toBe("unrecognized");
  });

  it("declines rather than matching on column position", () => {
    // Same shape, same order, entirely different header names.
    expect(matchDataset(["ID", "Given", "Family"], [patientProfile]).kind).toBe("unrecognized");
  });

  it("refuses an ambiguous file instead of taking the first match", () => {
    const twin: ExportProfile = {
      ...patientProfile,
      datasets: [
        patientProfile.datasets[0],
        {
          dataset: "account",
          required: ["Patient ID", "Last Name"],
          columns: { account_id: "Patient ID", balance: "Last Name" },
        },
      ],
    };
    const result = matchDataset(["Patient ID", "Last Name"], [twin]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.datasets).toEqual(["acme.account", "acme.patient"]);
    }
  });

  it("returns unrecognized when there are no profiles at all", () => {
    expect(matchDataset(["Anything"], []).kind).toBe("unrecognized");
  });
});

describe("built-in profiles", () => {
  it("are all marked unverified — none has been confirmed against a real export", () => {
    for (const profile of BUILT_IN_PROFILES) {
      expect(profile.verified, `${profile.vendor} must ship unverified`).toBe(false);
    }
  });

  it("are structurally valid", () => {
    for (const profile of BUILT_IN_PROFILES) {
      expect(() => assertValidProfile(profile)).not.toThrow();
    }
  });

  it("cover more than one vendor — this track is not Eaglesoft-only", () => {
    const vendors = BUILT_IN_PROFILES.map((p) => p.vendor);
    expect(vendors).toContain("eaglesoft");
    expect(vendors.length).toBeGreaterThan(1);
    expect(new Set(vendors).size).toBe(vendors.length);
  });

  it("never collide across vendors, because matching is scoped to one vendor", () => {
    // Two products can legitimately use the same column names. Scoping the
    // match to the connection's own vendor is what stops that from becoming an
    // ambiguity that blocks both.
    for (const profile of BUILT_IN_PROFILES) {
      for (const dataset of profile.datasets) {
        const result = matchDataset(dataset.required, profilesForVendor(profile.vendor));
        expect(result.kind, `${profile.vendor}.${dataset.dataset}`).toBe("matched");
      }
    }
  });
});

describe("canonical column contract", () => {
  it("covers every table the read registry depends on", () => {
    const needed = new Set(READ_QUERIES.flatMap((q) => q.dependsOnTables));
    for (const table of needed) {
      expect(Object.keys(CANONICAL_COLUMNS)).toContain(table);
    }
  });

  it("keeps every required canonical column inside the canonical set", () => {
    for (const [dataset, required] of Object.entries(REQUIRED_CANONICAL)) {
      for (const column of required) {
        expect(CANONICAL_COLUMNS[dataset as keyof typeof CANONICAL_COLUMNS]).toContain(column);
      }
    }
  });
});

describe("assertValidProfile", () => {
  it("rejects a dataset with no required headers, which would claim every file", () => {
    expect(() =>
      assertValidProfile({
        ...patientProfile,
        datasets: [{ ...patientProfile.datasets[0], required: [] }],
      }),
    ).toThrow(ProfileError);
  });

  it("rejects an unknown canonical column so a typo is a startup error", () => {
    expect(() =>
      assertValidProfile({
        ...patientProfile,
        datasets: [
          {
            ...patientProfile.datasets[0],
            columns: { ...patientProfile.datasets[0].columns, surname: "Last Name" },
          },
        ],
      }),
    ).toThrow(/unknown canonical column/);
  });

  it("rejects a profile that omits a column its dataset cannot be served without", () => {
    expect(() =>
      assertValidProfile({
        ...patientProfile,
        datasets: [
          {
            dataset: "patient",
            required: ["Patient ID"],
            columns: { patient_id: "Patient ID" },
          },
        ],
      }),
    ).toThrow(/must map "last_name"/);
  });

  it("rejects a required column mapped to a header the matcher never checks", () => {
    // Otherwise the profile could claim a file and then read a column that was
    // never proven present.
    expect(() =>
      assertValidProfile({
        ...patientProfile,
        datasets: [
          {
            dataset: "patient",
            required: ["Patient ID", "Surname"],
            columns: { patient_id: "Patient ID", last_name: "Last Name" },
          },
        ],
      }),
    ).toThrow(/not in its required list/);
  });

  it("rejects a duplicate dataset and an unknown dataset", () => {
    expect(() =>
      assertValidProfile({
        ...patientProfile,
        datasets: [patientProfile.datasets[0], patientProfile.datasets[0]],
      }),
    ).toThrow(/twice/);
    expect(() =>
      assertValidProfile({
        ...patientProfile,
        datasets: [{ ...patientProfile.datasets[0], dataset: "ledger" as never }],
      }),
    ).toThrow(/unknown dataset/);
  });

  it("rejects a malformed vendor key, which would produce a malformed provider", () => {
    expect(() => assertValidProfile({ ...patientProfile, vendor: "Acme Corp" })).toThrow(
      ProfileError,
    );
  });
});

describe("profilesForVendor", () => {
  it("returns the built-in set for a known vendor", () => {
    expect(profilesForVendor("eaglesoft").map((p) => p.vendor)).toEqual(["eaglesoft"]);
  });

  it("returns nothing for the generic vendor until an operator supplies a profile", () => {
    expect(profilesForVendor(GENERIC_VENDOR)).toHaveLength(0);
    expect(profilesForVendor(GENERIC_VENDOR, [{ ...patientProfile, vendor: GENERIC_VENDOR }])).toHaveLength(1);
  });

  it("lets an operator profile REPLACE a built-in rather than merge with it", () => {
    const override: ExportProfile = { ...patientProfile, vendor: "eaglesoft" };
    const resolved = profilesForVendor("eaglesoft", [override]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].label).toBe("Acme PM");
    expect(resolved[0].datasets).toHaveLength(1);
  });

  it("ignores operator profiles for a different vendor", () => {
    expect(profilesForVendor("eaglesoft", [patientProfile]).map((p) => p.vendor)).toEqual([
      "eaglesoft",
    ]);
  });
});

describe("knownVendors", () => {
  it("always includes the generic escape hatch plus every built-in", () => {
    const vendors = knownVendors();
    expect(vendors).toContain(GENERIC_VENDOR);
    expect(vendors).toContain("eaglesoft");
  });

  it("includes vendors introduced by operator profiles", () => {
    expect(knownVendors([patientProfile])).toContain("acme");
  });
});

describe("parseProfileJson", () => {
  const valid = JSON.stringify({
    vendor: "acme",
    label: "Acme PM",
    datasets: [
      {
        dataset: "patient",
        required: ["Pat #", "Surname"],
        columns: { patient_id: "Pat #", last_name: "Surname", first_name: "Given" },
      },
    ],
  });

  it("accepts a single object or an array", () => {
    expect(parseProfileJson(valid)).toHaveLength(1);
    expect(parseProfileJson(`[${valid},${valid}]`)).toHaveLength(2);
  });

  it("marks operator profiles verified — the operator read the real export", () => {
    expect(parseProfileJson(valid)[0].verified).toBe(true);
  });

  it("lets an operator map a product with no built-in profile", () => {
    const profile = parseProfileJson(valid)[0];
    expect(matchDataset(["Pat #", "Surname", "Given"], [profile]).kind).toBe("matched");
  });

  it("reports malformed JSON rather than starting with no profiles", () => {
    expect(() => parseProfileJson("{not json")).toThrow(/not valid JSON/);
  });

  it("runs operator profiles through the same validation as built-ins", () => {
    const bad = JSON.stringify({
      vendor: "acme",
      datasets: [{ dataset: "patient", required: ["X"], columns: { nope: "X" } }],
    });
    expect(() => parseProfileJson(bad)).toThrow(/unknown canonical column/);
  });

  it("rejects a non-string header mapping", () => {
    const bad = JSON.stringify({
      vendor: "acme",
      datasets: [{ dataset: "patient", required: ["X"], columns: { patient_id: 7 } }],
    });
    expect(() => parseProfileJson(bad)).toThrow(/non-string header/);
  });
});
