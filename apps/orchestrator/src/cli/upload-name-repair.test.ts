import { describe, it, expect } from "vitest";
import { renderRepairPlan } from "./upload-name-repair.js";

// What the pre-fix parser stored: the UTF-8 bytes read back as latin1.
const garble = (s: string) => Buffer.from(s, "utf8").toString("latin1");

// Pins the NUL protocol scripts/repair-upload-names.sh speaks: `f`/`d`-prefixed
// paths in, `from\0to\0` pairs out, skips on stderr.
describe("renderRepairPlan (WARP-3057)", () => {
  it("emits from/to pairs for files only, and skips a target that is a directory", () => {
    const input = [
      "dalice/files",
      "dalice/files/Café",
      `falice/files/${garble("Café")}`,
      `falice/files/${garble("Ω.txt")}`,
      "falice/files/ok.txt",
      `dalice/files/${garble("Ωdir")}`,
    ]
      .map((e) => `${e}\0`)
      .join("");
    const { stdout, stderr } = renderRepairPlan(input);
    expect(stdout).toBe(`alice/files/${garble("Ω.txt")}\0alice/files/Ω.txt\0`);
    expect(stderr).toBe(`skipped, the repaired name is taken: alice/files/${garble("Café")} -> alice/files/Café\n`);
  });

  it("empty input plans nothing", () => {
    expect(renderRepairPlan("")).toEqual({ stdout: "", stderr: "" });
  });
});
