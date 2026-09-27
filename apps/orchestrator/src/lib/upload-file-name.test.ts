import { describe, it, expect } from "vitest";
import { planMojibakeRenames, repairLatin1Mojibake, storedUploadName } from "./upload-file-name.js";

// What the pre-fix parser stored: the UTF-8 bytes read back as latin1.
const garble = (s: string) => Buffer.from(s, "utf8").toString("latin1");

describe("repairLatin1Mojibake (WARP-3057)", () => {
  it.each(["Screenshot 9.41.12 AM.png", "Café Ω.pdf", "会议纪要.docx", "plan 🚀.pdf"])(
    "restores %s",
    (name) => {
      expect(repairLatin1Mojibake(garble(name))).toBe(name);
    },
  );

  it.each([
    ["plain ASCII", "report.pdf"],
    ["a genuine latin1 name (0xE9 alone is not UTF-8)", "Café.pdf"],
    ["a correct UTF-8 name above U+00FF", "Ω.pdf"],
    ["a correct name mixing U+00E9 and U+03A9", "Café Ω.pdf"],
  ])("leaves %s alone", (_label, name) => {
    expect(repairLatin1Mojibake(name)).toBeNull();
  });
});

describe("planMojibakeRenames", () => {
  it("renames only clean round trips and never onto a taken name", () => {
    const plan = planMojibakeRenames([
      `alice/files/${garble("Café.pdf")}`,
      `alice/files/docs/${garble("Ω.txt")}`,
      "alice/files/docs/Ω.txt",
      "alice/files/ok.txt",
    ]);
    expect(plan.renames).toEqual([{ from: `alice/files/${garble("Café.pdf")}`, to: "alice/files/Café.pdf" }]);
    expect(plan.skipped).toEqual([{ from: `alice/files/docs/${garble("Ω.txt")}`, to: "alice/files/docs/Ω.txt" }]);
  });
});

describe("storedUploadName", () => {
  it("keeps a backslash as a character, stored as _", () => {
    expect(storedUploadName("a\\b.txt")).toBe("a_b.txt");
  });
  it.each(["../x", "..\\x", "a/b", "..", ".", "", "a\0b"])("refuses %j", (name) => {
    expect(storedUploadName(name)).toBeNull();
  });
});
