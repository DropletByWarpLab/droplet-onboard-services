/**
 * WARP-3527 — the pure parts of the import job service: what a mapping may
 * refer to, and what a stored file name may look like. The lifecycle (guarded
 * transitions, the one-active-job index) is proven against a real database in
 * `__tests__/pm-import-export.pg.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { cleanFileName, validateMapping } from "./pm-import.service.js";
import { exportCsvChunks, htmlToText } from "./pm-export.service.js";
import type { PlanContext } from "./import/plan.js";

const ctx: PlanContext = {
  states: [{ id: "s1", name: "Todo", group: "unstarted", isDefault: true, sortOrder: 0 }],
  labels: [],
  users: [
    { id: "u-ok", displayName: "Dana", username: "dana", email: null, eligible: true },
    { id: "u-guest", displayName: "Pat", username: "pat", email: null, eligible: false, ineligibleReason: "guest" },
  ],
};

describe("validateMapping", () => {
  it("accepts a mapping that names real columns, states and members", () => {
    expect(
      validateMapping(
        {
          columns: { name: ["Title"], labels: ["Labels", "Tags"] },
          statuses: { done: { kind: "state", stateId: "s1" }, review: { kind: "create", name: "In Review", group: "started" }, x: { kind: "default" } },
          people: { dana: "u-ok", nobody: null },
        },
        ["Title", "Labels", "Tags"],
        ctx,
      ),
    ).toEqual([]);
  });

  it("names every problem in words instead of stopping at the first", () => {
    const problems = validateMapping(
      {
        columns: { name: ["Missing"], status: ["Also missing"] },
        statuses: { a: { kind: "state", stateId: "elsewhere" }, b: { kind: "create", name: "   ", group: "started" } },
        people: { c: "u-guest", d: "u-nobody" },
      },
      ["Title"],
      ctx,
    );
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).toMatch(/no column named "Missing"/);
    expect(problems.join("\n")).toMatch(/state chosen for "a" isn't in this project/);
    expect(problems.join("\n")).toMatch(/new state for "b" needs a name/);
    expect(problems.join("\n")).toMatch(/"c" can only be assigned to an active member/);
  });

  it("an empty mapping is valid (it means: the preset)", () => {
    expect(validateMapping({}, [], ctx)).toEqual([]);
  });
});

describe("cleanFileName", () => {
  it("keeps the name, drops any path, control characters and excess length", () => {
    expect(cleanFileName("jira export.csv")).toBe("jira export.csv");
    expect(cleanFileName("C:\\Users\\me\\Desktop\\board.json")).toBe("board.json");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("bad" + String.fromCharCode(0, 7, 13, 10) + "name.csv")).toBe("badname.csv");
    expect(cleanFileName("a".repeat(500) + ".csv")).toHaveLength(200);
    expect(cleanFileName("   ")).toBe("import");
    expect(cleanFileName("")).toBe("import");
    expect(cleanFileName("dossier-été.csv")).toBe("dossier-été.csv");
  });
});

describe("htmlToText (the CSV description column)", () => {
  it("turns stored paragraph HTML into readable text", () => {
    expect(htmlToText("<p>One &amp; two</p><p>Three<br>four</p>")).toBe("One & two\n\nThree\nfour");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
    expect(htmlToText('<p>say &quot;hi&quot; &lt;b&gt;</p>')).toBe('say "hi" <b>');
    expect(htmlToText(null)).toBe("");
    expect(htmlToText("")).toBe("");
  });
});

describe("exportCsvChunks needs a project that exists", () => {
  it("fails before writing anything for an unknown project", async () => {
    const prisma = { pmProject: { findUnique: async () => null } };
    const g = exportCsvChunks(prisma as never, "nope");
    await expect(g.next()).rejects.toThrow("project_not_found");
  });
});
