// WARP-2909 — a notification deep-links to `/workshop?run=<id>`; approving from
// there is redeemed ONLY by POST /api/agent-runs/:id/confirm. Pin that the one
// dashboard source line touching that route is `decideAgentRun`, so no
// notification surface grows its own approve shortcut. Scoped to
// `/api/agent-runs/` + `/confirm` — other `/confirm` routes (storage, network,
// cameras, ERP write-requests) exist and are unrelated.
//
// Moved here from workshop.agent-runs-panel.test.tsx when WARP-2974 replaced
// the runs panel with the Workshop space (that file went with the panel);
// relative paths are normalised to `/` so the pin also holds on Windows.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

describe("agent-run confirm has exactly one caller (WARP-2909)", () => {
  it("only decideAgentRun fetches /api/agent-runs/…/confirm", () => {
    const src = path.resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "node_modules") walk(p);
        } else if (/\.(ts|tsx|js)$/.test(e.name)) {
          readFileSync(p, "utf-8")
            .split("\n")
            .forEach((line, i) => {
              if (line.includes("/api/agent-runs/") && line.includes("/confirm")) {
                hits.push(`${path.relative(src, p).split(path.sep).join("/")}:${i + 1}`);
              }
            });
        }
      }
    };
    walk(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^components\/workshop\/agent-runs\/api\.ts:/);
    const apiSrc = readFileSync(path.join(src, "components/workshop/agent-runs/api.ts"), "utf-8");
    expect(apiSrc).toMatch(
      /export async function decideAgentRun[\s\S]{0,200}\/api\/agent-runs\/\$\{encodeURIComponent\(id\)\}\/confirm/,
    );
  });
});
