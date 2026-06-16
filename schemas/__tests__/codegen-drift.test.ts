import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("anchor schema codegen drift", () => {
  it("regenerated Pydantic + Zod outputs match checked-in files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "anchor-codegen-"));
    try {
      execSync(`node scripts/gen-anchor-schema.mjs --out-dir ${tmp}`, {
        stdio: "pipe",
      });
      const regenPy = readFileSync(join(tmp, "anchor_schema.py"), "utf-8");
      const regenTs = readFileSync(join(tmp, "anchor.ts"), "utf-8");
      const checkedPy = readFileSync("services/file-indexer/anchor_schema.py", "utf-8");
      const checkedTs = readFileSync("packages/shared-types/src/anchor.ts", "utf-8");
      expect(regenPy).toBe(checkedPy);
      expect(regenTs).toBe(checkedTs);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
