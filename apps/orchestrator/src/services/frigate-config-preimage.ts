/**
 * WARP-3510 — a pre-image of Frigate's authored config before every overwrite.
 *
 * Every Frigate config writer (add, delete, the reconcile prune, a settings
 * save, the retention backfill) can overwrite existing camera fields. When one of
 * them got it wrong — a prune that took a live camera — the previous file
 * existed nowhere else and the camera's stream URL, credentials included, was
 * simply gone (the Camera row stores none of it). The pre-image is the way back.
 *
 * Best-effort BY DESIGN: it is written to an EXISTING data volume if there is
 * one, and a missing or unwritable volume never stops the save it protects. It
 * does not invent a volume — outside a deployed box (dev, CI) it logs at debug
 * and does nothing.
 *
 * Where: `$FRIGATE_CONFIG_PREIMAGE_DIR`, default
 * `/data/migration-snapshots/frigate-config` — a directory on the orchestrator's
 * existing `migration-snapshots` volume (WARP-573, "what the box looked like
 * before it changed"). The newest PREIMAGE_KEEP files are kept.
 */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createLogger } from "../lib/logger.js";

const logger = createLogger("frigate-config-preimage");

/** How many pre-images to keep; the rest are pruned oldest-first. */
export const PREIMAGE_KEEP = 20;

const DEFAULT_DIR = "/data/migration-snapshots/frigate-config";
/** Only files this module wrote are ever pruned. */
const OWN_FILE = /^config-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.yml$/;

function preImageDir(): string {
  return process.env.FRIGATE_CONFIG_PREIMAGE_DIR?.trim() || DEFAULT_DIR;
}

/**
 * Write `yamlText` — the config about to be replaced — to a timestamped file.
 * Returns its path, or null when skipped or failed. Never throws.
 */
export async function writeConfigPreImage(
  yamlText: string,
  now: Date = new Date(),
): Promise<string | null> {
  const dir = preImageDir();
  try {
    // Only an EXISTING data volume is used; a missing one is not ours to make.
    const volume = dirname(dir);
    const onDisk = await stat(volume).catch(() => null);
    if (!onDisk?.isDirectory()) {
      logger.debug({ volume }, "no data volume for Frigate config pre-images; skipping");
      return null;
    }

    await mkdir(dir, { recursive: true });
    const file = join(dir, `config-${now.toISOString().replace(/[:.]/g, "-")}.yml`);
    // 0600: the authored YAML carries camera credentials in its stream URLs.
    await writeFile(file, yamlText, { encoding: "utf8", mode: 0o600 });
    await prune(dir);
    return file;
  } catch (err) {
    logger.warn({ err, dir }, "could not write a pre-image of Frigate's config; saving without one");
    return null;
  }
}

async function prune(dir: string): Promise<void> {
  // Timestamps sort lexicographically, so the oldest are first.
  const ours = (await readdir(dir)).filter((f) => OWN_FILE.test(f)).sort();
  for (const stale of ours.slice(0, Math.max(0, ours.length - PREIMAGE_KEEP))) {
    await rm(join(dir, stale), { force: true });
  }
}
