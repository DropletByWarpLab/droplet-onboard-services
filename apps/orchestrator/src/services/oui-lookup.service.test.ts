/**
 * WARP-81: tests for the bundled OUI vendor lookup.
 *
 * The service loads the IEEE OUI registry CSV once at startup into an
 * in-memory Map<6-hex-prefix, vendor> and exposes a single `lookup(mac)`
 * call. Missing or malformed files must degrade gracefully to null —
 * vendor lookup is nice-to-have, not load-bearing.
 */

import { describe, it, expect, vi } from "vitest";
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

  it("missing file degrades to null + logs warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = createOuiLookup("/nonexistent/path/to/oui.csv");
    expect(lookup.lookup("AA:BB:CC:DD:EE:FF")).toBeNull();
    warn.mockRestore();
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
});
