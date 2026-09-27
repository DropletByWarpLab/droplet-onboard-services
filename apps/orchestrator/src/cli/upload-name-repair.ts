/**
 * WARP-3057 — the planning half of `scripts/repair-upload-names.sh`.
 *
 * Reads NUL-separated Nextcloud data paths (`user/files/…/name`) on stdin
 * and writes NUL-separated `from`,`to` pairs on stdout for every file whose
 * name repairs cleanly (see `repairLatin1Mojibake`). A repaired name that is
 * already taken goes to stderr as skipped. It touches nothing; the script
 * does the renames through `occ files:move`.
 */
import { planMojibakeRenames } from "../lib/upload-file-name.js";

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const paths = Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean);

  const { renames, skipped } = planMojibakeRenames(paths);
  for (const { from, to } of skipped) {
    process.stderr.write(`skipped, the repaired name is taken: ${from} -> ${to}\n`);
  }
  process.stdout.write(renames.map(({ from, to }) => `${from}\0${to}\0`).join(""));
}

void main();
