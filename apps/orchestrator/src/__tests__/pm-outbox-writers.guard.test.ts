/** Keeps the transactional outbox wake attached to every PmActivity writer. */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("PmActivity writes wake the generic outbox", () => {
  const writers = sourceFiles(SRC)
    .map((file) => ({ file, text: code(readFileSync(file, "utf8")) }))
    .filter(({ text }) => /\bpmActivity\.(create|createMany)\(/.test(text));

  it("finds the shared PM and relation writers", () => {
    const names = writers.map((writer) => path.basename(writer.file));
    expect(names).toContain("pm.service.ts");
    expect(names).toContain("pm-relations.service.ts");
  });

  it.each(writers.map((writer) => [path.relative(SRC, writer.file).replace(/\\/g, "/"), writer.text] as const))(
    "%s imports nudgeOutbox and wakes after each write site",
    (_name, text) => {
      const writes = text.match(/\bpmActivity\.(create|createMany)\(/g)?.length ?? 0;
      const nudges = text.match(/\bnudgeOutbox\(\)/g)?.length ?? 0;
      expect(text).toMatch(/import \{[^}]*\bnudgeOutbox\b[^}]*\} from "(?:\.\/pm-outbox\.js|\.\.\/pm\/pm-outbox\.js)"/);
      if (_name === "services/pm/pm.service.ts") {
        // Work-item deletion commits one tombstone plus the surviving-end
        // relation audit rows in a single serializable transaction, then wakes
        // once. Ordinary single-row and bulk activity writes each retain
        // their own wake, including the batch helper introduced by WARP-3537.
        expect(writes).toBe(4);
        expect(nudges).toBe(3);
        expect(text).toMatch(/if \(input\.some\(\(entry\) => entry\.nudge !== false\)\) nudgeOutbox\(\)/);
        expect(text).toMatch(/if \(input\.nudge !== false\) nudgeOutbox\(\)/);
        expect(text).toMatch(/\}, \{ \.\.\.SERIALIZABLE_TX, timeout: 5_000 \}\);\s*nudgeOutbox\(\)/);
      } else if (_name === "services/support/escalation.service.ts") {
        expect(nudges).toBe(1);
        expect(text).toMatch(/await writeActivity\(tx,[\s\S]*?nudge: false[\s\S]*?await tx\.pmActivity\.createMany\(/);
        expect(text).toMatch(/\}\);\s*nudgeOutbox\(\);/);
      } else {
        expect(nudges).toBeGreaterThanOrEqual(writes);
      }
    },
  );
});
