/**
 * WARP-81: tests for the bundled OUI vendor lookup.
 *
 * The service loads the IEEE OUI registry CSV once at startup into an
 * in-memory Map<6-hex-prefix, vendor> and exposes a single `lookup(mac)`
 * call. Missing or malformed files must degrade gracefully to null —
 * vendor lookup is nice-to-have, not load-bearing.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOuiLookup } from "./oui-lookup.service.js";

function withCsv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oui-"));
  const csv = join(dir, "oui.csv");
  writeFileSync(csv, contents);
  return csv;
}

describe("oui-lookup.service", () => {
  it("resolves a known prefix to vendor", () => {
    const csv = withCsv(
      "Registry,Assignment,Organization Name,Organization Address\n" +
        "MA-L,F81EDF,Apple Inc,1 Infinite Loop\n"
    );
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("F8:1E:DF:AA:BB:CC")).toBe("Apple Inc");
  });

  it("accepts lowercase and separator-free MAC inputs", () => {
    const csv = withCsv(
      "Registry,Assignment,Organization Name,Organization Address\n" +
        "MA-L,F81EDF,Apple Inc,1 Infinite Loop\n"
    );
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("f8:1e:df:aa:bb:cc")).toBe("Apple Inc");
    expect(lookup.lookup("f81edfaabbcc")).toBe("Apple Inc");
    expect(lookup.lookup("f8-1e-df-aa-bb-cc")).toBe("Apple Inc");
  });

  it("returns null for an unknown prefix", () => {
    const csv = withCsv(
      "Registry,Assignment,Organization Name,Organization Address\n"
    );
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("AA:BB:CC:DD:EE:FF")).toBeNull();
  });

  it("missing file degrades to null (no throw)", () => {
    const lookup = createOuiLookup("/nonexistent/path/to/oui.csv");
    expect(lookup.lookup("AA:BB:CC:DD:EE:FF")).toBeNull();
  });

  it("malformed rows are skipped without crashing", () => {
    const csv = withCsv(
      "Registry,Assignment,Organization Name,Organization Address\n" +
        "MA-L,F81EDF,Apple\n" +
        "short row\n" +
        "\n" +
        "MA-L,001122,Acme,somewhere\n"
    );
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("00:11:22:33:44:55")).toBe("Acme");
    expect(lookup.lookup("F8:1E:DF:AA:BB:CC")).toBe("Apple");
  });

  it("handles quoted vendor names with commas", () => {
    const csv = withCsv(
      "Registry,Assignment,Organization Name,Organization Address\n" +
        'MA-L,0040C7,"Cisco Systems, Inc",\n' +
        'MA-L,FCB6D8,"Apple, Inc.",'
    );
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("00:40:C7:11:22:33")).toBe("Cisco Systems, Inc");
    expect(lookup.lookup("FC:B6:D8:00:00:00")).toBe("Apple, Inc.");
  });

  it("unescapes doubled quotes inside quoted vendor names", () => {
    const csv = withCsv(
      "Registry,Assignment,Organization Name,Organization Address\n" +
        'MA-L,112233,"Ring ""Doorbell"" Co",'
    );
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("11:22:33:44:55:66")).toBe('Ring "Doorbell" Co');
  });
});
