import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WARP-3514 — pin the boot wiring (handbook P13: every comment that promises a sweep
 * needs its `scheduleCron`). index.ts is composed at process start and is not
 * importable in a unit test, so this reads it as text.
 */
// vitest runs from apps/orchestrator (the package root), like the other source-reading pins.
const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");

describe("recordings allocator wiring in index.ts (WARP-3514)", () => {
  it.each([
    ["5 * * * *", "droplet:camera-bitrate-sample"],
    ["10 * * * *", "droplet:recordings-allocator"],
    ["* * * * *", "droplet:recordings-migration-poll"],
    ["40 * * * *", "droplet:recordings-health"],
  ])("schedules %s under lockKey %s", (spec, lockKey) => {
    const at = index.indexOf(`lockKey: "${lockKey}"`);
    expect(at, `${lockKey} is not registered`).toBeGreaterThan(-1);
    const block = index.slice(Math.max(0, at - 400), at);
    expect(block).toContain(`"${spec}"`);
    expect(block).toContain("cronRuntime.scheduleCron");
  });

  it("registers the allocator singleton so the routes and the drive-prepared kick can reach it", () => {
    expect(index).toContain("setRecordingsAllocator(recordingsAllocator)");
  });

  it("measures the near-full threshold against the allocation's reservation", () => {
    expect(index).toMatch(/checkStorageNearFull\(\{\s*reservedBytes: await getRecordingsReservedBytes\(prisma\)/);
  });

  it("never schedules with a while-true loop (CLAUDE.md coding standards)", () => {
    const from = index.indexOf("WARP-3514 / ADR-070");
    const to = index.indexOf('lockKey: "droplet:recordings-health"');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const wiring = index.slice(from, to);
    expect(wiring).not.toMatch(/while\s*\(\s*true\s*\)/);
  });
});
