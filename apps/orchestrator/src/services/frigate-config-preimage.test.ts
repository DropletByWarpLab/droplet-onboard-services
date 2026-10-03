/**
 * WARP-3510 — a pre-image of Frigate's authored config before every overwrite.
 *
 * Every config writer saves the WHOLE authored YAML back, so a bug in what it
 * removed (a prune that took a live camera, a settings save that dropped a
 * key) used to be unrecoverable: the previous file existed nowhere else. The
 * pre-image is the way back. It is best-effort by design — it lives on an
 * existing data volume if there is one, and a missing or unwritable volume
 * must never stop the save it is protecting.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PREIMAGE_KEEP, writeConfigPreImage } from "./frigate-config-preimage.js";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "frigate-preimage-unit-"));
  dir = join(root, "frigate-config");
  process.env.FRIGATE_CONFIG_PREIMAGE_DIR = dir;
});
afterEach(() => {
  delete process.env.FRIGATE_CONFIG_PREIMAGE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("writeConfigPreImage", () => {
  it("writes the YAML under a timestamped name and returns where", async () => {
    const at = new Date("2026-10-03T20:13:58.123Z");

    const file = await writeConfigPreImage("cameras: {}\n", at);

    expect(file).toBe(join(dir, "config-2026-10-03T20-13-58-123Z.yml"));
    expect(readFileSync(file!, "utf8")).toBe("cameras: {}\n");
  });

  it("is skipped, quietly, when the data volume is not there — and invents none", async () => {
    process.env.FRIGATE_CONFIG_PREIMAGE_DIR = join(root, "missing-volume", "frigate-config");

    const file = await writeConfigPreImage("cameras: {}\n");

    expect(file).toBeNull();
    expect(existsSync(join(root, "missing-volume"))).toBe(false);
  });

  it("never throws when it cannot write", async () => {
    writeFileSync(dir, "a file where the directory should be");

    await expect(writeConfigPreImage("cameras: {}\n")).resolves.toBeNull();
  });

  it(`keeps only the newest ${PREIMAGE_KEEP}, so the volume cannot fill`, async () => {
    mkdirSync(dir);
    const total = PREIMAGE_KEEP + 3;
    for (let i = 0; i < total; i++) {
      await writeConfigPreImage(`# save ${i}\n`, new Date(Date.UTC(2026, 9, 3, 0, 0, i)));
    }

    const kept = readdirSync(dir).sort();

    expect(kept).toHaveLength(PREIMAGE_KEEP);
    // The oldest three are the ones that went.
    expect(kept[0]).toBe("config-2026-10-03T00-00-03-000Z.yml");
    expect(kept[kept.length - 1]).toBe(`config-2026-10-03T00-00-${String(total - 1).padStart(2, "0")}-000Z.yml`);
  });

  it("leaves files it did not write alone when pruning", async () => {
    mkdirSync(dir);
    writeFileSync(join(dir, "README.txt"), "keep me");
    for (let i = 0; i < PREIMAGE_KEEP + 2; i++) {
      await writeConfigPreImage("x\n", new Date(Date.UTC(2026, 9, 3, 0, 0, i)));
    }

    expect(readdirSync(dir)).toContain("README.txt");
  });
});
